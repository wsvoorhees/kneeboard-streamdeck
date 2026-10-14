/**
 * The one piece of shared state the plugin has: the loaded OpenKneeboard C API DLL and the placement
 * accumulator. Both are per-process, because the plugin IS the resident sender.
 */

import streamDeck from "@elgato/streamdeck";

import { createCapiSender, type Sender } from "./capi.ts";
import { openKneeboardRunning } from "./running.ts";
import {
  createProfileAsserter,
  isEmptyNudge,
  nudgeVrView,
  setTabByNameOnView,
  setVrViewOpacity,
  toggleVrViewVisibility,
  type Message,
  type Nudge,
} from "../protocol.ts";
import { createPlacement, type PlacementState } from "../placement.ts";
import { createPageCoordinator, type PageSignal } from "../pages.ts";

let sender: Sender | undefined;

/** Created lazily, and the DLL inside it loads lazily: OpenKneeboard records its install path only
 * when it first launches, so a load at Stream Deck startup could fail for the whole session. */
const out = (): Sender => (sender ??= createCapiSender());

let reported: string | undefined;
let announced: string | undefined;

export function send(message: Message): boolean {
  const sender = out();
  const ok = sender.send(message);
  // Logged once per distinct problem, not per dial tick: the reason is the same every time.
  if (!ok && sender.problem !== reported) streamDeck.logger.warn(`OpenKneeboard C API: ${sender.problem}`);
  reported = ok ? undefined : sender.problem;
  // Which DLL is in use, once per load: the one thing about the transport that differs by machine.
  const dll = sender.loaded;
  if (dll && dll.path !== announced) {
    streamDeck.logger.info(`OpenKneeboard C API: loaded ${dll.path} (from ${dll.source})`);
    if (dll.skipped) streamDeck.logger.warn(`OpenKneeboard C API: ${dll.skipped}; using ${dll.path}, which may be an older install`);
    announced = dll.path;
  }
  return ok;
}

export function sendNudge(delta: Nudge, kneeboard = 0): boolean {
  if (isEmptyNudge(delta)) return true;
  return send(nudgeVrView(delta, kneeboard));
}

/** Toggle one view in VR. */
export const toggleView = (kneeboard: number): boolean => send(toggleVrViewVisibility(kneeboard));

/** Fade one view up or down by a relative step. OpenKneeboard does the clamping. */
export const fadeView = (kneeboard: number, delta: number): boolean =>
  send(setVrViewOpacity(kneeboard, delta));

/** Point one view at a tab, leaving the others alone. */
export const showTabOnView = (title: string, kneeboard: number): boolean =>
  send(setTabByNameOnView(title, kneeboard));

/**
 * Switch OpenKneeboard to a profile. The policy — de-duplicate, but never remember a failed send —
 * lives in `createProfileAsserter`, which is pure and covered on Linux.
 */
const profile = createProfileAsserter(send, openKneeboardRunning);
export const showProfile = (name: string): boolean => profile.assert(name);

/** A manual selection always sends, even after an automatic assertion of the same name. */
export const selectProfile = (name: string): boolean => profile.select(name);

/** Forget the asserted profile, so a restart re-asserts rather than assuming. */
export const forgetProfile = (): void => profile.forget();

/** Placement state lives here so the dials, Reset and Done all see the same accumulator. */
let placement: PlacementState = createPlacement();
export const getPlacement = (): PlacementState => placement;
export const setPlacement = (next: PlacementState): void => { placement = next; };
export const resetPlacementState = (): void => { placement = createPlacement(); };

/**
 * Page changes, resolved once. Every action reports its page on `willAppear`; the coordinator
 * gathers one page's reports and applies a single decision, so two actions can no longer race to
 * put different tabs on view 1. See `pages.ts`.
 */
const pages = createPageCoordinator({
  apply: (device, effects) => {
    // One line per page change: the only record of what the plugin decided, since the channel to
    // OpenKneeboard is one-way and cannot be read back.
    streamDeck.logger.info(
      `page on ${device}: ${effects.enteredPlacement ? "placement" : "deck"} → view 1 ${effects.tab ? `"${effects.tab}"` : "unchanged"}` +
      (effects.profile ? `, profile "${effects.profile}"` : ""),
    );
    if (effects.disagreement) {
      // Loud, not silent: the keys show the alert triangle, and the log says which setting to fix.
      streamDeck.logger.warn(`page on ${device}: Show View keys disagree on ${effects.disagreement.fields.join(" and ")}; ` +
        "set them the same on every Show View key in this profile. Not switching until they agree.");
      for (const id of effects.disagreement.sources) void streamDeck.actions.getActionById(id)?.showAlert();
    }
    if (effects.profile) showProfile(effects.profile);
    if (effects.enteredPlacement) resetPlacementState();
    if (effects.tab) showTabOnView(effects.tab, 1);
  },
});
export const pageAppeared = (device: string, signal: PageSignal): void => pages.appeared(device, signal);

export function closeSession(): void {
  sender?.close();
  sender = undefined;
  announced = undefined;
  forgetProfile();
}
