import test from "node:test";
import assert from "node:assert/strict";
import { AXES, isEmptyNudge, nudgeVrView, type Axis } from "../src/protocol.ts";
import { placementFeedbackForAxis } from "../src/feedback.ts";
import {
  DEFAULT_VIEW_SIZE,
  MIN_VIEW_SIZE,
  DIAL_AXES,
  axisForDial,
  createPlacement,
  resetDelta,
  resize,
  rotate,
  stepFor,
  setTarget,
} from "../src/placement.ts";

test("positional nudge indices map to distinct degrees of freedom", () => {
  // The positive control the spec asks for: collapsing the map so every dial sends X must fail
  // here. Turning what you believe is X and actually moving brake bias is the failure the whole
  // placement-reference design exists to prevent, so the map is worth pinning.
  assert.deepEqual([...DIAL_AXES], ["X", "EyeY", "Z", "RX", "RY", "RZ"]);
  assert.equal(new Set(DIAL_AXES).size, DIAL_AXES.length, "no two positions may share an axis");
  assert.equal(DIAL_AXES.length, AXES.length);
});

test("dial feedback names the configured movement, including size", () => {
  assert.deepEqual(Array.from({ length: 6 }, (_, i) => placementFeedbackForAxis(i)?.title),
    ["Left/Right", "Up/Down", "Near/Far", "Pitch", "Yaw", "Roll"]);
  assert.equal(placementFeedbackForAxis(5, true)?.title, "Size",
    "Size overrides the physical dial column in the feedback");
});

test("size nudges preserve captured proportions and reset across page step sizes", () => {
  const base = { Width: 0.32, Height: 0.54 };
  const coarse = resize(createPlacement(), 10, base);
  assert.deepEqual(coarse.nudge, { MaxWidth: base.Width * 2 * 0.05, MaxHeight: base.Height * 2 * 0.05 });
  assert.equal(coarse.nudge.MaxWidth! / base.Width, coarse.nudge.MaxHeight! / base.Height);
  const fine = resize(coarse.state, -1, base);
  assert.ok(Math.abs(fine.nudge.MaxWidth! / base.Width + 0.01) < 1e-12);
  const packet = JSON.parse(nudgeVrView(fine.nudge, fine.state.target).split("!")[3]!);
  assert.deepEqual(packet, { Kneeboard: fine.state.target, ...fine.nudge });
  const reset = resetDelta(fine.state);
  assert.ok(Math.abs(reset.nudge.MaxWidth! + coarse.nudge.MaxWidth! + fine.nudge.MaxWidth!) < 1e-12);
  assert.ok(Math.abs(reset.nudge.MaxHeight! + coarse.nudge.MaxHeight! + fine.nudge.MaxHeight!) < 1e-12);
  assert.equal(isEmptyNudge(resetDelta(reset.state).nudge), true);
});

test("size nudges stop at OpenKneeboard's minimum without losing reset", () => {
  const base = DEFAULT_VIEW_SIZE;
  const shrunk = resize(createPlacement(), -1000, base);
  assert.ok(Math.abs(base.Width + shrunk.nudge.MaxWidth! - MIN_VIEW_SIZE) < 1e-12);
  assert.ok(base.Height + shrunk.nudge.MaxHeight! >= MIN_VIEW_SIZE - 1e-12);
  assert.equal(isEmptyNudge(resize(shrunk.state, -1, base).nudge), true);
  const restored = resetDelta(shrunk.state);
  assert.ok(Math.abs(restored.nudge.MaxWidth! + shrunk.nudge.MaxWidth!) < 1e-12);
  assert.deepEqual(resize(createPlacement(), 1, { Width: -1, Height: 0.25 }).nudge, {});
});

test("a dial index the hardware cannot produce yields no packet rather than driving X", () => {
  assert.equal(axisForDial(6), undefined);
  const { nudge, state } = rotate(createPlacement(), 6, 3);
  assert.equal(isEmptyNudge(nudge), true);
  assert.deepEqual(state.accumulated, createPlacement().accumulated);
});

test("step sizes are 1mm/0.5° fine and 1cm/5° coarse, translations and rotations apart", () => {
  assert.equal(stepFor("X", "fine"), 0.001);
  assert.equal(stepFor("X", "coarse"), 0.01);
  assert.ok(Math.abs(stepFor("RY", "fine") - (0.5 * Math.PI) / 180) < 1e-12);
  assert.ok(Math.abs(stepFor("RY", "coarse") - (5 * Math.PI) / 180) < 1e-12);
  // A rotation stepping by the translation figure would be 0.001 radians — silently 8x too fine.
  assert.notEqual(stepFor("RY", "fine"), stepFor("X", "fine"));
});

test("a turn emits one axis scaled by the live step, and several ticks scale with it", () => {
  const fine = createPlacement();
  const one = rotate(fine, 1, 1);
  assert.deepEqual(one.nudge, { EyeY: 0.001 });

  const three = rotate(fine, 1, -3);
  assert.deepEqual(three.nudge, { EyeY: -0.003 });
});

test("reset sends the exact inverse of everything this session moved, then forgets it", () => {
  let state = createPlacement();
  state = rotate(state, 0, 40).state;  // X coarse: 4 detents × 10 ticks
  state = rotate(state, 4, -2).state;  // RY fine   -2 * 0.5deg
  state = rotate(state, 0, 1).state;   // X fine    +0.001

  const { nudge, state: after } = resetDelta(state);
  assert.ok(Math.abs((nudge.X ?? 0) + (0.04 + 0.001)) < 1e-12, "X inverse");
  assert.ok(Math.abs((nudge.RY ?? 0) - 2 * ((0.5 * Math.PI) / 180)) < 1e-12, "RY inverse");
  for (const axis of ["EyeY", "Z", "RX", "RZ"] as Axis[]) {
    assert.ok(!(axis in nudge), `${axis} never moved, so reset must not mention it`);
  }

  // Reset twice must be a no-op, not a second inverse that moves the panel away from where the
  // first one put it.
  assert.equal(isEmptyNudge(resetDelta(after).nudge), true);
});

test("reset with nothing moved is empty rather than a packet full of zeroes", () => {
  assert.equal(isEmptyNudge(resetDelta(createPlacement()).nudge), true);
});

test("rotate does not mutate the state it was handed", () => {
  const start = createPlacement();
  rotate(start, 0, 10);
  assert.deepEqual(start.accumulated, {}, "the accumulator must be replaced, not mutated in place");
});

test("each view keeps its own accumulator, so reset undoes only the panel you are on", () => {
  // With a deck map and a wheel reference in their own places, one shared accumulator would make
  // Reset push whichever panel you are looking at by the OTHER one's offset.
  let state = createPlacement();
  state = rotate(state, 0, 40).state;           // view 1, X +0.04
  state = setTarget(state, 2);
  state = rotate(state, 1, -20).state;          // view 2, EyeY -0.02

  const onTwo = resetDelta(state);
  assert.ok(Math.abs((onTwo.nudge.EyeY ?? 0) - 0.02) < 1e-12, "reset view 2's EyeY");
  assert.ok(!("X" in onTwo.nudge), "view 1's X must not be touched while resetting view 2");

  // Back to view 1: its offset survived the detour.
  const onOne = resetDelta(setTarget(onTwo.state, 1));
  assert.ok(Math.abs((onOne.nudge.X ?? 0) + 0.04) < 1e-12, "view 1's offset was still remembered");
});

test("switching target and back does not lose what was already applied", () => {
  let state = createPlacement();
  state = rotate(state, 0, 30).state;
  const before = JSON.stringify(state.accumulated);
  state = setTarget(setTarget(state, 2), 1);
  assert.equal(JSON.stringify(state.accumulated), before, "a detour must not clear the accumulator");
  assert.equal(state.target, 1);
});
