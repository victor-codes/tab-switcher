import { test } from "node:test";
import assert from "node:assert/strict";
import { createQueue, createStore, normalizeSettings, normalizeState, DEFAULT_SETTINGS } from "../extension/core/store.js";

function fakeArea(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(key) {
      return key in data ? { [key]: structuredClone(data[key]) } : {};
    },
    async set(obj) {
      Object.assign(data, structuredClone(obj));
    },
  };
}

test("load reports fresh when nothing is stored, round-trips after save", async () => {
  const area = fakeArea();
  const store = createStore(area);
  const first = await store.load();
  assert.equal(first.fresh, true);
  assert.deepEqual(first.state, { mru: { windows: {} }, session: null, icons: {} });
  first.state.mru = { windows: { 1: [3, 4] } };
  first.state.icons[3] = "https://a.example/i.png";
  await store.save(first.state);
  const second = await store.load();
  assert.equal(second.fresh, false);
  assert.deepEqual(second.state.mru, { windows: { 1: [3, 4] } });
  assert.equal(second.state.icons[3], "https://a.example/i.png");
});

test("load survives a failing storage area", async () => {
  const store = createStore({ get: async () => { throw new Error("boom"); }, set: async () => { throw new Error("boom"); } });
  const { state, fresh } = await store.load();
  assert.equal(fresh, true);
  assert.deepEqual(state.mru, { windows: {} });
  await store.save(state); // does not throw
});

test("normalizeState repairs junk", () => {
  const s = normalizeState({ mru: { windows: { 1: [1, "x"] } }, session: { nope: 1 }, icons: { 1: 5, 2: "ok" } });
  assert.deepEqual(s, { mru: { windows: { 1: [1] } }, session: null, icons: { 2: "ok" } });
  assert.equal(normalizeState({ session: { order: [1, 2] } }).session.expect.length, 0);
});

test("settings default when absent or invalid", async () => {
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
  const shortcuts = normalizeSettings(undefined).shortcuts;
  assert.deepEqual(normalizeSettings({ overlay: false, maxItems: 1, previews: "no" }), { overlay: false, previews: true, maxItems: 8, shortcuts });
  const store = createStore(fakeArea(), fakeArea({ settings: { overlay: false, maxItems: 5 } }));
  assert.deepEqual(await store.loadSettings(), { overlay: false, previews: true, maxItems: 5, shortcuts });
});

test("queue runs jobs one at a time in order and survives failures", async () => {
  const q = createQueue();
  const log = [];
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  q.enqueue(async () => { log.push("a1"); await delay(20); log.push("a2"); });
  const failed = q.enqueue(async () => { log.push("b"); throw new Error("expected test failure"); });
  const c = q.enqueue(() => { log.push("c"); return 42; });
  const origError = console.error;
  console.error = () => {};
  try {
    assert.equal(await failed, undefined);
    assert.equal(await c, 42);
    await q.idle();
  } finally {
    console.error = origError;
  }
  assert.deepEqual(log, ["a1", "a2", "b", "c"]);
});
