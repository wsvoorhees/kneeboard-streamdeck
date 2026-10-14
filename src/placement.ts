/**
 * Placement nudges and the bookkeeping `Reset position` needs.
 *
 * Pure by design: the standalone test suite runs this on Linux, while the C API DLL it ultimately feeds
 * only loads on Windows.
 */

import { AXES, NUDGE_AXES, isRotation, type Axis, type Nudge, type NudgeAxis } from "./protocol.ts";

/**
 * The positional index → axis map. The cross still uses its translation entries; the first two
 * physical dials can assign opacity and size separately.
 */
export const DIAL_AXES: readonly Axis[] = AXES;

export type StepMode = "coarse" | "fine";

const degrees = (d: number): number => (d * Math.PI) / 180;

/**
 * Coarse gets you to roughly the right place, fine makes it right. The fine rotation step is 0.5°
 * because at arm's length that is about a millimetre of apparent movement — below that the dial
 * detent is finer than the headset can show you.
 */
export const STEPS: Record<StepMode, { translation: number; rotation: number; size: number }> = {
  fine: { translation: 0.001, rotation: degrees(0.5), size: 0.01 },
  coarse: { translation: 0.01, rotation: degrees(5), size: 0.05 },
};

/** OpenKneeboard's IndependentViewVRSettings defaults, in metres. */
export const DEFAULT_VIEW_SIZE = { Width: 0.15, Height: 0.25 } as const;
export const MIN_VIEW_SIZE = Math.fround(0.01);
export interface PhysicalSize { Width: number; Height: number }

export function validSize(value: unknown): value is PhysicalSize {
  const size = value as Partial<PhysicalSize> | undefined;
  // The C++ minimum is a float: its JSON value can be just below 0.01 after rounding.
  return !!size && typeof size.Width === "number" && Number.isFinite(size.Width) && size.Width > 0 &&
    typeof size.Height === "number" && Number.isFinite(size.Height) && size.Height > 0;
}

/**
 * One tenth of the range per press: ten presses covers 0 to 1, which is few enough to reach an end
 * deliberately and many enough to stop where you meant to. It matches `mBrightnessStep`, the step
 * OpenKneeboard's own brightness control uses.
 *
 * It lives HERE and not in `runtime/actions.ts` because this module is pure. The runtime imports
 * koffi and @elgato/streamdeck, which this workspace does not install and tsconfig excludes — and
 * an excluded file reached from an included one is still typechecked, so a constant imported out of
 * the runtime breaks `pnpm typecheck` for the whole repo.
 */
export const OPACITY_STEP = 0.1;

export function stepFor(axis: Axis, mode: StepMode): number {
  const step = STEPS[mode];
  return isRotation(axis) ? step.rotation : step.translation;
}

export function axisForDial(index: number): Axis | undefined {
  return DIAL_AXES[index];
}

export interface PlacementState {
  /**
   * Which view the dials move: the `Kneeboard` index, 1-based, 0 meaning whichever is active.
   *
   * With more than one panel — a deck map and a wheel reference in their own places — "move the
   * kneeboard" is ambiguous, and the dials have to be told which one. The accumulator is per view
   * for the same reason: resetting after adjusting two panels must not push one of them by the
   * other's offset.
   */
  readonly target: number;
  /** Everything sent since the page was entered, per view then per axis. The ONLY reference
   * `reset` has, and the reason it is keyed by view. */
  readonly accumulated: Readonly<Record<number, Readonly<Partial<Record<NudgeAxis, number>>>>>;
}

const zeroed = (): Record<NudgeAxis, number> =>
  Object.fromEntries(NUDGE_AXES.map((axis) => [axis, 0])) as Record<NudgeAxis, number>;

/** Coarse first: you reach for the dials because the panel is in the wrong place, not slightly off.
 * Target 1 because view 1 is the deck map, the panel you are nearly always adjusting. */
export const createPlacement = (target = 1): PlacementState => ({
  target,
  accumulated: {},
});

/** Point the dials at a different view. The accumulator is untouched: each view keeps its own, so
 * switching target and switching back does not lose the offsets already applied. */
export const setTarget = (state: PlacementState, target: number): PlacementState => ({
  ...state,
  target,
});

const forTarget = (state: PlacementState, target: number): Readonly<Partial<Record<NudgeAxis, number>>> =>
  state.accumulated[target] ?? zeroed();

/**
 * One dial tick (or several, since the hardware coalesces fast turns into a single event carrying a
 * tick count) becomes one relative nudge.
 *
 * A dial with no axis — an index past the six, which the Stream Deck + XL cannot produce but a
 * misconfigured profile can — yields no packet rather than silently driving X.
 */
export function rotate(
  state: PlacementState,
  dialIndex: number,
  ticks: number,
): { nudge: Nudge; state: PlacementState } {
  const axis = axisForDial(dialIndex);
  if (!axis || ticks === 0) return { nudge: {}, state };

  const delta = ticks * stepFor(axis, "fine");
  const current = forTarget(state, state.target);
  return {
    nudge: { [axis]: delta },
    state: {
      ...state,
      accumulated: {
        ...state.accumulated,
        [state.target]: { ...current, [axis]: (current[axis] ?? 0) + delta },
      },
    },
  };
}

/** Scale both constraints by the same fraction of the captured baseline. Keeping their ratio
 * constant makes ScaledToFit change the apparent panel size without changing its aspect ratio. */
export function resize(state: PlacementState, ticks: number, base: PhysicalSize): { nudge: Nudge; state: PlacementState } {
  if (!Number.isFinite(ticks) || ticks === 0 || !validSize(base)) return { nudge: {}, state };
  const current = forTarget(state, state.target);
  const floor = Math.max(
    (MIN_VIEW_SIZE - base.Width - (current.MaxWidth ?? 0)) / base.Width,
    (MIN_VIEW_SIZE - base.Height - (current.MaxHeight ?? 0)) / base.Height,
  );
  const fraction = Math.max(ticks * STEPS.fine.size, floor);
  if (fraction === 0) return { nudge: {}, state };
  const MaxWidth = base.Width * fraction;
  const MaxHeight = base.Height * fraction;
  return {
    nudge: { MaxWidth, MaxHeight },
    state: { ...state, accumulated: {
      ...state.accumulated,
      [state.target]: { ...current, MaxWidth: (current.MaxWidth ?? 0) + MaxWidth,
        MaxHeight: (current.MaxHeight ?? 0) + MaxHeight },
    } },
  };
}

/**
 * `NudgeVRView` is relative-only by the maintainer's design, so reset cannot restore a saved
 * default — it can only undo what THIS session sent. Send the inverse of the accumulator and zero
 * it.
 *
 * The honest limit: if the plugin restarts mid-adjustment the reference is gone and reset becomes a
 * no-op rather than a restore. That is a property of the upstream API, not a bug to fix here.
 */
export function resetDelta(state: PlacementState): { nudge: Nudge; state: PlacementState } {
  const nudge: Nudge = {};
  const current = forTarget(state, state.target);
  for (const axis of NUDGE_AXES) {
    const moved = current[axis] ?? 0;
    if (moved !== 0) nudge[axis] = -moved;
  }
  // Only the TARGET view is forgotten. Reset means "undo what I just did to this panel", not
  // "undo everything I have done to every panel".
  const accumulated = { ...state.accumulated };
  delete accumulated[state.target];
  return { nudge, state: { ...state, accumulated } };
}
