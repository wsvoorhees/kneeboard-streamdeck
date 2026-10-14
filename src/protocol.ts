/**
 * What the plugin says to OpenKneeboard: a message name and a value, nothing more.
 *
 * OpenKneeboard's C API takes exactly that pair (`OpenKneeboard_send_utf8(name, value)`), and its DLL
 * owns the wire format. Recentering is:
 *
 *     { name: "RemoteUserAction", value: "RECENTER_VR" }
 *
 * The plugin used to frame packets itself (`{nameLen:08x}!{name}!{valueLen:08x}!{value}!`) and write
 * them to OpenKneeboard's mailslot. Upstream treats that mailslot as an unsupported internal that
 * changes between releases, so the framing now lives only in the DLL (`runtime/capi.ts`).
 *
 * This module is deliberately pure — no transport, no koffi, no Stream Deck. That is what lets the
 * standalone test suite cover it on Linux while the DLL only ever loads on Windows.
 */

/** Message names, verbatim from `APIEvent.hpp`. */
export const EVT = {
  remoteUserAction: "RemoteUserAction",
  setTabByName: "SetTabByName",
  setTabByIndex: "SetTabByIndex",
  setProfileByName: "SetProfileByName",
  /**
   * Merged upstream in OpenKneeboard PR #937. Release 1.12.10 predates it, so that build
   * ignores the message; newer builds act on it.
   */
  nudgeVrView: "NudgeVRView",
  /**
   * Proposed upstream in PR #939, alongside `ShowVRView` and `HideVRView`. Release 1.12.10 can only
   * hide every view at once (`HIDE` sets one bool on the renderer), which makes a second panel
   * useless: it would be permanently in your vision or not there at all.
   *
   * Earlier versions of #939 called this `ToggleViewVisibility`, and before that
   * `SetViewVisibility`; builds of either ignore this name, and builds with this name ignore both.
   */
  toggleVrViewVisibility: "ToggleVRViewVisibility",
  /**
   * Proposed upstream in PR #940: per-view opacity already
   * reached the renderer (`VRKneeboard::GetRenderParameters` multiplies it into the tint) and was
   * only reachable from the settings GUI. `SetBrightness` is NOT this — it drives the global UI
   * tint, which is RGB rather than alpha and applies to every view at once.
   *
   * Earlier versions of #940 called this `SetViewOpacity`; builds of those ignore this name.
   */
  setVrViewOpacity: "SetVRViewOpacity",
} as const;

export type EventName = (typeof EVT)[keyof typeof EVT];

export interface Message {
  name: EventName;
  /** Plain text or JSON, depending on the message. Encoded to UTF-8 bytes at the transport. */
  value: string;
}

const message = (name: EventName, value: string): Message => ({ name, value });

/** Recenter the VR view. Note this is NOT reposition: it keeps yaw only and re-applies the
 * configured offset from the new origin (`VRKneeboard::Recenter`). */
export function recenterVr(): Message {
  return message(EVT.remoteUserAction, "RECENTER_VR");
}

/**
 * Switch the active tab by title. Tab switching matches by TITLE, which is why the OpenKneeboard
 * tabs are named for the games (`AMS2`, `LMU`, …) rather than left at their defaults.
 *
 * `SetTabByNameEvent` uses OPENKNEEBOARD_DECLARE_JSON (not the sparse variant), so every field is
 * written explicitly rather than relying on defaults being filled in on the read side.
 */
export function setTabByName(name: string, page = 0, kneeboard = 0): Message {
  return message(
    EVT.setTabByName,
    JSON.stringify({ Name: name, PageNumber: page, Kneeboard: kneeboard }),
  );
}

/** The six degrees of freedom `NudgeVRView` moves. Translations are meters, rotations radians,
 * right-handed, negative Z in front of you. */
export const AXES = ["X", "EyeY", "Z", "RX", "RY", "RZ"] as const;
export type Axis = (typeof AXES)[number];
export const SIZE_AXES = ["MaxWidth", "MaxHeight"] as const;
export type SizeAxis = (typeof SIZE_AXES)[number];
export const NUDGE_AXES = [...AXES, ...SIZE_AXES] as const;
export type NudgeAxis = (typeof NUDGE_AXES)[number];

export const isRotation = (axis: Axis): boolean => axis.startsWith("R");

export type Nudge = Partial<Record<NudgeAxis, number>>;

/**
 * Nudge the view by a RELATIVE amount. Every field is additive and every omitted field is left
 * unchanged, so a single-axis nudge sends a single key — which is also why there is no absolute
 * form and no "restore default" (see `resetDelta` in ./placement.ts).
 *
 * An axis carrying 0 is dropped: the message would be a no-op, and sending one per idle tick would
 * put pointless traffic on a one-way channel we cannot read back.
 */
export function nudgeVrView(delta: Nudge, kneeboard = 0): Message {
  const payload: Record<string, number> = { Kneeboard: kneeboard };
  for (const axis of NUDGE_AXES) {
    const value = delta[axis];
    if (value !== undefined && value !== 0) payload[axis] = value;
  }
  return message(EVT.nudgeVrView, JSON.stringify(payload));
}

/** True when a nudge would move nothing, so the caller can skip the write entirely. */
export function isEmptyNudge(delta: Nudge): boolean {
  return NUDGE_AXES.every((axis) => (delta[axis] ?? 0) === 0);
}

/**
 * Switch OpenKneeboard to a named profile.
 *
 * A profile carries the tab list AND the panel placement, so this is how the overlay follows the
 * game: the deck's per-game Stream Deck profile asserts the matching OpenKneeboard one. Matching is
 * by `Profile::mName`, exactly, which is why a setup can name them after games or other activities.
 *
 * `SetProfileByNameEvent` uses OPENKNEEBOARD_DEFINE_JSON rather than the sparse variant, so the
 * single field is always written.
 *
 * Two silent failures worth knowing about, neither visible from this side: an unknown name is
 * logged and ignored, and a profile list with `Enabled: false` has the switch UNDONE downstream
 * rather than refused (`KneeboardState.cpp:746`). Set profiles up in OpenKneeboard before assigning this action.
 */
export function setProfileByName(name: string): Message {
  return message(EVT.setProfileByName, JSON.stringify({ Name: name }));
}

/**
 * A profile asserter: sends `SetProfileByName`, at most once per actual change.
 *
 * The de-duplication is not tidiness. A profile switch that lands rebuilds every tab in the
 * profile, and even a REDUNDANT one costs a `Profiles.json` write before OpenKneeboard's own
 * same-profile early return (`KneeboardState.cpp:749`). `onWillAppear` fires on every page change
 * and device reconnect, so without this the deck would write that file constantly.
 *
 * A switch is remembered only when it was sent AND OpenKneeboard was running to receive it, so an
 * assert that went nowhere is retried by the next one. The `running` check exists because the C API
 * cannot say: `OpenKneeboard_send_utf8` returns void, and a send to a closed OpenKneeboard looks like
 * one that landed. Stream Deck starts at login, before OpenKneeboard, so without the check the first
 * page's profile would be remembered unsent and every later page naming it dropped as redundant.
 *
 * The check fails safe: if it is wrong or errors and says "not running", the cost is a redundant
 * switch, never a stuck overlay.
 *
 * The honest limit: this tracks what was SENT, not what OpenKneeboard is on. Change the profile in
 * its own GUI and the next assert is dropped as redundant, because the channel is one-way and there
 * is nothing to read back. Pressing a Show View or profile key re-asserts it (`select`).
 *
 * Built as a factory over `send` and `running` so the policy is testable on Linux, where the DLL
 * cannot load.
 */
export function createProfileAsserter(
  send: (message: Message) => boolean,
  running: () => boolean,
): {
  assert: (name: string) => boolean;
  select: (name: string) => boolean;
  forget: () => void;
} {
  let last: string | undefined;
  const select = (name: string): boolean => {
    const ok = send(setProfileByName(name));
    // Remember only a switch OpenKneeboard was there to receive; otherwise the next assert retries.
    last = ok && running() ? name : undefined;
    return ok;
  };
  return {
    assert(name: string): boolean {
      if (name === last) return true;
      return select(name);
    },
    // A deliberate button press must reach OpenKneeboard even if the last automatic assertion
    // named the same profile: the user may have switched profiles in OpenKneeboard's own UI.
    select,
    forget(): void {
      last = undefined;
    },
  };
}

/**
 * Point a view at a tab. The same `Kneeboard` index `NudgeVRView` uses, so one view can hold the
 * deck map while another holds the wheel reference.
 */
export function setTabByNameOnView(name: string, kneeboard: number, page = 0): Message {
  return message(
    EVT.setTabByName,
    JSON.stringify({ Name: name, PageNumber: page, Kneeboard: kneeboard }),
  );
}

/**
 * Fade ONE view up or down.
 *
 * `delta` is relative for the same reason `nudgeVrView` is: the channel is one-way, so a deck key
 * cannot read the current value and work out an absolute one. OpenKneeboard clamps to 0..1, so a
 * key can be leaned on at either end without the value running away.
 *
 * A view has two opacities — looking at it and not — and this moves BOTH together (`Target:
 * "Both"`), because "how transparent is that panel" is one number to the person pressing the key.
 * Set them apart in OpenKneeboard's settings if you want the gaze effect; a shared step preserves
 * the gap.
 *
 * Every field is sent: the reviewed message has no optional fields.
 */
export function setVrViewOpacity(kneeboard: number, delta: number): Message {
  return message(
    EVT.setVrViewOpacity,
    JSON.stringify({ Kneeboard: kneeboard, Action: "Add", Target: "Both", Value: delta }),
  );
}

/** An absolute opacity, for a preset rather than a nudge. */
export function setVrViewOpacityAbsolute(kneeboard: number, opacity: number): Message {
  return message(
    EVT.setVrViewOpacity,
    JSON.stringify({ Kneeboard: kneeboard, Action: "Set", Target: "Both", Value: clampOpacity(opacity) }),
  );
}

/** Mirrors OpenKneeboard's own clamp, so a bad value never leaves the plugin. */
export const clampOpacity = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * Toggle ONE view in VR.
 *
 * Toggle is the case a deck key actually needs: the channel is one-way, so the plugin cannot read
 * back whether a panel is currently up and cannot decide between showing and hiding for itself.
 *
 * `kneeboard` must be 1 or more: OpenKneeboard ignores a toggle of 0 ("the active view"), because
 * the active view is always visible. If every view is hidden, a toggle shows all of them.
 */
export function toggleVrViewVisibility(kneeboard: number): Message {
  return message(EVT.toggleVrViewVisibility, JSON.stringify({ Kneeboard: kneeboard }));
}
