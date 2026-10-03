/**
 * The one piece of shared state the plugin has: a held-open mailslot handle and the placement
 * accumulator. Both are per-process, because the plugin IS the resident sender.
 */

import streamDeck from "@elgato/streamdeck";

import { createMailslotSender, type Sender } from "./mailslot.ts";
import {
  createProfileAsserter,
  isEmptyNudge,
  nudgeVrView,
  setTabByName,
  setTabByNameOnView,
  setViewOpacity,
  toggleViewVisibility,
  type Nudge,
} from "../protocol.ts";
import { createPlacement, type PlacementState } from "../placement.ts";
import { createPageCoordinator, type PageSignal } from "../pages.ts";

let sender: Sender | undefined;

/** Opened lazily: OpenKneeboard is usually not running when the Stream Deck starts at login, and a
 * failed open at startup would leave a dead handle for the whole session. */
const out = (): Sender => (sender ??= createMailslotSender());

export const send = (packet: string): boolean => out().send(packet);

export function sendNudge(delta: Nudge, kneeboard = 0): boolean {
  if (isEmptyNudge(delta)) return true;
  return send(nudgeVrView(delta, kneeboard));
}

/** Toggle one view in VR. */
export const toggleView = (kneeboard: number): boolean => send(toggleViewVisibility(kneeboard));

/** Fade one view up or down by a relative step. OpenKneeboard does the clamping. */
export const fadeView = (kneeboard: number, delta: number): boolean =>
  send(setViewOpacity(kneeboard, delta));

/** Point one view at a tab, leaving the others alone. */
export const showTabOnView = (title: string, kneeboard: number): boolean =>
  send(setTabByNameOnView(title, kneeboard));

export const showTab = (title: string): boolean => send(setTabByName(title));

/**
 * Switch OpenKneeboard to a profile. The policy — de-duplicate, but never remember a failed send —
 * lives in `createProfileAsserter`, which is pure and covered on Linux.
 */
const profile = createProfileAsserter(send);
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
      `page on ${device}: ${effects.enteredPlacement ? "placement" : "deck"} → view 1 "${effects.tab}"` +
      (effects.profile ? `, profile "${effects.profile}"` : ""),
    );
    if (effects.profile) showProfile(effects.profile);
    if (effects.enteredPlacement) resetPlacementState();
    if (effects.tab) showTabOnView(effects.tab, 1);
  },
});
export const pageAppeared = (device: string, signal: PageSignal): void => pages.appeared(device, signal);

export function closeSession(): void {
  sender?.close();
  sender = undefined;
  forgetProfile();
}
