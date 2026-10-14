import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, "../com.willvoorhees.kneeboard-streamdeck.sdPlugin/ui/configure.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (!script) throw new Error("property inspector script missing");

type AxisUi = {
  axes: [string, string][];
  selectedAxis: (settings: { dialIndex?: number; size?: boolean }) => string;
  writeAxisSelection: (settings: { dialIndex?: number; size?: boolean }, choice: string) => void;
};

const ui = vm.runInNewContext(`${script}\n({ axes, selectedAxis, writeAxisSelection })`, {
  document: { getElementById: () => ({ addEventListener: () => {} }) },
  window: {},
}) as AxisUi;

test("the placement menu uses the button legend names and offers Size as a choice", () => {
  assert.deepEqual(Array.from(ui.axes, ([value, label]) => [value, label]), [
    ["", "Device default"], ["0", "Left/Right"], ["1", "Up/Down"], ["2", "Near/Far"],
    ["3", "Pitch"], ["4", "Yaw"], ["5", "Roll"], ["size", "Size"],
  ]);
});

test("old axis and size settings select the right menu item and save without stale fields", () => {
  assert.equal(ui.selectedAxis({ dialIndex: 4 }), "4");
  assert.equal(ui.selectedAxis({ dialIndex: 1, size: true }), "size");
  assert.equal(ui.selectedAxis({}), "");

  const saved = { dialIndex: 1, size: true, direction: -1 };
  ui.writeAxisSelection(saved, "4");
  assert.deepEqual({ ...saved }, { dialIndex: 4, direction: -1 });
  ui.writeAxisSelection(saved, "size");
  assert.deepEqual({ ...saved }, { size: true, direction: -1 });
  ui.writeAxisSelection(saved, "");
  assert.deepEqual({ ...saved }, { direction: -1 });
});
