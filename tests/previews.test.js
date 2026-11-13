// Tests for extension/core/previews.js: pure decisions plus the storage-backed service
// with injected fakes (no image decoding in node: `encode` is stubbed).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  captureDecision,
  evict,
  pruneIndex,
  normalizeIndex,
  cropRect,
  previewKey,
  tabIdOfKey,
  isPreviewDataUrl,
  createPreviews,
  MAX_PREVIEWS,
  MIN_INTERVAL_MS,
  INDEX_KEY,
} from "../extension/core/previews.js";

const TAB = { id: 5, windowId: 1, active: true, url: "https://a.example/", status: "complete", incognito: false };
const ON = { previews: true };

test("captureDecision: eligible tab", () => {
  assert.deepEqual(captureDecision(TAB, { settings: ON, now: 10_000 }), { ok: true });
});

test("captureDecision: every refusal reason", () => {
  const cases = [
    [TAB, { settings: { previews: false } }, "disabled"],
    [null, {}, "notab"],
    [{ ...TAB, id: -1 }, {}, "notab"],
    [{ ...TAB, incognito: true }, {}, "incognito"],
    [{ ...TAB, active: false }, {}, "inactive"],
    [{ ...TAB, url: undefined }, {}, "nourl"],
    [{ ...TAB, url: "" }, {}, "nourl"],
    [{ ...TAB, status: "loading" }, {}, "loading"],
    [{ ...TAB, status: undefined }, {}, "loading"],
    [TAB, { sessionActive: true }, "session"],
  ];
  for (const [tab, ctx, reason] of cases) {
    assert.deepEqual(captureDecision(tab, { settings: ON, now: 10_000, ...ctx }), { ok: false, reason }, reason);
  }
});

test("captureDecision: throttles to one capture per tab per 5 s", () => {
  const now = 100_000;
  assert.equal(captureDecision(TAB, { settings: ON, now, lastAt: now - 1 }).reason, "throttled");
  assert.equal(captureDecision(TAB, { settings: ON, now, lastAt: now - MIN_INTERVAL_MS + 1 }).reason, "throttled");
  assert.equal(captureDecision(TAB, { settings: ON, now, lastAt: now - MIN_INTERVAL_MS }).ok, true);
  assert.equal(captureDecision(TAB, { settings: ON, now, lastAt: undefined }).ok, true);
  // A clock that went backwards (lastAt in the future) never blocks forever.
  assert.equal(captureDecision(TAB, { settings: ON, now, lastAt: now + 60_000 }).ok, true);
});

test("evict keeps the most recently captured entries", () => {
  const index = {};
  for (let i = 0; i < 65; i++) index[i] = 1000 + i; // tab i captured at 1000 + i
  const r = evict(index, MAX_PREVIEWS);
  assert.equal(Object.keys(r.index).length, 60);
  assert.deepEqual(r.drop.sort((a, b) => a - b), [0, 1, 2, 3, 4]);
  assert.equal(r.index[64], 1064);
  assert.equal(index[0], 1000, "input not mutated");
  assert.deepEqual(evict({ 1: 5, 2: 6 }, 60).drop, []);
  assert.deepEqual(evict({ 1: 5, 2: 6, 3: 4 }, 1), { index: { 2: 6 }, drop: [1, 3] });
});

test("pruneIndex drops ids that no longer exist", () => {
  assert.deepEqual(pruneIndex({ 1: 1, 2: 2, 3: 3 }, [3, 1, 99]), { index: { 1: 1, 3: 3 }, drop: [2] });
  assert.deepEqual(pruneIndex({ 1: 1 }, []), { index: {}, drop: [1] });
});

test("normalizeIndex, keys and data URL checks", () => {
  assert.deepEqual(normalizeIndex({ 1: 5, x: 3, 2: "7", 3: NaN }), { 1: 5 });
  assert.deepEqual(normalizeIndex(null), {});
  assert.equal(previewKey(12), "preview:12");
  assert.equal(tabIdOfKey("preview:12"), 12);
  assert.equal(tabIdOfKey("preview:x"), null);
  assert.equal(tabIdOfKey("state"), null);
  assert.equal(isPreviewDataUrl("data:image/jpeg;base64,AAAA"), true);
  assert.equal(isPreviewDataUrl("https://example.com/a.jpg"), false);
  assert.equal(isPreviewDataUrl("data:text/html;base64,AAAA"), false);
});

test("cropRect keeps the top 16:10 and never upscales", () => {
  assert.deepEqual(cropRect(2071, 1047, 480), { sx: 0, sy: 0, sw: 2071, sh: 1047, dw: 480, dh: 243 });
  assert.deepEqual(cropRect(1600, 2000, 480), { sx: 0, sy: 0, sw: 1600, sh: 1000, dw: 480, dh: 300 });
  assert.deepEqual(cropRect(300, 100, 480), { sx: 0, sy: 0, sw: 300, sh: 100, dw: 300, dh: 100 });
});

// ---------------------------------------------------------------------------
// Service with fakes

function fakeArea(data = {}) {
  return {
    data,
    gets: [],
    async get(key) {
      this.gets.push(key);
      const keys = key === null ? Object.keys(data) : Array.isArray(key) ? key : [key];
      const out = {};
      for (const k of keys) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(obj) {
      Object.assign(data, structuredClone(obj));
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    },
  };
}

function fakeTabs(tabs) {
  const t = {
    list: tabs.map((x) => ({ ...x })),
    captures: 0,
    async get(id) {
      const tab = t.list.find((x) => x.id === id);
      if (!tab) throw new Error("no tab");
      return { ...tab };
    },
    async query({ active, windowId }) {
      return t.list.filter((x) => (active === undefined || x.active === active) && (windowId === undefined || x.windowId === windowId));
    },
    async captureVisibleTab() {
      t.captures++;
      return "data:image/jpeg;base64,RAW";
    },
  };
  return t;
}

function service({ area = fakeArea(), tabs = fakeTabs([TAB]), settings = ON, session = false, clock = { t: 100_000 }, timers } = {}) {
  const deps = {
    area,
    tabs,
    loadSettings: async () => settings,
    isSessionActive: async () => (typeof session === "function" ? session() : session),
    now: () => clock.t,
    encode: async () => "data:image/jpeg;base64,SMALL",
  };
  if (timers) {
    deps.setTimer = (fn, ms) => {
      const h = { fn, ms };
      timers.push(h);
      return h;
    };
    deps.clearTimer = (h) => {
      const i = timers.indexOf(h);
      if (i !== -1) timers.splice(i, 1);
    };
  }
  return { s: createPreviews(deps), area, tabs, clock };
}

test("captureNow stores { dataUrl, at } and the index; throttles a second capture", async () => {
  const { s, area, tabs, clock } = service();
  assert.equal(await s.captureNow(5), "ok");
  assert.deepEqual(area.data["preview:5"], { dataUrl: "data:image/jpeg;base64,SMALL", at: 100_000 });
  assert.deepEqual(area.data[INDEX_KEY], { 5: 100_000 });
  clock.t += 1000;
  assert.equal(await s.captureNow(5), "throttled");
  assert.equal(tabs.captures, 1);
  clock.t += MIN_INTERVAL_MS;
  assert.equal(await s.captureNow(5), "ok");
  assert.equal(tabs.captures, 2);
});

test("captureNow refuses private tabs, disabled setting and running sessions without capturing", async () => {
  for (const [opts, reason] of [
    [{ tabs: fakeTabs([{ ...TAB, incognito: true }]) }, "incognito"],
    [{ settings: { previews: false } }, "disabled"],
    [{ session: true }, "session"],
    [{ tabs: fakeTabs([{ ...TAB, url: undefined }]) }, "nourl"],
    [{ tabs: fakeTabs([{ ...TAB, status: "loading" }]) }, "loading"],
  ]) {
    const { s, area, tabs } = service(opts);
    assert.equal(await s.captureNow(5), reason);
    assert.equal(tabs.captures, 0, reason);
    assert.equal(area.data["preview:5"], undefined, reason);
  }
});

test("captureNow discards the image if a session started or the tab changed during capture", async () => {
  let calls = 0;
  const one = service({ session: () => ++calls > 1 }); // false before, true after
  assert.equal(await one.s.captureNow(5), "session");
  assert.equal(one.area.data["preview:5"], undefined);

  const tabs = fakeTabs([TAB, { ...TAB, id: 6, active: false }]);
  const cap = tabs.captureVisibleTab;
  tabs.captureVisibleTab = async () => {
    tabs.list[0].active = false;
    tabs.list[1].active = true; // the user switched meanwhile
    return cap();
  };
  const two = service({ tabs });
  assert.equal(await two.s.captureNow(5), "inactive");
  assert.equal(two.area.data["preview:5"], undefined);
});

test("storing the 61st preview evicts the least recently captured", async () => {
  const data = { [INDEX_KEY]: {} };
  for (let i = 100; i < 160; i++) {
    data[previewKey(i)] = { dataUrl: "data:image/jpeg;base64,OLD", at: i };
    data[INDEX_KEY][i] = i;
  }
  const { s, area } = service({ area: fakeArea(data) });
  assert.equal(await s.captureNow(5), "ok");
  assert.equal(Object.keys(area.data[INDEX_KEY]).length, 60);
  assert.equal(area.data["preview:100"], undefined, "oldest evicted");
  assert.ok(area.data["preview:101"]);
  assert.ok(area.data["preview:5"]);
});

test("getMany reads every preview in one storage call; budget falls back to {}", async () => {
  const area = fakeArea({
    "preview:1": { dataUrl: "data:image/jpeg;base64,AAA", at: 1 },
    "preview:3": { dataUrl: "https://evil.example/x.jpg", at: 1 },
  });
  const { s } = service({ area });
  area.gets.length = 0;
  assert.deepEqual(await s.getMany([1, 2, 3]), { 1: "data:image/jpeg;base64,AAA" });
  assert.deepEqual(area.gets, [["preview:1", "preview:2", "preview:3"]]);
  assert.equal(await s.get(1), "data:image/jpeg;base64,AAA");
  assert.equal(await s.get(2), null);

  const slow = fakeArea({ "preview:1": { dataUrl: "data:image/jpeg;base64,AAA", at: 1 } });
  slow.get = () => new Promise((r) => setTimeout(() => r({}), 200));
  const t0 = Date.now();
  assert.deepEqual(await service({ area: slow }).s.getMany([1], { budgetMs: 20 }), {});
  assert.ok(Date.now() - t0 < 150);
});

test("remove, prune and clearAll", async () => {
  const area = fakeArea({
    "preview:1": { dataUrl: "data:image/jpeg;base64,A", at: 1 },
    "preview:2": { dataUrl: "data:image/jpeg;base64,B", at: 2 },
    "preview:3": { dataUrl: "data:image/jpeg;base64,C", at: 3 }, // not in the index
    [INDEX_KEY]: { 1: 1, 2: 2 },
    state: { keep: true },
  });
  const { s } = service({ area });
  await s.remove(1);
  assert.equal(area.data["preview:1"], undefined);
  assert.deepEqual(area.data[INDEX_KEY], { 2: 2 });
  assert.equal(await s.prune([2]), 1);
  assert.equal(area.data["preview:3"], undefined);
  assert.ok(area.data["preview:2"]);
  assert.equal(await s.clearAll(), 1);
  assert.deepEqual(Object.keys(area.data), ["state"]);
});

test("clearAll rejects when storage fails (so data:clear can report it)", async () => {
  const area = fakeArea({ "preview:1": { dataUrl: "data:image/jpeg;base64,A", at: 1 } });
  area.remove = async () => {
    throw new Error("nope");
  };
  await assert.rejects(service({ area }).s.clearAll(), /nope/);
});

test("schedule debounces per window and retries after a session", async () => {
  const timers = [];
  let active = true;
  const { s, tabs } = service({ timers, session: () => active });
  s.schedule(5, 1);
  s.schedule(5, 1);
  s.schedule(6, 2);
  assert.equal(timers.length, 2, "one pending capture per window");
  assert.equal(timers[0].ms, 600);
  await timers.shift().fn(); // window 1: session running -> skipped, retry scheduled
  assert.equal(tabs.captures, 0);
  const retry = timers.find((t) => t.ms === 1200);
  assert.ok(retry, "retry scheduled");
  active = false;
  timers.splice(timers.indexOf(retry), 1);
  await retry.fn();
  assert.equal(tabs.captures, 1);
  s.cancelAll();
  assert.equal(timers.length, 0);
});
