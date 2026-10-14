/**
 * A standalone check that the transport works, with no Stream Deck involved.
 *
 * `plugin.js` calls `streamDeck.connect()` and expects the websocket arguments Stream Deck passes
 * it, so it cannot be run by hand. This entry exercises the SAME C API module the plugin uses,
 * which is the part that can actually be wrong on a given machine: which DLL it finds, and whether
 * it loads.
 *
 *   node bin/smoke.js            # recentre
 *   node bin/smoke.js "AMS2"     # recentre, then put that tab on view 1
 *
 * The tab goes to view 1, the deck view, exactly as the plugin's page changes do. Naming no view
 * (`Kneeboard: 0`) means "the active view" to OpenKneeboard, which can be any panel: on 2026-10-10
 * that put the deck map over the Orca view. The title must be a tab in the ACTIVE OpenKneeboard
 * profile; any other title is ignored without a word.
 *
 * A failure here means the DLL was not found or would not load. A SUCCESS is weaker than it was
 * under the old mailslot transport: the DLL returns void, so a send to a CLOSED OpenKneeboard also
 * succeeds. Only your eyes can confirm the overlay moved.
 */

import { recenterVr, setTabByNameOnView } from "../protocol.ts";
import { createCapiSender, locateCapi } from "./capi.ts";
import { openKneeboardRunning } from "./running.ts";

const tab = process.argv[2];
const found = locateCapi();
console.log(found.ok ? `C API: ${found.path} (from ${found.source})` : `C API: ${found.reason}`);
if (found.ok && found.skipped) console.log(`C API: ${found.skipped}; fell back, which may be an older install`);
console.log(`OpenKneeboard process: ${openKneeboardRunning() ? "running" : "NOT running (sends will go nowhere)"}`);

const sender = createCapiSender(() => found);

try {
  const recentred = sender.send(recenterVr());
  console.log(recentred ? "sent RECENTER_VR" : `FAILED to send RECENTER_VR: ${sender.problem}`);
  if (tab) {
    const switched = sender.send(setTabByNameOnView(tab, 1));
    console.log(switched ? `sent SetTabByName ${tab} (view 1)` : `FAILED to send SetTabByName ${tab}: ${sender.problem}`);
  }
  process.exitCode = recentred ? 0 : 1;
} finally {
  sender.close();
}
