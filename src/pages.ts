/**
 * Which page is up, decided once.
 *
 * Stream Deck gives a plugin no "page changed" or "profile switched" event. The only evidence is
 * `willAppear` on the plugin's own actions, which fires for every one of them on the page that just
 * came up. Each action used to act on that alone — Wheel Ref put the deck map on view 1, the opacity
 * dial put the placement reference there — so one page change produced several sends for the same
 * view, and whichever landed last won. Putting a Wheel Ref copy on the placement page (2026-09-22)
 * made that a live race, patched with a per-key "don't assert on appear" flag.
 *
 * This removes the race instead. Every appearing action reports which page it belongs to; the
 * reports from one page change are gathered for a short settle window and resolved into ONE set of
 * effects. A batch containing any placement-page action is the placement page; a Show View key there
 * is the same action as on the game page, carrying that page's settings.
 *
 * Pure: the clock is injected, as in `dispatch.ts`, so the settle window is tested without sleeping.
 */

/** Long enough to collect one page's appear events, which arrive back to back; short enough to be
 * imperceptible next to the page change itself. */
export const PAGE_SETTLE_MS = 50;

/** The placement reference's tab title, which `vr --all` and the OpenKneeboard profiles agree on. */
export const PLACEMENT_TAB = "Placement";

/** What one appearing action says about the page it is on. `source` is the action's id, so a
 *  disagreement can be shown on the keys that caused it. */
export type PageSignal =
  /** A Show View key (Wheel Ref, Orca, Show N), on any page: its copy of the page settings. Every
   *  such key carries them, so no one key is load-bearing. A key does not know which page it is on;
   *  the batch decides that. */
  | { from: "show-view"; pageTab?: string; profile?: string; source?: string }
  /** Any placement-page control: its presence makes the batch the placement page, and `tab`, when
   *  set, is the placement reference it expects on view 1. */
  | { from: "placement"; tab?: string; source?: string };

export interface PageEffects {
  /** The tab view 1 should show; undefined when nothing named one or the page disagrees on it. */
  tab: string | undefined;
  /** The OpenKneeboard profile to assert; undefined when nothing named one or the page disagrees. */
  profile: string | undefined;
  /** True when moving from the deck page into placement. */
  enteredPlacement: boolean;
  /** Set when the page's keys disagree on a page setting. What depends on a disagreeing value is not
   *  applied; `sources` are the keys to flag. */
  disagreement?: { fields: PageSetting[]; sources: string[] };
}

/**
 * The settings that describe the PAGE rather than the key. Stream Deck has no per-page storage for a
 * plugin, so each key that needs one carries a copy; these rules make the copies behave as one value:
 * an edit to one is copied to the rest (`createPageKeys`), and a page whose copies disagree applies
 * neither rather than whichever key happened to appear first (`resolvePage`).
 *
 * `pageTab` is the tab view 1 shows on this page: the game's deck map on a game page, the placement
 * reference (`Placement`, `Placement Fine`) on a placement page.
 */
export const PAGE_SETTINGS = ["pageTab", "kneeboardProfile"] as const;
export type PageSetting = (typeof PAGE_SETTINGS)[number];

/** Which page settings each kind of key holds, under which of its own setting names. A placement
 *  control holds the page's view-1 tab as `placementTab`, and no profile. */
export const PAGE_FIELDS = {
  "show-view": { pageTab: "pageTab", kneeboardProfile: "kneeboardProfile" },
  placement: { pageTab: "placementTab" },
} as const satisfies Record<PageSignal["from"], Partial<Record<PageSetting, string>>>;
export type PageKeyKind = keyof typeof PAGE_FIELDS;

type KeySettings = Record<string, unknown>;
/** Page settings an edit changed: a value, or undefined where it was cleared. */
export type PageEdit = Partial<Record<PageSetting, string | undefined>>;

function fieldsOf(kind: PageKeyKind): [PageSetting, string][] {
  return Object.entries(PAGE_FIELDS[kind]) as [PageSetting, string][];
}

/** A setting's value as a page setting: a blank and an absent setting are the same. */
function valueOf(settings: KeySettings, name: string): string | undefined {
  const value = settings[name];
  return typeof value === "string" && value ? value : undefined;
}

/**
 * The page settings a save changed, or undefined when it changed none. Only a changed setting is
 * copied: a save that touched the key's own settings (its view, say) must not push its copy of the
 * page settings, possibly blank, over keys that disagree with it.
 */
export function pageEdit(kind: PageKeyKind, before: KeySettings, after: KeySettings): PageEdit | undefined {
  const edit: PageEdit = {};
  for (const [setting, name] of fieldsOf(kind)) {
    if (valueOf(before, name) !== valueOf(after, name)) edit[setting] = valueOf(after, name);
  }
  return Object.keys(edit).length > 0 ? edit : undefined;
}

/**
 * Another key's settings with `edit` applied, or undefined when it already agrees. Only the page
 * settings its kind holds are written, under its own names; a cleared setting is cleared. Everything
 * else on the key (its view, tab, generator stamp) is kept.
 */
export function pageSettingsFor<T extends KeySettings>(kind: PageKeyKind, edit: PageEdit, settings: T): T | undefined {
  let next: T | undefined;
  for (const [setting, name] of fieldsOf(kind)) {
    if (!(setting in edit) || valueOf(settings, name) === edit[setting]) continue;
    next ??= { ...settings };
    if (edit[setting]) (next as KeySettings)[name] = edit[setting];
    else delete (next as KeySettings)[name];
  }
  return next;
}

/** A visible key holding page settings, and how to write its settings back. */
export interface PageKey {
  kind: PageKeyKind;
  device: string;
  settings: KeySettings;
  write(settings: KeySettings): unknown;
}

export interface PageKeys {
  appeared(id: string, key: PageKey): void;
  disappeared(id: string): void;
  /** Record a key's saved settings and copy the page settings the save changed to the other visible
   *  keys on its device. Returns the ids written to. */
  saved(id: string, settings: KeySettings): Promise<string[]>;
}

/**
 * The visible keys that hold page settings, across every kind, so an edit to one reaches the others
 * on its page: a Show View key's View 1 tab reaches the placement dials' reference and back.
 *
 * Settings are tracked from the events rather than read back with `getSettings()`, because in SDK
 * 2.1 that reply also fires `onDidReceiveSettings` on the key read, which would copy its old values
 * back over the key just edited. A write made here does not echo back as a save, so a copy cannot
 * loop. Only keys on screen are reached ("the same page" is the device's visible keys); a generator
 * rewrites the rest on its next install.
 */
export function createPageKeys(): PageKeys {
  const keys = new Map<string, PageKey>();
  return {
    appeared(id, key) {
      keys.set(id, key);
    },
    disappeared(id) {
      keys.delete(id);
    },
    async saved(id, settings) {
      const key = keys.get(id);
      if (!key) return [];
      const edit = pageEdit(key.kind, key.settings, settings);
      key.settings = settings;
      if (!edit) return [];
      const written: string[] = [];
      for (const [otherId, other] of keys) {
        if (otherId === id || other.device !== key.device) continue;
        const next = pageSettingsFor(other.kind, edit, other.settings);
        if (!next) continue;
        other.settings = next;
        await other.write(next);
        written.push(otherId);
      }
      return written;
    },
  };
}

/** One page setting as the batch reported it: the agreed value, or the keys that disagree. */
function agree(reports: readonly { value: string | undefined; source?: string }[]):
  { value: string | undefined; sources?: string[] } {
  const named = reports.filter((r) => r.value);
  const values = new Set(named.map((r) => r.value));
  if (values.size <= 1) return { value: named[0]?.value };
  return { value: undefined, sources: named.flatMap((r) => (r.source ? [r.source] : [])) };
}

/**
 * Resolve one page change. Order-independent by construction: it reads the set, not the sequence.
 *
 * The page is the placement page when any placement control appeared. View 1's tab is whatever the
 * page's keys report, from the Show View keys' `pageTab` and the placement controls' `tab` alike, so
 * those two can never silently disagree; a placement page that names nothing gets the default
 * reference. Disagreeing keys used to resolve to whichever appeared first, an arbitrary pick that
 * looks like a decision. Now each disagreeing setting is withheld on its own and its keys flagged.
 * A blank is "keep the current one", not a vote, so it never disagrees.
 */
export function resolvePage(signals: readonly PageSignal[]): PageEffects | undefined {
  if (signals.length === 0) return undefined;
  const inPlacement = signals.some((s) => s.from === "placement");
  const tab = agree(signals.map((s) => ({ value: s.from === "show-view" ? s.pageTab : s.tab, source: s.source })));
  const profile = agree(signals.flatMap((s) => (s.from === "show-view" ? [{ value: s.profile, source: s.source }] : [])));
  const fields: PageSetting[] = [];
  if (tab.sources) fields.push("pageTab");
  if (profile.sources) fields.push("kneeboardProfile");
  const sources = [...new Set([...(tab.sources ?? []), ...(profile.sources ?? [])])].sort();
  return {
    tab: tab.sources ? undefined : tab.value ?? (inPlacement ? PLACEMENT_TAB : undefined),
    profile: profile.value,
    enteredPlacement: inPlacement,
    ...(fields.length > 0 ? { disagreement: { fields, sources } } : {}),
  };
}

export interface PageClock {
  setTimeout(handler: () => void, ms: number): unknown;
}

const systemClock: PageClock = { setTimeout: (handler, ms) => setTimeout(handler, ms) };

export interface PageCoordinator {
  /** An action appeared on `device`'s current page. */
  appeared(device: string, signal: PageSignal): void;
}

/**
 * Batch appear signals per device and apply each page change once.
 *
 * The first signal of a batch arms the settle timer; later ones join it. Devices are independent —
 * a second deck changing page must not resolve against the first one's keys.
 */
export function createPageCoordinator(options: {
  apply: (device: string, effects: PageEffects) => void;
  settleMs?: number;
  clock?: PageClock;
}): PageCoordinator {
  const { apply, settleMs = PAGE_SETTLE_MS, clock = systemClock } = options;
  const batches = new Map<string, PageSignal[]>();
  const currentPage = new Map<string, "deck" | "placement">();
  const currentProfile = new Map<string, string>();

  return {
    appeared(device, signal) {
      const open = batches.get(device);
      if (open) {
        open.push(signal);
        return;
      }
      batches.set(device, [signal]);
      clock.setTimeout(() => {
        const signals = batches.get(device) ?? [];
        batches.delete(device);
        const effects = resolvePage(signals);
        if (effects) {
          const page = signals.some((s) => s.from === "placement") ? "placement" : "deck";
          const profileChanged = !!effects.profile && !!currentProfile.get(device) && currentProfile.get(device) !== effects.profile;
          apply(device, { ...effects,
            enteredPlacement: page === "placement" && (currentPage.get(device) !== "placement" || profileChanged) });
          currentPage.set(device, page);
          if (effects.profile) currentProfile.set(device, effects.profile);
        }
      }, settleMs);
    },
  };
}
