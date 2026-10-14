import test from "node:test";
import assert from "node:assert/strict";
import {
  AXES,
  createProfileAsserter,
  isEmptyNudge,
  nudgeVrView,
  recenterVr,
  setTabByName,
  setVrViewOpacity,
  setVrViewOpacityAbsolute,
  toggleVrViewVisibility,
  type Message,
} from "../src/protocol.ts";
import { CAPI_DLL, resolveCapiDll, type CapiLookup } from "../src/capi-path.ts";

test("a manual profile selection always sends, while automatic assertions deduplicate", () => {
  const sent: Message[] = [];
  const profiles = createProfileAsserter((message) => { sent.push(message); return true; }, () => true);
  assert.equal(profiles.assert("Race"), true);
  assert.equal(profiles.assert("Race"), true);
  assert.equal(sent.length, 1);
  assert.equal(profiles.select("Race"), true);
  assert.equal(sent.length, 2);
  assert.deepEqual(JSON.parse(sent[1]!.value), { Name: "Race" });
});

test("a failed manual profile selection can be retried", () => {
  let writes = 0;
  const profiles = createProfileAsserter(() => ++writes > 1, () => true);
  assert.equal(profiles.select("Race"), false);
  assert.equal(profiles.assert("Race"), true);
  assert.equal(writes, 2);
});

test("a profile asserted before OpenKneeboard starts is re-sent once it is running", () => {
  // Stream Deck starts at login, before OpenKneeboard. The C API returns void, so that first send
  // "succeeds" into nothing; remembering it would drop every later page naming the same profile.
  const sent: Message[] = [];
  let running = false;
  const profiles = createProfileAsserter((message) => { sent.push(message); return true; }, () => running);
  assert.equal(profiles.assert("AMS2"), true);
  assert.equal(profiles.assert("AMS2"), true);
  assert.equal(sent.length, 2, "with OpenKneeboard closed, nothing is remembered, so each assert sends");

  running = true;
  profiles.assert("AMS2");
  assert.equal(sent.length, 3, "the first assert after OpenKneeboard starts lands");
  profiles.assert("AMS2");
  assert.equal(sent.length, 3, "and only then is the repeat dropped");
});

test("recenter is the RemoteUserAction the shipped RemoteControl utilities send", () => {
  // Accepted by OpenKneeboard 1.12.10 on 2026-09-20 (then over the mailslot; the C API DLL now frames it).
  assert.deepEqual(recenterVr(), { name: "RemoteUserAction", value: "RECENTER_VR" });
});

test("SetTabByName carries every field the non-sparse reader expects", () => {
  const value = JSON.parse(setTabByName("AMS2").value);
  assert.deepEqual(value, { Name: "AMS2", PageNumber: 0, Kneeboard: 0 });
});

test("a nudge omits untouched axes so a single dial sends a single key", () => {
  const payload = JSON.parse(nudgeVrView({ EyeY: -0.01 }).value);
  assert.deepEqual(payload, { Kneeboard: 0, EyeY: -0.01 });
  for (const axis of AXES) {
    if (axis !== "EyeY") assert.ok(!(axis in payload), `${axis} should be absent, not 0`);
  }
});

test("a nudge drops zeroed axes rather than sending a no-op move", () => {
  const payload = JSON.parse(nudgeVrView({ X: 0, RY: 0.5 }).value);
  assert.deepEqual(payload, { Kneeboard: 0, RY: 0.5 });
});

test("an all-zero nudge is reported as empty so the caller can skip the write", () => {
  assert.equal(isEmptyNudge({}), true);
  assert.equal(isEmptyNudge({ X: 0, RZ: 0 }), true);
  assert.equal(isEmptyNudge({ X: 0.001 }), false);
});

test("the nudge message name matches upstream OpenKneeboard", () => {
  // If upstream renames this during review the message becomes silently inert — a write that
  // succeeds and moves nothing, which is exactly the failure this repo keeps shipping.
  assert.equal(nudgeVrView({ X: 1 }).name, "NudgeVRView");
});

/** A lookup over a fake filesystem: only the listed paths exist. */
function lookup(files: string[], env: CapiLookup["env"] = {}, registry?: string): CapiLookup {
  return { env, registryBinPath: () => registry, exists: (p) => files.includes(p) };
}

test("the C API DLL is found in upstream's order: env override, then registry, then Program Files", () => {
  const reg = `D:\\okb-build\\bin\\${CAPI_DLL}`;
  const pf = `C:\\Program Files\\OpenKneeboard\\bin\\${CAPI_DLL}`;
  const env = { ProgramFiles: "C:\\Program Files" };

  assert.deepEqual(
    resolveCapiDll(lookup(["X:\\mine.dll", reg, pf], { ...env, OPENKNEEBOARD_CAPI_DLL: "X:\\mine.dll" }, "D:\\okb-build\\bin")),
    { ok: true, path: "X:\\mine.dll", source: "env" },
  );
  // The registry names whichever build launched last, which is how a self-built dev install wins.
  assert.deepEqual(resolveCapiDll(lookup([reg, pf], env, "D:\\okb-build\\bin\\")), { ok: true, path: reg, source: "registry" });
  assert.deepEqual(resolveCapiDll(lookup([pf], env)), { ok: true, path: pf, source: "program-files" });
  // A registry path whose build was deleted falls through rather than loading nothing, and says so:
  // the Program Files install may be older and speak an older IPC.
  assert.deepEqual(resolveCapiDll(lookup([pf], env, "D:\\gone")), {
    ok: true, path: pf, source: "program-files",
    skipped: `InstallationBinPath names D:\\gone\\${CAPI_DLL}, which does not exist`,
  });
});

test("a C API override that names a missing file is reported, never silently replaced", () => {
  const pf = `C:\\Program Files\\OpenKneeboard\\bin\\${CAPI_DLL}`;
  const found = resolveCapiDll(lookup([pf], { ProgramFiles: "C:\\Program Files", OPENKNEEBOARD_CAPI_DLL: "X:\\typo.dll" }));
  assert.equal(found.ok, false);
  assert.match((found as { reason: string }).reason, /typo\.dll/);
});

test("no DLL anywhere is a failure that says how to fix it", () => {
  const found = resolveCapiDll(lookup([], { ProgramFiles: "C:\\Program Files" }));
  assert.equal(found.ok, false);
  assert.match((found as { reason: string }).reason, /launch OpenKneeboard once|OPENKNEEBOARD_CAPI_DLL/);
});

test("a view toggle is its own message, naming the view", () => {
  const message = toggleVrViewVisibility(2);
  assert.equal(message.name, "ToggleVRViewVisibility");
  assert.deepEqual(JSON.parse(message.value), { Kneeboard: 2 });
});

test("an opacity step adds to both opacities, sending every field", () => {
  const message = setVrViewOpacity(1, -0.1);
  assert.equal(message.name, "SetVRViewOpacity");
  assert.deepEqual(JSON.parse(message.value), { Kneeboard: 1, Action: "Add", Target: "Both", Value: -0.1 });
});

test("an opacity preset sets both opacities, clamped before it reaches the wire", () => {
  assert.deepEqual(JSON.parse(setVrViewOpacityAbsolute(2, 1.5).value), {
    Kneeboard: 2,
    Action: "Set",
    Target: "Both",
    Value: 1,
  });
});
