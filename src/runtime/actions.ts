import {
  action,
  SingletonAction,
  streamDeck,
  type DialDownEvent,
  type DialRotateEvent,
  type KeyDownEvent,
  type WillAppearEvent,
} from "@elgato/streamdeck";

import { placementFeedback, placementFeedbackForAxis } from "../feedback.ts";
import { DEFAULT_VIEW_SIZE, OPACITY_STEP, resetDelta, resize, rotate, setTarget,
  validSize } from "../placement.ts";
import { recenterVr } from "../protocol.ts";
import {
  getPlacement,
  toggleView,
  showTabOnView,
  send,
  sendNudge,
  setPlacement,
  fadeView,
  selectProfile,
  pageAppeared,
} from "./session.ts";

const UUID = "com.willvoorhees.openkneeboard-configurator";

export type OverlayControlSettings = {
  /** Which view holds the wheel reference; short press toggles its visibility. */
  wheelView?: number;
  /** Tab titles, which SetTabByName matches exactly. */
  deckTab?: string;
  wheelTab?: string;
  /**
   * The OpenKneeboard profile this deck profile belongs with, asserted when the key appears.
   *
   * This is what makes the overlay follow the game: an OpenKneeboard profile carries both the tab
   * list and the panel placement, so switching it is how the right deck map appears in the right
   * place. Unset, the key does nothing on appear — a deck profile with no overlay counterpart.
   */
  kneeboardProfile?: string;
};

/**
 * (1,0) on the keypad — the one position verified bound in zero of six games.
 *
 * Press toggles the wheel reference. Native Go to Page on the former warp placeholder enters
 * placement; plugin profile switching cannot address imported user profiles.
 */
@action({ UUID: `${UUID}.overlay-control` })
export class OverlayControl extends SingletonAction<OverlayControlSettings> {
  #showWheel(settings: OverlayControlSettings): void {
    // Assign the wheel tab before showing the separate panel. Visibility is toggled by
    // OpenKneeboard, whose state the one-way channel cannot read back.
    if (settings.wheelTab) showTabOnView(settings.wheelTab, settings.wheelView ?? 2);
    toggleView(settings.wheelView ?? 2);
  }

  /**
   * Report this game's deck page — its deck map and its OpenKneeboard profile — to the page
   * coordinator whenever this key becomes visible.
   *
   * `onWillAppear` is the only signal the plugin gets that a deck profile has been switched to —
   * Stream Deck has no "profile activated" event — and this key is emitted into every game's
   * profile, so it is the one that always fires. It also covers the deck reconnecting and the
   * plugin restarting. The same key sits on the placement page; there the coordinator sees the
   * placement controls in the same batch and shows the placement reference instead.
   *
   * What it does NOT cover: OpenKneeboard being started while the deck is already sitting on a
   * game. Nothing appears at that moment, so nothing re-asserts, and the channel is one-way so the
   * plugin cannot notice it came up. The overlay stays on whatever profile it loaded until the deck
   * profile or page changes. `onKeyDown` re-asserts for that reason — pressing the key you would
   * reach for anyway is the cheapest resync available.
   */
  override async onWillAppear(ev: WillAppearEvent<OverlayControlSettings>): Promise<void> {
    const settings = ev.payload.settings ?? {};
    pageAppeared(ev.action.device.id, { page: "deck", deckTab: settings.deckTab ?? "", profile: settings.kneeboardProfile });
    if (ev.action.isDial()) await ev.action.setTitle("Reference");
  }

  override onKeyDown(ev: KeyDownEvent<OverlayControlSettings>): void {
    // Re-assert before acting. If OpenKneeboard started after the deck was already on this game,
    // this is the first moment the plugin can put it on the right profile — and the press is about
    // to ask it for a view or a tab that only the right profile has.
    const profile = ev.payload.settings?.kneeboardProfile;
    if (profile) selectProfile(profile);
    this.#showWheel(ev.payload.settings ?? {});
  }

  override onDialDown(ev: DialDownEvent<OverlayControlSettings>): void {
    const profile = ev.payload.settings?.kneeboardProfile;
    if (profile) selectProfile(profile);
    this.#showWheel(ev.payload.settings ?? {});
  }
}

export type ProfileSelectSettings = { profile?: string };

/** Explicitly switch OpenKneeboard profiles from either a key or a dial press. */
@action({ UUID: `${UUID}.profile-select` })
export class ProfileSelect extends SingletonAction<ProfileSelectSettings> {
  override async onWillAppear(ev: WillAppearEvent<ProfileSelectSettings>): Promise<void> {
    if (ev.action.isDial()) await ev.action.setTitle(ev.payload.settings?.profile || "Profile");
  }
  #select(settings: ProfileSelectSettings): void {
    const name = settings.profile?.trim();
    if (name) selectProfile(name);
  }
  override onKeyDown(ev: KeyDownEvent<ProfileSelectSettings>): void {
    this.#select(ev.payload.settings ?? {});
  }
  override onDialDown(ev: DialDownEvent<ProfileSelectSettings>): void {
    this.#select(ev.payload.settings ?? {});
  }
}

export type TabSelectSettings = { tab?: string; view?: number };

/** Show a named tab on the active view, or a configured view. */
@action({ UUID: `${UUID}.tab-select` })
export class TabSelect extends SingletonAction<TabSelectSettings> {
  override async onWillAppear(ev: WillAppearEvent<TabSelectSettings>): Promise<void> {
    if (ev.action.isDial()) await ev.action.setTitle(ev.payload.settings?.tab || "Tab");
  }
  #select(settings: TabSelectSettings): void {
    const title = settings.tab?.trim();
    if (title) showTabOnView(title, settings.view ?? 0);
  }
  override onKeyDown(ev: KeyDownEvent<TabSelectSettings>): void {
    this.#select(ev.payload.settings ?? {});
  }
  override onDialDown(ev: DialDownEvent<TabSelectSettings>): void {
    this.#select(ev.payload.settings ?? {});
  }
}

export type PlacementDialSettings = {
  /** 0-5 → X / EyeY / Z / RX / RY / RZ. Defaults to dial column or X on a key. */
  dialIndex?: number;
  direction?: number;
  /** Placement tab belonging to this physical Stream Deck page. */
  placementTab?: string;
  /** Multiples of the fine step per dial detent; defaults to one. */
  tickMultiplier?: number;
  /** Dial 1 scales the selected view's physical size instead of moving EyeY. */
  size?: boolean;
  sizes?: Record<string, Record<string, number>>;
};

/** A placement-page dial. Turn nudges its axis using this page's configured ticks. */
@action({ UUID: `${UUID}.placement-dial` })
export class PlacementDial extends SingletonAction<PlacementDialSettings> {
  #index(ev: { action: { coordinates?: { column: number } }; payload: { settings?: PlacementDialSettings } }): number {
    return ev.payload.settings?.dialIndex ?? ev.action.coordinates?.column ?? 0;
  }

  override async onWillAppear(ev: WillAppearEvent<PlacementDialSettings>): Promise<void> {
    pageAppeared(ev.action.device.id, { page: "placement", tab: ev.payload.settings?.placementTab });
    if (!ev.action.isDial()) return;
    const feedback = placementFeedbackForAxis(this.#index(ev), ev.payload.settings?.size === true);
    if (!feedback) return;
    // Encoder touch strips have their own feedback layout. `States[].Image` only supplies the
    // action image; it does not populate this layout's `icon` pixmap.
    await ev.action.setFeedbackLayout("$X1");
    await ev.action.setFeedback({ title: feedback.title, icon: feedback.icon });
  }

  override onDialRotate(ev: DialRotateEvent<PlacementDialSettings>): void {
    this.#move(ev.payload.settings ?? {}, this.#index(ev), ev.payload.ticks * (ev.payload.settings?.tickMultiplier ?? 1));
  }

  #move(settings: PlacementDialSettings, index: number, ticks: number): void {
    const before = getPlacement();
    const candidate = settings?.sizes?.[String(before.target)];
    const base = validSize(candidate) ? candidate : DEFAULT_VIEW_SIZE;
    const { nudge, state } = settings?.size
      ? resize(before, ticks, base)
      : rotate(before, index, ticks);
    setPlacement(state);
    sendNudge(nudge, before.target);
  }

  override onKeyDown(ev: KeyDownEvent<PlacementDialSettings>): void {
    // Keys can sit in any column; only dials inherit their axis from the physical column.
    this.#move(ev.payload.settings ?? {}, ev.payload.settings?.dialIndex ?? 0, ev.payload.settings?.direction ?? 1);
  }

}

export type ViewKeySettings = {
  /** The `Kneeboard` index this key acts on: 1-based, 0 meaning whichever view is active. */
  view?: number;
};

/**
 * Point the dials at a view.
 *
 * With more than one panel, "move the kneeboard" is ambiguous. This is the deliberate, visible
 * answer to which one — the alternative was inferring it from whichever panel was last touched,
 * which is a rule nobody can hold in their head with a headset on.
 */
@action({ UUID: `${UUID}.view-select` })
export class ViewSelect extends SingletonAction<ViewKeySettings> {
  override async onWillAppear(ev: WillAppearEvent<ViewKeySettings>): Promise<void> {
    pageAppeared(ev.action.device.id, { page: "placement" });
    if (ev.action.isDial()) await ev.action.setTitle(`Move view ${ev.payload.settings?.view ?? 1}`);
  }
  #select(settings: ViewKeySettings): void {
    const view = settings.view ?? 1;
    setPlacement(setTarget(getPlacement(), view));
    streamDeck.logger.info(`dials now move view ${view}`);
  }
  override onKeyDown(ev: KeyDownEvent<ViewKeySettings>): void {
    this.#select(ev.payload.settings ?? {});
  }
  override onDialDown(ev: DialDownEvent<ViewKeySettings>): void {
    this.#select(ev.payload.settings ?? {});
  }
}

/**
 * Show or hide one view.
 *
 * Always a toggle, never a remembered state: the mailslot is one-way, so the plugin cannot read
 * back whether a panel is up. Letting OpenKneeboard do the toggling keeps the truth in the one
 * place that has it.
 */
@action({ UUID: `${UUID}.view-visibility` })
export class ViewVisibility extends SingletonAction<ViewKeySettings> {
  override async onWillAppear(ev: WillAppearEvent<ViewKeySettings>): Promise<void> {
    pageAppeared(ev.action.device.id, { page: "placement" });
    if (ev.action.isDial()) await ev.action.setTitle(`Toggle view ${ev.payload.settings?.view ?? 1}`);
  }
  #toggle(settings: ViewKeySettings): void {
    const view = settings.view ?? 1;
    toggleView(view);
    streamDeck.logger.info(`toggled visibility of view ${view}`);
  }
  override onKeyDown(ev: KeyDownEvent<ViewKeySettings>): void {
    this.#toggle(ev.payload.settings ?? {});
  }
  override onDialDown(ev: DialDownEvent<ViewKeySettings>): void {
    this.#toggle(ev.payload.settings ?? {});
  }
}

export type ViewOpacitySettings = {
  /** Which view to fade. Omitted, the key follows whichever view `Move n` last selected. */
  view?: number;
  /** Signed step. Negative fades out; OpenKneeboard clamps to 0..1 at both ends. */
  step?: number;
};

/**
 * Fade the selected view up or down.
 *
 * It follows the SAME selection the dials use rather than carrying its own view number, so
 * `Move 2` then fade means what it looks like. A key with an explicit `view` overrides that, which
 * is what a fixed "dim the wheel" key would want.
 */
@action({ UUID: `${UUID}.view-opacity` })
export class ViewOpacity extends SingletonAction<ViewOpacitySettings> {
  override async onWillAppear(ev: WillAppearEvent<ViewOpacitySettings>): Promise<void> {
    pageAppeared(ev.action.device.id, { page: "placement" });
    if (!ev.action.isDial()) return;
    const feedback = placementFeedback(0)!;
    await ev.action.setFeedbackLayout("$X1");
    await ev.action.setFeedback({ title: feedback.title, icon: feedback.icon });
  }
  #step(settings: ViewOpacitySettings): void {
    const view = settings.view ?? getPlacement().target;
    const step = settings.step ?? -OPACITY_STEP;
    fadeView(view, step);
    streamDeck.logger.info(`faded view ${view} by ${step}`);
  }
  override onKeyDown(ev: KeyDownEvent<ViewOpacitySettings>): void {
    this.#step(ev.payload.settings ?? {});
  }
  override onDialDown(ev: DialDownEvent<ViewOpacitySettings>): void {
    this.#step(ev.payload.settings ?? {});
  }
  override onDialRotate(ev: DialRotateEvent<ViewOpacitySettings>): void {
    const view = ev.payload.settings?.view ?? getPlacement().target;
    fadeView(view, ev.payload.ticks * OPACITY_STEP);
  }
}

/** Undo everything this session moved. Relative-only API, so this is the only "reset" possible. */
@action({ UUID: `${UUID}.placement-reset` })
export class PlacementReset extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    pageAppeared(ev.action.device.id, { page: "placement" });
    if (ev.action.isDial()) await ev.action.setTitle("Reset position");
  }
  override onKeyDown(): void {
    const before = getPlacement();
    const { nudge, state } = resetDelta(before);
    setPlacement(state);
    sendNudge(nudge, before.target);
  }
  override onDialDown(): void {
    this.onKeyDown();
  }
}

/** Recenter, which works against the shipped release and needs no PR. */
@action({ UUID: `${UUID}.recentre` })
export class Recentre extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    if (ev.action.isDial()) await ev.action.setTitle("Recentre VR");
  }
  override onKeyDown(): void {
    send(recenterVr());
  }
  override onDialDown(): void {
    this.onKeyDown();
  }
}
