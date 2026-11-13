import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SHORTCUTS, normalizeShortcut, normalizeShortcuts, holdModifiers, pairProblem, shortcutParts, shortcutSpoken, fromKeyEvent,
} from "../extension/core/shortcuts.js";

test("defaults are Control-Tab and Control-Shift-Tab, holding Control", () => {
  assert.deepEqual(shortcutParts(DEFAULT_SHORTCUTS.next), ["⌃", "⇥"]);
  assert.deepEqual(shortcutParts(DEFAULT_SHORTCUTS.prev), ["⌃", "⇧", "⇥"]);
  assert.deepEqual(holdModifiers(DEFAULT_SHORTCUTS.next, DEFAULT_SHORTCUTS.prev), ["Control"]);
  assert.equal(shortcutSpoken(DEFAULT_SHORTCUTS.prev), "Control Shift Tab");
});

test("a shortcut needs Control, Option or Command and a non-reserved key", () => {
  assert.equal(normalizeShortcut({ shift: true, code: "KeyA" }), null);
  assert.equal(normalizeShortcut({ ctrl: true, code: "Escape" }), null);
  assert.equal(normalizeShortcut({ ctrl: true, code: "ArrowLeft" }), null);
  assert.deepEqual(normalizeShortcut({ alt: true, code: "KeyJ", junk: 1 }), { ctrl: false, alt: true, shift: false, meta: false, code: "KeyJ" });
});

test("pairs must differ and share a held modifier other than Shift", () => {
  const a = { ctrl: true, alt: false, shift: false, meta: false, code: "KeyJ" };
  assert.match(pairProblem(a, { ...a }), /same/);
  assert.match(pairProblem(a, { ...a, ctrl: false, alt: true }), /share/);
  assert.equal(pairProblem(a, { ...a, code: "KeyK" }), "");
  assert.deepEqual(normalizeShortcuts({ next: a, prev: a }), { next: { ...DEFAULT_SHORTCUTS.next }, prev: { ...DEFAULT_SHORTCUTS.prev } });
  assert.deepEqual(normalizeShortcuts({ next: a, prev: { ...a, shift: true } }).prev.shift, true);
});

test("fromKeyEvent ignores modifier-only presses and labels keys", () => {
  assert.equal(fromKeyEvent({ code: "ControlLeft", ctrlKey: true }), null);
  const s = fromKeyEvent({ code: "Backquote", altKey: true });
  assert.deepEqual(shortcutParts(s), ["⌥", "`"]);
  assert.deepEqual(shortcutParts({ meta: true, code: "Digit1" }), ["⌘", "1"]);
});
