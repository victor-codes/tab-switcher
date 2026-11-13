import { test } from "node:test";
import assert from "node:assert/strict";
import * as mru from "../extension/core/mru.js";

const W = 1;
const W2 = 2;

function build(windows) {
  return { windows: Object.fromEntries(Object.entries(windows).map(([k, v]) => [k, v.slice()])) };
}

test("activated moves the id to the front", () => {
  let s = build({ [W]: [1, 2, 3] });
  s = mru.activated(s, W, 3);
  assert.deepEqual(mru.list(s, W), [3, 1, 2]);
  s = mru.activated(s, W, 3);
  assert.deepEqual(mru.list(s, W), [3, 1, 2]);
  s = mru.activated(s, W, 9);
  assert.deepEqual(mru.list(s, W), [9, 3, 1, 2]);
});

test("activated in another window moves the tab there", () => {
  let s = build({ [W]: [1, 2], [W2]: [5] });
  s = mru.activated(s, W2, 2);
  assert.deepEqual(mru.list(s, W), [1]);
  assert.deepEqual(mru.list(s, W2), [2, 5]);
});

test("functions do not mutate their input", () => {
  const s = build({ [W]: [1, 2, 3] });
  const snapshot = JSON.stringify(s);
  mru.activated(s, W, 3);
  mru.removed(s, W, 1);
  mru.created(s, W, 4);
  mru.replaced(s, 2, 7);
  mru.windowRemoved(s, W);
  mru.seed(s, [{ id: 3, windowId: W, index: 0, active: true }]);
  assert.equal(JSON.stringify(s), snapshot);
});

test("created appends a background tab and never demotes a known one", () => {
  let s = build({ [W]: [1, 2] });
  s = mru.created(s, W, 3);
  assert.deepEqual(mru.list(s, W), [1, 2, 3]);
  s = mru.created(s, W, 1);
  assert.deepEqual(mru.list(s, W), [1, 2, 3]);
  s = mru.created(s, W2, 4);
  assert.deepEqual(mru.list(s, W2), [4]);
});

test("removed drops the id wherever it is and deletes empty windows", () => {
  let s = build({ [W]: [1, 2], [W2]: [3] });
  s = mru.removed(s, W, 2);
  assert.deepEqual(mru.list(s, W), [1]);
  s = mru.removed(s, 999, 3); // wrong window hint
  assert.deepEqual(mru.list(s, W2), []);
  assert.equal(Object.keys(s.windows).includes(String(W2)), false);
});

test("attach/detach moves a tab across windows", () => {
  let s = build({ [W]: [1, 2, 3], [W2]: [7] });
  s = mru.detached(s, W, 2);
  assert.deepEqual(mru.list(s, W), [1, 3]);
  s = mru.attached(s, W2, 2);
  assert.deepEqual(mru.list(s, W2), [7, 2]);
  // attach without a prior detach still removes it from the old window
  s = mru.attached(s, W, 7);
  assert.deepEqual(mru.list(s, W), [1, 3, 7]);
  assert.deepEqual(mru.list(s, W2), [2]);
  // attaching where it already is: no change
  assert.deepEqual(mru.list(mru.attached(s, W, 1), W), [1, 3, 7]);
});

test("replaced keeps the MRU position", () => {
  let s = build({ [W]: [1, 2, 3] });
  s = mru.replaced(s, 2, 20);
  assert.deepEqual(mru.list(s, W), [1, 20, 3]);
  // unknown old id: no-op
  assert.deepEqual(mru.list(mru.replaced(s, 99, 100), W), [1, 20, 3]);
});

test("extension-page sequence: create, create(-1), replace, remove", () => {
  let s = build({ [W]: [1, 2] });
  s = mru.activated(s, W, 3); // onCreated active:true counts as activation
  s = mru.created(s, -1, 4); // windowId -1: ignored
  assert.deepEqual(s.windows, { [W]: [3, 1, 2] });
  s = mru.replaced(s, 3, 4);
  s = mru.removed(s, W, 3);
  assert.deepEqual(mru.list(s, W), [4, 1, 2]);
});

test("replaced when the new id is already known elsewhere", () => {
  let s = build({ [W]: [1, 2, 3], [W2]: [4] });
  s = mru.replaced(s, 2, 4);
  assert.deepEqual(mru.list(s, W), [1, 4, 3]);
  assert.deepEqual(mru.list(s, W2), []);
});

test("windowRemoved forgets the window", () => {
  let s = build({ [W]: [1], [W2]: [2] });
  s = mru.windowRemoved(s, W);
  assert.deepEqual(s.windows, { [W2]: [2] });
});

test("seed: active first, then tab-strip order, per window; ignores windowId -1", () => {
  const tabs = [
    { id: 10, windowId: W, index: 0, active: false },
    { id: 11, windowId: W, index: 1, active: false },
    { id: 12, windowId: W, index: 2, active: true },
    { id: 20, windowId: W2, index: 1, active: false },
    { id: 21, windowId: W2, index: 0, active: true },
    { id: 30, windowId: -1, index: null, active: true },
  ];
  const s = mru.seed(mru.empty(), tabs);
  assert.deepEqual(mru.list(s, W), [12, 10, 11]);
  assert.deepEqual(mru.list(s, W2), [21, 20]);
  assert.deepEqual(Object.keys(s.windows).sort(), [String(W), String(W2)]);
});

test("seed keeps existing order for known ids and drops vanished tabs and windows", () => {
  const before = build({ [W]: [11, 13, 10, 99], 7: [70] });
  const tabs = [
    { id: 10, windowId: W, index: 0, active: false },
    { id: 11, windowId: W, index: 1, active: true },
    { id: 12, windowId: W, index: 2, active: false },
    { id: 13, windowId: W, index: 3, active: false },
  ];
  const s = mru.seed(before, tabs);
  assert.deepEqual(mru.list(s, W), [11, 13, 10, 12]);
  assert.deepEqual(mru.list(s, 7), []);
});

test("syncWindow drops vanished ids, appends new ones, never reorders", () => {
  const before = build({ [W]: [3, 1, 2, 9], [W2]: [4] });
  const tabs = [
    { id: 1, windowId: W, index: 0, active: false },
    { id: 2, windowId: W, index: 1, active: true },
    { id: 3, windowId: W, index: 2, active: false },
    { id: 4, windowId: W, index: 3, active: false },
    { id: 5, windowId: W, index: 4, active: false },
  ];
  const s = mru.syncWindow(before, W, tabs);
  assert.deepEqual(mru.list(s, W), [3, 1, 2, 4, 5]);
  assert.deepEqual(mru.list(s, W2), []);
});

test("unknown ids and malformed state never throw", () => {
  for (const bad of [undefined, null, {}, { windows: null }, { windows: { 1: "x", 2: [1, "a", -1, 2] } }]) {
    assert.doesNotThrow(() => {
      mru.activated(bad, W, 1);
      mru.removed(bad, W, 42);
      mru.detached(bad, W, 42);
      mru.attached(bad, W, 42);
      mru.replaced(bad, 42, 43);
      mru.windowRemoved(bad, 42);
      mru.list(bad, 42);
      mru.seed(bad, null);
      mru.syncWindow(bad, W, undefined);
    });
  }
  assert.deepEqual(mru.list({ windows: { 2: [1, "a", -1, 2] } }, 2), [1, 2]);
  assert.deepEqual(mru.activated(mru.empty(), -1, 5), mru.empty());
  assert.deepEqual(mru.removed(build({ [W]: [1] }), W, 42), build({ [W]: [1] }));
});

test("windowOf finds the window", () => {
  const s = build({ [W]: [1], [W2]: [2] });
  assert.equal(mru.windowOf(s, 2), W2);
  assert.equal(mru.windowOf(s, 3), null);
});
