import test from "node:test";
import assert from "node:assert/strict";
import {
  AXES,
  createProfileAsserter,
  encodePacket,
  isEmptyNudge,
  nudgeVrView,
  recenterVr,
  setTabByName,
  setViewOpacity,
  setViewOpacityAbsolute,
  toggleViewVisibility,
} from "../src/protocol.ts";

test("a manual profile selection always sends, while automatic assertions deduplicate", () => {
  const packets: string[] = [];
  const profiles = createProfileAsserter((packet) => { packets.push(packet); return true; });
  assert.equal(profiles.assert("Race"), true);
  assert.equal(profiles.assert("Race"), true);
  assert.equal(packets.length, 1);
  assert.equal(profiles.select("Race"), true);
  assert.equal(packets.length, 2);
  assert.deepEqual(JSON.parse(packets[1]!.split("!")[3]!), { Name: "Race" });
});

test("a failed manual profile selection can be retried", () => {
  let writes = 0;
  const profiles = createProfileAsserter(() => ++writes > 1);
  assert.equal(profiles.select("Race"), false);
  assert.equal(profiles.assert("Race"), true);
  assert.equal(writes, 2);
});

test("the recenter packet is byte-for-byte the documented literal", () => {
  // Probed against a running OpenKneeboard 1.12.10 on 2026-09-20: this exact string, written to
  // \\.\mailslot\com.openkneeboard.events.v1.3, is accepted as a 47-byte message.
  assert.equal(recenterVr(), "00000010!RemoteUserAction!0000000b!RECENTER_VR!");
  assert.equal(Buffer.byteLength(recenterVr(), "utf8"), 47);
});

test("the length prefix counts bytes, not characters", () => {
  // The C++ side reads std::string bytes. A title measured in JS characters would under-count any
  // multi-byte character and leave the reader parsing the remains of the field as a length.
  const packet = encodePacket("X", "é");
  assert.match(packet, /^00000001!X!00000002!é!$/u);

  const wrong = `00000001!X!${"é".length.toString(16).padStart(8, "0")}!é!`;
  assert.notEqual(packet, wrong, "a character count would produce 1 here, not 2");
});

test("the packet frames both fields with their own length", () => {
  assert.equal(encodePacket("ab", "cdef"), "00000002!ab!00000004!cdef!");
});

test("SetTabByName carries every field the non-sparse reader expects", () => {
  const value = JSON.parse(setTabByName("AMS2").split("!")[3]);
  assert.deepEqual(value, { Name: "AMS2", PageNumber: 0, Kneeboard: 0 });
});

test("a nudge omits untouched axes so a single dial sends a single key", () => {
  const payload = JSON.parse(nudgeVrView({ EyeY: -0.01 }).split("!")[3]);
  assert.deepEqual(payload, { Kneeboard: 0, EyeY: -0.01 });
  for (const axis of AXES) {
    if (axis !== "EyeY") assert.ok(!(axis in payload), `${axis} should be absent, not 0`);
  }
});

test("a nudge drops zeroed axes rather than sending a no-op move", () => {
  const payload = JSON.parse(nudgeVrView({ X: 0, RY: 0.5 }).split("!")[3]);
  assert.deepEqual(payload, { Kneeboard: 0, RY: 0.5 });
});

test("an all-zero nudge is reported as empty so the caller can skip the write", () => {
  assert.equal(isEmptyNudge({}), true);
  assert.equal(isEmptyNudge({ X: 0, RZ: 0 }), true);
  assert.equal(isEmptyNudge({ X: 0.001 }), false);
});

test("the nudge message name matches upstream OpenKneeboard", () => {
  // If upstream renames this during review the packet becomes silently inert — a write that
  // succeeds and moves nothing, which is exactly the failure this repo keeps shipping.
  assert.equal(nudgeVrView({ X: 1 }).split("!")[1], "NudgeVRView");
});

const valueOf = (packet: string): unknown => JSON.parse(packet.split("!")[3]!);
const nameOf = (packet: string): string => packet.split("!")[1]!;

test("a view toggle is its own message, naming the view", () => {
  const packet = toggleViewVisibility(2);
  assert.equal(nameOf(packet), "ToggleVRViewVisibility");
  assert.deepEqual(valueOf(packet), { Kneeboard: 2 });
});

test("an opacity step adds to both opacities, sending every field", () => {
  const packet = setViewOpacity(1, -0.1);
  assert.equal(nameOf(packet), "SetVRViewOpacity");
  assert.deepEqual(valueOf(packet), { Kneeboard: 1, Action: "Add", Target: "Both", Value: -0.1 });
});

test("an opacity preset sets both opacities, clamped before it reaches the wire", () => {
  assert.deepEqual(valueOf(setViewOpacityAbsolute(2, 1.5)), {
    Kneeboard: 2,
    Action: "Set",
    Target: "Both",
    Value: 1,
  });
});
