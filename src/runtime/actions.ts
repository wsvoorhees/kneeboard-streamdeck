import {
  action,
  SingletonAction,
  streamDeck,
  type DialDownEvent,
  type DialRotateEvent,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";

import { placementFeedback, placementFeedbackForAxis } from "../feedback.ts";
import { DEFAULT_VIEW_SIZE, OPACITY_STEP, resetDelta, resize, rotate, setTarget,
  validSize } from "../placement.ts";
import { PLUGIN_UUID } from "../identity.ts";
import { recenterVr } from "../protocol.ts";
import { createPageKeys, type PageKeyKind } from "../pages.ts";
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

/** Every visible key holding page settings, Show View keys and placement dials alike, so an edit to
 *  one reaches the others on its page (`pages.ts` createPageKeys). */
const pageKeys = createPageKeys();

function trackPageKey<T extends ShowViewSettings | PlacementDialSettings>(kind: PageKeyKind, ev: WillAppearEvent<T>): void {
  pageKeys.appeared(ev.action.id, {
    kind, device: ev.action.device.id, settings: ev.payload.settings ?? {},
    write: (next) => ev.action.setSettings(next as T),
  });
}

/** A save in the settings panel: copy whatever page setting it changed to the page's other keys. */
async function pageKeySaved<T extends ShowViewSettings | PlacementDialSettings>(ev: DidReceiveSettingsEvent<T>): Promise<void> {
  const written = await pageKeys.saved(ev.action.id, ev.payload.settings ?? {});
  if (written.length > 0) streamDeck.logger.info(`copied a page setting to ${written.length} other key(s)`);
}

export type ProfileSelectSettings = { profile?: string };

/** Explicitly switch OpenKneeboard profiles from either a key or a dial press. */
@action({ UUID: `${PLUGIN_UUID}.profile-select` })
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
@action({ UUID: `${PLUGIN_UUID}.tab-select` })
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
@action({ UUID: `${PLUGIN_UUID}.placement-dial` })
export class PlacementDial extends SingletonAction<PlacementDialSettings> {
  #index(ev: { action: { coordinates?: { column: number } }; payload: { settings?: PlacementDialSettings } }): number {
    return ev.payload.settings?.dialIndex ?? ev.action.coordinates?.column ?? 0;
  }

  override async onWillAppear(ev: WillAppearEvent<PlacementDialSettings>): Promise<void> {
    trackPageKey("placement", ev);
    pageAppeared(ev.action.device.id, { from: "placement", tab: ev.payload.settings?.placementTab, source: ev.action.id });
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

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<PlacementDialSettings>): Promise<void> {
    await pageKeySaved(ev);
  }

  override onWillDisappear(ev: WillDisappearEvent<PlacementDialSettings>): void {
    pageKeys.disappeared(ev.action.id);
  }
}

export type ViewKeySettings = {
  /** The `Kneeboard` index this key acts on: 1-based, 0 meaning whichever view is active. */
  view?: number;
};

/**
 * Point the dials at a view.
 *
 * With more than one view, "move the kneeboard" is ambiguous. This is the deliberate, visible
 * answer to which one — the alternative was inferring it from whichever view was last touched,
 * which is a rule nobody can hold in their head with a headset on.
 */
@action({ UUID: `${PLUGIN_UUID}.view-select` })
export class ViewSelect extends SingletonAction<ViewKeySettings> {
  override async onWillAppear(ev: WillAppearEvent<ViewKeySettings>): Promise<void> {
    pageAppeared(ev.action.device.id, { from: "placement" });
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

export type ShowViewSettings = ViewKeySettings & {
  /** The tab the view shows, which SetTabByName matches exactly. Put on the view BEFORE toggling,
   *  so the view comes up showing it even after someone paged it elsewhere. Unset, the view keeps
   *  whatever it shows: view 1's tab follows the page, which the coordinator decides. */
  tab?: string;
  /** The tab view 1 shows on this key's page: the game's deck map on a game page, the placement
   *  reference on a placement page. A page setting (`pages.ts` PAGE_SETTINGS), reported on appear. */
  pageTab?: string;
  /**
   * The OpenKneeboard profile this deck profile belongs with, asserted when the key appears.
   *
   * This is what makes the overlay follow the game: an OpenKneeboard profile carries both the tab
   * list and the view placement, so switching it is how the right deck map appears in the right
   * place. Every generated Show View key carries it, so no single key is what keeps the pairing.
   */
  kneeboardProfile?: string;
};

/**
 * Show or hide one view, with its tab: Wheel Ref and Orca on a game page, `Show N` on placement.
 *
 * Always a toggle, never a remembered state: the mailslot is one-way, so the plugin cannot read
 * back whether a view is up. Letting OpenKneeboard do the toggling keeps the truth in the one
 * place that has it.
 *
 * On appear it reports the GAME, not a page kind. `onWillAppear` is the only signal the plugin gets
 * that a deck profile was switched to (Stream Deck has no "profile activated" event), and it also
 * covers the deck reconnecting and the plugin restarting. On the placement page the coordinator
 * sees the placement controls in the same batch and shows the placement reference instead.
 *
 * What it does NOT cover: OpenKneeboard starting while the deck is already on a game. Nothing
 * appears then, and the channel is one-way, so the press re-asserts the profile: pressing the key
 * you would reach for anyway is the cheapest resync available, and the press is about to ask for a
 * view or a tab that only the right profile has.
 */
// The UUID predates the Show View name; changing it would orphan every key already placed.
@action({ UUID: `${PLUGIN_UUID}.view-visibility` })
export class ShowView extends SingletonAction<ShowViewSettings> {
  override async onWillAppear(ev: WillAppearEvent<ShowViewSettings>): Promise<void> {
    trackPageKey("show-view", ev);
    const { pageTab, kneeboardProfile } = ev.payload.settings ?? {};
    if (pageTab || kneeboardProfile) {
      pageAppeared(ev.action.device.id, { from: "show-view", pageTab, profile: kneeboardProfile, source: ev.action.id });
    }
    if (ev.action.isDial()) await ev.action.setTitle(`Show view ${ev.payload.settings?.view ?? 1}`);
  }
  #toggle(settings: ShowViewSettings): void {
    const view = settings.view ?? 1;
    if (settings.kneeboardProfile) selectProfile(settings.kneeboardProfile);
    if (settings.tab) showTabOnView(settings.tab, view);
    toggleView(view);
    streamDeck.logger.info(`toggled view ${view}${settings.tab ? ` (${settings.tab})` : ""}`);
  }
  override onKeyDown(ev: KeyDownEvent<ShowViewSettings>): void {
    this.#toggle(ev.payload.settings ?? {});
  }
  override onDialDown(ev: DialDownEvent<ShowViewSettings>): void {
    this.#toggle(ev.payload.settings ?? {});
  }
  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<ShowViewSettings>): Promise<void> {
    await pageKeySaved(ev);
  }
  override onWillDisappear(ev: WillDisappearEvent<ShowViewSettings>): void {
    pageKeys.disappeared(ev.action.id);
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
@action({ UUID: `${PLUGIN_UUID}.view-opacity` })
export class ViewOpacity extends SingletonAction<ViewOpacitySettings> {
  override async onWillAppear(ev: WillAppearEvent<ViewOpacitySettings>): Promise<void> {
    pageAppeared(ev.action.device.id, { from: "placement" });
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
@action({ UUID: `${PLUGIN_UUID}.placement-reset` })
export class PlacementReset extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    pageAppeared(ev.action.device.id, { from: "placement" });
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
@action({ UUID: `${PLUGIN_UUID}.recentre` })
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
