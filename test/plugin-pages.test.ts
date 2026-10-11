import test from "node:test";
import assert from "node:assert/strict";
import {
  PAGE_SETTLE_MS,
  PLACEMENT_TAB,
  createPageCoordinator,
  createPageKeys,
  pageEdit,
  pageSettingsFor,
  resolvePage,
  type PageClock,
  type PageEffects,
  type PageKeyKind,
  type PageSignal,
} from "../src/pages.ts";

/** A clock the test drives by hand: the settle window costs no wall time, and a timer that never
 * fires is visible rather than merely slow. */
function fakeClock() {
  const pending: { handler: () => void; ms: number }[] = [];
  const clock: PageClock = {
    setTimeout(handler, ms) {
      pending.push({ handler, ms });
      return pending.length;
    },
  };
  return {
    clock,
    armed: () => pending.map((p) => p.ms),
    fireAll() {
      const due = pending.splice(0);
      assert.ok(due.length > 0, "expected a settle timer to be armed");
      for (const d of due) d.handler();
    },
  };
}

function harness() {
  const applied: { device: string; effects: PageEffects }[] = [];
  const timer = fakeClock();
  const pages = createPageCoordinator({
    apply: (device, effects) => applied.push({ device, effects }),
    clock: timer.clock,
  });
  return { pages, applied, timer };
}

const deckKey: PageSignal = { from: "show-view", pageTab: "AMS2", profile: "AMS2" };
const placementDial: PageSignal = { from: "placement" };
/** Wheel Ref's copy on the placement page: the same key, reporting that page's view-1 tab. */
const placementKey: PageSignal = { from: "show-view", pageTab: PLACEMENT_TAB, profile: "AMS2" };

test("the deck page shows its deck map and asserts its overlay profile", () => {
  assert.deepEqual(resolvePage([deckKey]), { tab: "AMS2", profile: "AMS2", enteredPlacement: false });
});

test("any placement action makes the batch the placement page, whatever else appeared", () => {
  // The collision this module exists to remove: the placement page carries a copy of Wheel Ref,
  // whose deck-page behaviour would put the deck map on view 1 as the page appears — the same
  // moment the placement dials put the placement reference there. One decision, not two senders.
  const effects = resolvePage([placementKey, placementDial, { from: "placement", tab: PLACEMENT_TAB }]);
  assert.deepEqual(effects, { tab: PLACEMENT_TAB, profile: "AMS2", enteredPlacement: true });
});

test("a placement-page key still naming the deck map is a disagreement, not a silent override", () => {
  // Before 2026-10-08 the placement page's Show View keys carried the game's deck map, and the
  // coordinator ignored it there. Now the key's page tab and the dials' reference are one value.
  const effects = resolvePage([{ ...deckKey, source: "wheel" }, { from: "placement", tab: PLACEMENT_TAB, source: "dial" }])!;
  assert.equal(effects.tab, undefined, "neither tab is guessed");
  assert.equal(effects.profile, "AMS2", "the profile agrees, so it still switches");
  assert.deepEqual(effects.disagreement, { fields: ["pageTab"], sources: ["dial", "wheel"] });
});

test("arrival order cannot change the outcome", () => {
  // The old per-action handlers raced: whichever send landed last won view 1. Every ordering of
  // the same page must now resolve identically.
  const signals: PageSignal[] = [deckKey, placementDial, { from: "placement", tab: "Placement" }];
  const permutations = (xs: PageSignal[]): PageSignal[][] =>
    xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]));
  const outcomes = new Set(permutations(signals).map((order) => JSON.stringify(resolvePage(order))));
  assert.equal(outcomes.size, 1, `orderings disagreed: ${[...outcomes].join(" | ")}`);
});

test("a placement page without Wheel Ref asserts no profile rather than a guessed one", () => {
  assert.deepEqual(resolvePage([placementDial]), { tab: PLACEMENT_TAB, profile: undefined, enteredPlacement: true });
  assert.equal(resolvePage([]), undefined, "an empty batch decides nothing");
});

test("the placement page honours a generated reference title", () => {
  assert.equal(resolvePage([{ from: "placement", tab: "Placement Coarse" }])!.tab, "Placement Coarse");
});

test("one page change applies once, after the settle window, per device", () => {
  const { pages, applied, timer } = harness();
  pages.appeared("deck-A", placementKey);
  pages.appeared("deck-A", placementDial);
  pages.appeared("deck-A", placementDial);
  assert.deepEqual(timer.armed(), [PAGE_SETTLE_MS], "one timer for the batch, not one per signal");
  assert.equal(applied.length, 0, "nothing is sent before the page has settled");
  timer.fireAll();
  assert.deepEqual(applied, [{ device: "deck-A", effects: { tab: PLACEMENT_TAB, profile: "AMS2", enteredPlacement: true } }]);

  // Done: the deck page appears again, as a new batch.
  pages.appeared("deck-A", deckKey);
  timer.fireAll();
  assert.equal(applied.length, 2);
  assert.deepEqual(applied[1]!.effects, { tab: "AMS2", profile: "AMS2", enteredPlacement: false });
});

test("two devices settle independently", () => {
  const { pages, applied, timer } = harness();
  pages.appeared("deck-A", deckKey);
  pages.appeared("deck-B", placementDial);
  assert.equal(timer.armed().length, 2);
  timer.fireAll();
  assert.deepEqual(applied.map((a) => [a.device, a.effects.enteredPlacement]).sort(), [["deck-A", false], ["deck-B", true]]);
});

test("switching Coarse to Fine keeps the placement accumulator", () => {
  const { pages, applied, timer } = harness();
  pages.appeared("deck-A", placementDial);
  timer.fireAll();
  pages.appeared("deck-A", { from: "placement", tab: "Placement Fine" });
  timer.fireAll();
  assert.equal(applied[0]!.effects.enteredPlacement, true);
  assert.deepEqual(applied[1]!.effects, {
    tab: "Placement Fine", profile: undefined, enteredPlacement: false,
  });
});

test("a different game profile starts a fresh placement session", () => {
  const { pages, applied, timer } = harness();
  pages.appeared("deck-A", { from: "show-view", pageTab: "Placement", profile: "AMS2" });
  pages.appeared("deck-A", { from: "placement", tab: "Placement" });
  timer.fireAll();
  pages.appeared("deck-A", { from: "show-view", pageTab: "Placement Fine", profile: "LMU" });
  pages.appeared("deck-A", { from: "placement", tab: "Placement Fine" });
  timer.fireAll();
  assert.equal(applied[1]!.effects.enteredPlacement, true);
  assert.equal(applied[1]!.effects.profile, "LMU");
});

test("keys that disagree on a page setting withhold that setting, and say which keys", () => {
  // Before, the first key to appear won: an arbitrary pick that looked like a decision. A page's
  // Show View keys each carry a copy of the page settings, so a hand edit to one copy is the case.
  const a: PageSignal = { from: "show-view", pageTab: "AMS2", profile: "AMS2", source: "key-a" };
  const b: PageSignal = { from: "show-view", pageTab: "AMS2", profile: "LMU", source: "key-b" };
  assert.deepEqual(resolvePage([a, b]), {
    tab: "AMS2", profile: undefined, enteredPlacement: false,
    disagreement: { fields: ["kneeboardProfile"], sources: ["key-a", "key-b"] },
  });
  const tabs = resolvePage([a, { ...a, pageTab: "LMU", source: "key-c" }])!;
  assert.deepEqual(tabs.disagreement?.fields, ["pageTab"]);
  assert.equal(tabs.tab, undefined, "no deck map is guessed");
  // Order still cannot matter.
  assert.deepEqual(resolvePage([b, a]), resolvePage([a, b]));
});

test("a blank profile is 'keep the current one', not a disagreeing vote", () => {
  const set: PageSignal = { from: "show-view", pageTab: "AMS2", profile: "AMS2", source: "key-a" };
  const blank: PageSignal = { from: "show-view", pageTab: "AMS2", source: "key-b" };
  assert.deepEqual(resolvePage([blank, set]), { tab: "AMS2", profile: "AMS2", enteredPlacement: false });
});

test("a disagreement on the placement page withholds the profile but keeps the placement reference", () => {
  const effects = resolvePage([
    { from: "show-view", pageTab: PLACEMENT_TAB, profile: "AMS2", source: "key-a" },
    { from: "show-view", pageTab: PLACEMENT_TAB, profile: "LMU", source: "key-b" },
    placementDial,
  ])!;
  assert.equal(effects.tab, PLACEMENT_TAB);
  assert.equal(effects.profile, undefined);
  assert.equal(effects.enteredPlacement, true);
  assert.deepEqual(effects.disagreement?.fields, ["kneeboardProfile"]);
});

test("only the page settings a save changed count as an edit; blank and absent are the same", () => {
  const before = { view: 2, pageTab: "AMS2", kneeboardProfile: "AMS2" };
  assert.equal(pageEdit("show-view", before, { ...before, view: 3 }), undefined, "the key's own view is not a page edit");
  assert.deepEqual(pageEdit("show-view", before, { ...before, kneeboardProfile: "AMS2 Night" }), { kneeboardProfile: "AMS2 Night" });
  assert.deepEqual(pageEdit("show-view", before, { view: 2, pageTab: "AMS2" }), { kneeboardProfile: undefined }, "clearing is an edit");
  assert.equal(pageEdit("show-view", { view: 3 }, { view: 3, kneeboardProfile: "" }), undefined);
  assert.deepEqual(pageEdit("placement", { placementTab: "Placement" }, { placementTab: "Placement Fine" }), { pageTab: "Placement Fine" });
});

test("an edit is written only where it changes something, under the key kind's own setting names", () => {
  const sibling = { view: 2, tab: "AMS2 Wheel", pageTab: "AMS2", kneeboardProfile: "AMS2", generatedBy: "Escargot" };
  assert.deepEqual(pageSettingsFor("show-view", { kneeboardProfile: "AMS2 Night" }, sibling), { ...sibling, kneeboardProfile: "AMS2 Night" });
  assert.deepEqual(pageSettingsFor("show-view", { kneeboardProfile: undefined }, sibling),
    { view: 2, tab: "AMS2 Wheel", pageTab: "AMS2", generatedBy: "Escargot" }, "a cleared setting is cleared");
  assert.equal(pageSettingsFor("show-view", { kneeboardProfile: "AMS2" }, sibling), undefined, "already agrees: no write");
  const dial = { dialIndex: 0, placementTab: "Placement" };
  assert.deepEqual(pageSettingsFor("placement", { pageTab: "Placement Fine", kneeboardProfile: "LMU" }, dial),
    { dialIndex: 0, placementTab: "Placement Fine" }, "a dial takes the view-1 tab as placementTab and holds no profile");
  assert.equal(pageSettingsFor("placement", { kneeboardProfile: "LMU" }, dial), undefined);
});

function pageKeysHarness() {
  const pageKeys = createPageKeys();
  const writes: { id: string; settings: Record<string, unknown> }[] = [];
  const add = (id: string, kind: PageKeyKind, settings: Record<string, unknown>, device = "deck-A") =>
    pageKeys.appeared(id, { kind, device, settings, write: (next) => writes.push({ id, settings: next }) });
  return { pageKeys, writes, add };
}

test("a key saved without changing a page setting copies nothing, even when it disagrees with the page", async () => {
  // The bug this guards: a hand-made key with no page settings, saved for its view alone, used to
  // push its blanks over every generated key on the page, and the overlay stopped following the deck.
  const { pageKeys, writes, add } = pageKeysHarness();
  add("wheel", "show-view", { view: 2, pageTab: "AMS2", kneeboardProfile: "AMS2" });
  add("hand", "show-view", { view: 3 });
  assert.deepEqual(await pageKeys.saved("hand", { view: 4 }), []);
  assert.deepEqual(writes, []);
});

test("a changed page setting reaches the page's other keys of every kind on that device, and no others", async () => {
  const { pageKeys, writes, add } = pageKeysHarness();
  add("show-1", "show-view", { view: 1, pageTab: "Placement", kneeboardProfile: "AMS2" });
  add("wheel", "show-view", { view: 2, pageTab: "Placement", kneeboardProfile: "AMS2" });
  add("dial-0", "placement", { dialIndex: 0, placementTab: "Placement" });
  add("other-deck", "show-view", { view: 2, pageTab: "Placement", kneeboardProfile: "AMS2" }, "deck-B");
  const written = await pageKeys.saved("show-1", { view: 1, pageTab: "Placement Fine", kneeboardProfile: "AMS2" });
  assert.deepEqual(written.sort(), ["dial-0", "wheel"]);
  assert.deepEqual(writes.find((w) => w.id === "dial-0")!.settings, { dialIndex: 0, placementTab: "Placement Fine" });

  // And back the other way: the dial's reference is the same value.
  writes.length = 0;
  assert.deepEqual((await pageKeys.saved("dial-0", { dialIndex: 0, placementTab: "Placement" })).sort(), ["show-1", "wheel"]);
  assert.ok(writes.every((w) => w.settings.pageTab === "Placement"));

  // A key that has gone off screen is not written.
  pageKeys.disappeared("wheel");
  writes.length = 0;
  await pageKeys.saved("show-1", { view: 1, pageTab: "Placement", kneeboardProfile: "LMU" });
  assert.deepEqual(writes, [], "the dial holds no profile, and wheel is off screen");
});
