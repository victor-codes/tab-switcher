import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot, shouldPush, holdFor, THROTTLE_MS } from "../extension/core/snapshot.js";

const ICON = "data:image/png;base64,iVBORw0KGgo=";
const tabsById = new Map([
  [1, { title: "One", url: "https://one.example/a" }],
  [2, { title: "Two", url: "https://two.example/b" }],
  [3, { title: "Three" }],
]);
const base = {
  instance: "ab12",
  seq: 1,
  windowId: 7,
  focused: true,
  private: false,
  order: [2, 1, 3],
  tabsById,
  icons: { 1: ICON, 2: "not an icon" },
  previews: { 2: "data:image/jpeg;base64,QUJD" },
  settings: { maxItems: 8 },
};

test("buildSnapshot: shape, MRU order, hosts, icons and previews", () => {
  const s = buildSnapshot(base);
  assert.equal(s.v, 1);
  assert.deepEqual([s.instance, s.seq, s.windowId, s.focused, s.private], ["ab12", 1, 7, true, false]);
  assert.deepEqual(s.items.map((i) => i.tabId), [2, 1, 3]);
  assert.deepEqual(s.items[0], { tabId: 2, title: "Two", host: "two.example", icon: null, preview: "data:image/jpeg;base64,QUJD" });
  assert.equal(s.items[1].icon, ICON);
  assert.equal(s.items[2].host, "");
});

test("buildSnapshot: an empty tab list gives null", () => {
  assert.equal(buildSnapshot({ ...base, order: [] }), null);
  assert.equal(buildSnapshot({ ...base, tabsById: new Map() }), null);
});

test("buildSnapshot: a private window carries no icon or preview", () => {
  const s = buildSnapshot({ ...base, private: true });
  assert.equal(s.private, true);
  assert.ok(s.items.every((i) => i.icon === null && i.preview === null));
  assert.equal(s.items[0].title, "Two");
});

test("buildSnapshot: maxItems is respected", () => {
  const s = buildSnapshot({ ...base, settings: { maxItems: 2 } });
  assert.deepEqual(s.items.map((i) => i.tabId), [2, 1]);
});

test("shouldPush: never empty, never an identical repeat (seq ignored)", () => {
  const a = buildSnapshot(base);
  assert.equal(shouldPush(undefined, null, 1000, undefined), false);
  assert.equal(shouldPush(undefined, { ...a, items: [] }, 1000, undefined), false);
  assert.equal(shouldPush(undefined, a, 1000, undefined), true);
  assert.equal(shouldPush(a, { ...a, seq: 2 }, 5000, 1000), false);
  const changed = buildSnapshot({ ...base, order: [1, 2, 3], seq: 2 });
  assert.equal(shouldPush(a, changed, 5000, 1000), true);
  assert.equal(shouldPush(a, { ...a, focused: false }, 5000, 1000), true);
});

test("shouldPush: throttles to one push per window per 250 ms", () => {
  const a = buildSnapshot(base);
  const b = buildSnapshot({ ...base, order: [1, 2, 3], seq: 2 });
  assert.equal(shouldPush(a, b, 1000 + THROTTLE_MS - 1, 1000), false);
  assert.equal(shouldPush(a, b, 1000 + THROTTLE_MS, 1000), true);
  assert.equal(holdFor(1100, 1000), THROTTLE_MS - 100);
  assert.equal(holdFor(2000, 1000), 0);
  assert.equal(holdFor(2000, undefined), 0);
});
