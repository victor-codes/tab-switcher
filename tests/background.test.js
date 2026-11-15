// End-to-end wiring tests for extension/background.js against a small fake `browser`.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const realNow = Date.now;
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;

afterEach(() => {
  clockOffset = 0;
});

function event() {
  const listeners = [];
  return {
    listeners,
    addListener(fn) {
      listeners.push(fn);
    },
    fire(...args) {
      return listeners.map((fn) => fn(...args));
    },
  };
}

function area(shared = {}) {
  return {
    data: shared,
    async get(key) {
      const keys = key === null || key === undefined ? Object.keys(shared) : Array.isArray(key) ? key : [key];
      const out = {};
      for (const k of keys) if (k in shared) out[k] = structuredClone(shared[k]);
      return out;
    },
    async set(obj) {
      Object.assign(shared, structuredClone(obj));
    },
    async remove(key) {
      for (const k of Array.isArray(key) ? key : [key]) delete shared[k];
    },
  };
}

const EXT_BASE = "safari-web-extension://tabswitcher-uuid/";
const ICON_A = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/**
 * Fake Safari. `tabs`: [{ id, windowId, title, url, active }] in tab-strip order.
 * `content`: { [tabId]: (msg) => reply | "reject" | "hang" } — tabs without an entry have
 * no content script and answer sendMessage with undefined, as measured.
 */
function fakeBrowser({ tabs, content = {}, sessionData = {}, localData = {}, app, inject, deadMessaging = false }) {
  const b = {
    _tabs: tabs.map((t) => ({ ...t })),
    _focused: tabs[0]?.windowId ?? 1,
    _sent: [],
    _pings: [],
    _injected: [],
    _direct: {}, // tabId -> the loaded switcher's direct entry (__tabSwitcherDeliver)
    _directSent: [],
    _ports: [],
    _helper: { onMessage: event(), onDisconnect: event() },
    _content: content,
    storage: { session: area(sessionData), local: area(localData), onChanged: event() },
    runtime: {
      id: "tabswitcher",
      getURL: (p) => EXT_BASE + p,
      onStartup: event(),
      onInstalled: event(),
      onMessage: event(),
      ...(app ? { sendNativeMessage: async (_id, msg) => (msg?.type === "log" ? ((app.logs ??= []).push(msg), { ok: true }) : msg?.type === "snapshot:push" ? ((app.pushes ??= []).push(msg.snapshot), { delivered: true }) : (app.calls.push(msg), app.reply())) } : {}),
      connectNative(id) {
        b._ports.push(id);
        return b._helper;
      },
    },
    windows: { onRemoved: event(), onFocusChanged: event() },
    // `inject`: (tabId) => content handler for the freshly loaded script, or throws where
    // Safari allows no script. Without it there is no scripting API (as before).
    ...(inject
      ? {
          scripting: {
            // With `files`: load the switcher. With `func`: call into the page, which reaches
            // the switcher's direct entry if one is loaded. `deadMessaging` models a page
            // open since before an update: code runs there, messages never arrive.
            async executeScript({ target, files, func, args }) {
              if (func) {
                const h = b._direct[target.tabId];
                if (h && args[0]?.type !== "switcher:ping") b._directSent.push({ tabId: target.tabId, msg: args[0] });
                return [{ frameId: 0, result: h ? h(args[0]) : null }];
              }
              b._injected.push({ tabId: target.tabId, files });
              const h = inject(target.tabId);
              b._direct[target.tabId] = h;
              if (!deadMessaging) b._content[target.tabId] = h;
              return [{ frameId: 0, result: null }];
            },
          },
        }
      : {}),
    tabs: {
      onActivated: event(),
      onUpdated: event(),
      onCreated: event(),
      onRemoved: event(),
      onReplaced: event(),
      onAttached: event(),
      onDetached: event(),
      async query(q = {}) {
        let list = b._tabs;
        if (q.windowId !== undefined) list = list.filter((t) => t.windowId === q.windowId);
        if (q.currentWindow) list = list.filter((t) => t.windowId === b._focused);
        if (q.active) list = list.filter((t) => t.active);
        return list.map((t) => ({ ...t, index: b._tabs.filter((x) => x.windowId === t.windowId).indexOf(t) }));
      },
      async update(tabId, props) {
        const tab = b._tabs.find((t) => t.id === tabId);
        if (!tab) throw new Error("no tab " + tabId);
        if (props.active && !tab.active) b._activate(tab);
        return { ...tab };
      },
      async remove(tabId) {
        const tab = b._tabs.find((t) => t.id === tabId);
        if (!tab) throw new Error("no tab " + tabId);
        const siblings = b._tabs.filter((t) => t.windowId === tab.windowId);
        const i = siblings.indexOf(tab);
        b._tabs = b._tabs.filter((t) => t !== tab);
        setTimeout(() => b.tabs.onRemoved.fire(tabId, { windowId: tab.windowId, isWindowClosing: false }), 0);
        if (tab.active) {
          // Safari's own choice: the neighbour.
          const left = b._tabs.filter((t) => t.windowId === tab.windowId);
          const next = left[i] ?? left[i - 1];
          if (next) b._activate(next);
        }
      },
      async sendMessage(tabId, msg) {
        // The background's "is the switcher alive here?" check is kept out of _sent.
        // A page with a content script answers it; the test's handler never sees it.
        if (msg?.type === "switcher:ping") {
          b._pings.push(tabId);
          return b._content[tabId] ? { ok: true } : undefined;
        }
        b._sent.push({ tabId, msg });
        const h = b._content[tabId];
        if (!h) return undefined;
        const r = h(msg);
        if (r === "reject") throw new Error("Could not establish connection");
        if (r === "hang") return new Promise(() => {});
        return r;
      },
    },
    _activate(tab) {
      for (const t of b._tabs) if (t.windowId === tab.windowId) t.active = t === tab;
      // Safari delivers onActivated asynchronously.
      setTimeout(() => b.tabs.onActivated.fire({ tabId: tab.id, windowId: tab.windowId }), 0);
    },
    activeId(windowId = b._focused) {
      return b._tabs.find((t) => t.windowId === windowId && t.active)?.id;
    },
    tab(id) {
      return { ...b._tabs.find((t) => t.id === id) };
    },
    /** The app: a shortcut press (dir 1 = next, -1 = previous). */
    press(dir = 1) {
      b._helper.onMessage.fire({ name: "flip", userInfo: { dir } });
    },
    /** The app: the held modifier was let go. */
    release() {
      b._helper.onMessage.fire({ name: "release", userInfo: {} });
    },
    message(msg, fromTabId) {
      b.runtime.onMessage.fire(msg, { id: "tabswitcher", tab: b.tab(fromTabId) });
    },
    mru(windowId = 1) {
      return sessionData.state?.mru?.windows?.[windowId] ?? [];
    },
    session() {
      return sessionData.state?.session ?? null;
    },
  };
  return b;
}

let loads = 0;
async function boot(browser) {
  globalThis.browser = browser;
  const bg = await import(`../extension/background.js?boot=${++loads}`);
  return {
    bg,
    async settle() {
      for (let i = 0; i < 4; i++) {
        await bg.whenIdle();
        await sleep(3);
      }
      await bg.whenIdle();
    },
  };
}

function threeTabs(extra = {}) {
  return [
    { id: 1, windowId: 1, title: "One", url: "https://one.example/a", active: true },
    { id: 2, windowId: 1, title: "Two", url: "https://two.example/b", active: false },
    { id: 3, windowId: 1, title: "Three", active: false, ...extra }, // no url (empty tab)
  ];
}

test("registers every listener synchronously at load", async () => {
  const b = fakeBrowser({ tabs: threeTabs() });
  await boot(b);
  for (const ev of [
    b._helper.onMessage, b.tabs.onActivated, b.tabs.onCreated, b.tabs.onRemoved, b.tabs.onReplaced,
    b.tabs.onAttached, b.tabs.onDetached, b.windows.onRemoved, b.windows.onFocusChanged,
    b.runtime.onStartup, b.runtime.onInstalled, b.runtime.onMessage,
    b.tabs.onUpdated, b.storage.onChanged,
  ]) {
    assert.equal(ev.listeners.length, 1);
  }
});

test("fallback (no content script): flip A->B, then A again after the idle window (lazy expiry)", async () => {
  const b = fakeBrowser({ tabs: threeTabs() });
  const { settle } = await boot(b);
  b.press();
  await settle();
  assert.equal(b.activeId(), 2);
  assert.equal(b.session().mode, "fallback");
  assert.deepEqual(b.mru(), [1, 2, 3], "not promoted during the session");
  assert.deepEqual(b._sent.map((s) => s.msg.type), ["switcher:show"]);

  clockOffset += 5000; // the idle timer is irrelevant now: lazy expiry handles it
  b.press();
  await settle();
  assert.equal(b.activeId(), 1);
  assert.deepEqual(b.session().order, [2, 1, 3]);
});

test("the helper's port: a press opens the switcher and release commits", async () => {
  const content = { 1: (msg) => (msg.type === "switcher:show" ? { ok: true, hasFocus: true, modifiersHeld: true } : undefined) };
  const b = fakeBrowser({ tabs: threeTabs(), content });
  const { settle } = await boot(b);
  assert.deepEqual(b._ports, ["application.id"], "connects once at load");
  b.press();
  await settle();
  assert.equal(b.session().mode, "overlay");
  b.press(-1); // back to the oldest shown
  await settle();
  assert.equal(b.session().index, 0);
  b.press();
  b.press();
  await settle();
  b.release();
  await settle();
  assert.equal(b.session(), null);
  assert.equal(b.activeId(), 3);
  assert.deepEqual(b._sent.map((s) => s.msg.type).at(-1), "switcher:hide");
});

test("fallback: the 1000 ms idle timer ends the session and promotes the final tab", async () => {
  const b = fakeBrowser({ tabs: threeTabs() });
  const { settle } = await boot(b);
  b.press();
  await settle();
  b.press();
  await settle();
  assert.equal(b.activeId(), 3);
  assert.deepEqual(b.mru(), [1, 2, 3]);
  await sleep(1100);
  await settle();
  assert.equal(b.session(), null);
  assert.deepEqual(b.mru(), [3, 1, 2]);
});

test("overlay: show items, move, commit from the content script", async () => {
  const replies = [];
  const content = {
    1: (msg) => {
      replies.push(msg);
      if (msg.type === "switcher:show") return { ok: true, hasFocus: true, modifiersHeld: true };
      return { ok: true };
    },
  };
  const b = fakeBrowser({ tabs: threeTabs(), content });
  const { settle } = await boot(b);
  await settle();
  b.message({ type: "page:meta", icon: ICON_A }, 2);
  await settle();
  b.press();
  await settle();
  const show = replies[0];
  assert.equal(show.type, "switcher:show");
  assert.equal(show.selectedIndex, 1);
  assert.deepEqual(show.modifiers, ["Control"]);
  assert.deepEqual(show.items, [
    { tabId: 1, title: "One", host: "one.example", icon: null, preview: null },
    { tabId: 2, title: "Two", host: "two.example", icon: ICON_A, preview: null },
    { tabId: 3, title: "Three", host: "", icon: null, preview: null },
  ]);
  assert.equal(b.activeId(), 1, "overlay mode does not switch yet");
  b.press();
  await settle();
  assert.deepEqual(replies[1], { type: "switcher:move", selectedIndex: 2 });
  b.message({ type: "switcher:commit", tabId: 3 }, 1);
  await settle();
  assert.equal(b.activeId(), 3);
  assert.equal(b.session(), null);
  assert.deepEqual(b.mru(), [3, 1, 2]);
});

test("quick tap with a content script commits at once and F1 returns", async () => {
  const content = {
    1: (m) => (m.type === "switcher:show" ? { ok: true, hasFocus: true, modifiersHeld: false } : { ok: true }),
    2: (m) => (m.type === "switcher:show" ? { ok: true, hasFocus: true, modifiersHeld: false } : { ok: true }),
  };
  const b = fakeBrowser({ tabs: threeTabs(), content });
  const { settle } = await boot(b);
  b.press();
  await settle();
  assert.equal(b.activeId(), 2);
  assert.deepEqual(b.mru(), [2, 1, 3]);
  b.press();
  await settle();
  assert.equal(b.activeId(), 1);
  assert.deepEqual(b.mru(), [1, 2, 3]);
});

test("ack hasFocus:false goes to fallback", async () => {
  const content = { 1: (m) => (m.type === "switcher:show" ? { ok: true, hasFocus: false, modifiersHeld: true } : { ok: true }) };
  const b = fakeBrowser({ tabs: threeTabs(), content });
  const { settle } = await boot(b);
  b.press();
  await settle();
  assert.equal(b.activeId(), 2);
  assert.equal(b.session().mode, "fallback");
});

test("rejected sendMessage and a hung page both go to fallback", async () => {
  for (const reply of ["reject", "hang"]) {
    const b = fakeBrowser({ tabs: threeTabs(), content: { 1: () => reply } });
    const { settle } = await boot(b);
    const t0 = realNow();
    b.press();
    await settle();
    if (reply === "hang") await sleep(200);
    await settle();
    assert.equal(b.activeId(), 2, reply);
    assert.equal(b.session().mode, "fallback", reply);
    if (reply === "reject") assert.ok(realNow() - t0 < 140, "no waiting for the ack timer");
  }
});

test("wake with persisted state uses the stored MRU, not a fresh seed", async () => {
  const sessionData = {};
  const tabs = threeTabs({ url: "https://three.example/" });
  const first = fakeBrowser({ tabs, sessionData });
  const one = await boot(first);
  await one.settle();
  await first.tabs.update(3, { active: true });
  await one.settle();
  await first.tabs.update(2, { active: true });
  await one.settle();
  await first.tabs.update(3, { active: true });
  await one.settle();
  assert.deepEqual(first.mru(), [3, 2, 1]); // a seed would give [3, 1, 2]

  // Worker stopped; a new instance wakes on a shortcut press with the same storage.session.
  const second = fakeBrowser({ tabs: first._tabs, sessionData });
  const two = await boot(second);
  second.press();
  await two.settle();
  assert.equal(second.activeId(), 2);
});

test("cold start across a fallback session: the MRU ends up correct without the idle timer", async () => {
  const sessionData = {};
  const first = fakeBrowser({ tabs: threeTabs(), sessionData, localData: { settings: { overlay: false } } });
  const one = await boot(first);
  first.press();
  await one.settle();
  first.press();
  await one.settle();
  assert.equal(first.activeId(), 3);
  // The worker is stopped before its idle timer fires; the timer of instance one is ignored
  // by the token check if it fires anyway, so simulate the restart by moving the clock.
  clockOffset += 60000;
  const second = fakeBrowser({ tabs: first._tabs, sessionData, localData: { settings: { overlay: false } } });
  const two = await boot(second);
  await second.tabs.update(2, { active: true }); // user clicks tab 2
  await two.settle();
  assert.equal(second.session(), null);
  assert.deepEqual(second.mru(), [2, 3, 1]);
});

test("tab events: created active counts as activation, windowId -1 ignored, replace moves position", async () => {
  const b = fakeBrowser({ tabs: threeTabs() });
  const { settle } = await boot(b);
  await settle();
  b.tabs.onCreated.fire({ id: 9, windowId: 1, index: 3, active: true });
  b.tabs.onCreated.fire({ id: 10, windowId: -1, index: null, active: true });
  await settle();
  assert.deepEqual(b.mru(), [9, 1, 2, 3]);
  b.tabs.onReplaced.fire(10, 9);
  b.tabs.onRemoved.fire(9, { windowId: 1 });
  await settle();
  assert.deepEqual(b.mru(), [10, 1, 2, 3]);
  b.tabs.onCreated.fire({ id: 11, windowId: 1, index: 4, active: false });
  await settle();
  assert.deepEqual(b.mru(), [10, 1, 2, 3, 11]);
});

test("multi-window: MRU per window, flip acts on the focused window only", async () => {
  const tabs = [
    ...threeTabs(),
    { id: 21, windowId: 2, url: "https://w2a.example/", active: true },
    { id: 22, windowId: 2, url: "https://w2b.example/", active: false },
  ];
  const b = fakeBrowser({ tabs });
  const { settle } = await boot(b);
  await settle();
  b._focused = 2;
  b.windows.onFocusChanged.fire(2);
  b.press();
  await settle();
  assert.equal(b.activeId(2), 22);
  assert.equal(b.activeId(1), 1);
  assert.deepEqual(b.mru(1), [1, 2, 3]);
  b.windows.onFocusChanged.fire(1); // focus change ends the session in window 2
  await settle();
  assert.equal(b.session(), null);
  assert.deepEqual(b.mru(2), [22, 21]);
});

test("page:meta: icons are not stored for private tabs; unknown messages are ignored", async () => {
  const tabs = [...threeTabs(), { id: 7, windowId: 3, incognito: true, url: "https://p.example/", active: true }];
  const b = fakeBrowser({ tabs });
  const { settle } = await boot(b);
  b.message({ type: "page:meta", icon: ICON_A }, 7);
  b.message({ type: "page:meta", icon: "javascript:alert(1)" }, 2);
  b.message({ type: "data:clear" }, 1);
  b.message({ type: "switcher:commit", tabId: 2 }, 1); // no session: ignored
  await settle();
  const icons = b.storage.session.data.state.icons;
  assert.deepEqual(icons, {});
  assert.equal(b.activeId(1), 1);
});

test("page:meta: only small data:image icons are stored (no network URLs, F6)", async () => {
  const b = fakeBrowser({ tabs: threeTabs() });
  const { settle } = await boot(b);
  await settle();
  const big = "data:image/png;base64," + "A".repeat(9000);
  for (const icon of ["https://two.example/favicon.ico", "http://two.example/i.png", "data:image/svg+xml,<svg/>", "data:text/html;base64,AAAA", big]) {
    b.message({ type: "page:meta", icon }, 2);
    await settle();
    assert.equal(b.storage.session.data.state.icons[2], undefined, icon.slice(0, 40));
  }
  b.message({ type: "page:meta", icon: ICON_A }, 2);
  await settle();
  assert.equal(b.storage.session.data.state.icons[2], ICON_A);
  b.message({ type: "page:meta", icon: null }, 2); // a later page without an icon clears it
  await settle();
  assert.equal(b.storage.session.data.state.icons[2], undefined);
});

/** Send a message as the options page; returns the listener's reply (a promise or undefined). */
function fromOptions(b, msg, { withTab = false } = {}) {
  const url = EXT_BASE + "options/options.html";
  const sender = withTab ? { id: "tabswitcher", url, tab: { id: 50, windowId: 1, url } } : { id: "tabswitcher", url };
  return b.runtime.onMessage.fire(msg, sender)[0];
}

test("data:clear from the options page wipes previews, icons and MRU, re-seeds, replies ok", async () => {
  for (const withTab of [false, true]) {
    const tabs = [
      { id: 1, windowId: 1, url: "https://a.example/", active: false },
      { id: 2, windowId: 1, url: "https://b.example/", active: true },
      { id: 3, windowId: 1, url: "https://c.example/", active: false },
    ];
    const sessionData = {
      "preview:1": { dataUrl: "data:image/jpeg;base64,AAAA", at: 1 },
      "preview:99": { dataUrl: "data:image/jpeg;base64,BBBB", at: 2 }, // orphan, not in the index
      previewIndex: { 1: 1 },
      unrelated: "kept",
    };
    const b = fakeBrowser({ tabs, sessionData });
    const { settle } = await boot(b);
    b.runtime.onStartup.fire();
    await settle();
    await b.tabs.update(3, { active: true });
    await settle();
    b.message({ type: "page:meta", icon: ICON_A }, 1);
    await settle();
    assert.deepEqual(b.mru(), [3, 2, 1]);

    const reply = await fromOptions(b, { type: "data:clear" }, { withTab });
    assert.deepEqual(reply, { ok: true }, `withTab=${withTab}`);
    await settle();
    const data = b.storage.session.data;
    assert.equal(data["preview:1"], undefined);
    assert.equal(data["preview:99"], undefined);
    assert.equal(data.previewIndex, undefined);
    assert.equal(data.unrelated, "kept");
    assert.deepEqual(data.state.icons, {});
    assert.deepEqual(b.mru(), [3, 1, 2], "re-seeded: active first, then tab-strip order");
  }
});

test("data:clear replies { ok: false, error } when storage fails, and is refused from content scripts", async () => {
  const b = fakeBrowser({ tabs: threeTabs() });
  const { settle } = await boot(b);
  await settle();
  assert.equal(b.runtime.onMessage.fire({ type: "data:clear" }, { id: "tabswitcher", url: "https://one.example/a", tab: b.tab(1) })[0], undefined);
  const set = b.storage.session.set;
  b.storage.session.set = async () => {
    throw new Error("quota exceeded");
  };
  const reply = await fromOptions(b, { type: "data:clear" });
  b.storage.session.set = set;
  assert.equal(reply.ok, false);
  assert.equal(typeof reply.error, "string");
  assert.match(reply.error, /quota/);
});

test("turning previews off deletes stored previews; startup prunes closed tabs and spike data", async () => {
  const sessionData = {
    "preview:1": { dataUrl: "data:image/jpeg;base64,AAAA", at: 1 },
    "preview:42": { dataUrl: "data:image/jpeg;base64,BBBB", at: 2 },
    previewIndex: { 1: 1, 42: 2 },
    spikeSession: { x: 1 },
  };
  const localData = { spike: { v: 1 }, spike_hb: {}, spike_notes: {}, spike_cfg: {}, settings: { previews: true } };
  const b = fakeBrowser({ tabs: threeTabs(), sessionData, localData });
  const { settle } = await boot(b);
  b.runtime.onStartup.fire();
  await settle();
  await sleep(5);
  await settle();
  assert.deepEqual(Object.keys(localData).sort(), ["settings"]);
  assert.equal(sessionData.spikeSession, undefined);
  assert.equal(sessionData["preview:42"], undefined, "tab 42 no longer exists");
  assert.ok(sessionData["preview:1"]);
  assert.deepEqual(sessionData.previewIndex, { 1: 1 });

  b.storage.onChanged.fire({ settings: { oldValue: { previews: true }, newValue: { previews: false } } }, "local");
  await sleep(5);
  assert.equal(sessionData["preview:1"], undefined);
  assert.equal(sessionData.previewIndex, undefined);
});

test("switcher:show carries stored previews (one batched read) and none when previews are off", async () => {
  const replies = [];
  const content = { 1: (m) => (replies.push(m), m.type === "switcher:show" ? { ok: true, hasFocus: true, modifiersHeld: true } : { ok: true }) };
  const stored = () => ({ "preview:2": { dataUrl: "data:image/jpeg;base64,QUJD", at: 1 }, previewIndex: { 2: 1 } });
  const b = fakeBrowser({ tabs: threeTabs(), content, sessionData: stored() });
  const gets = [];
  const get = b.storage.session.get;
  b.storage.session.get = (k) => (gets.push(k), get(k));
  const { settle } = await boot(b);
  await settle();
  gets.length = 0;
  b.press();
  await settle();
  assert.deepEqual(replies[0].items.map((i) => i.preview), [null, "data:image/jpeg;base64,QUJD", null]);
  assert.equal(gets.filter((k) => Array.isArray(k)).length, 1, "one storage.get for all previews");

  const b2 = fakeBrowser({ tabs: threeTabs(), content, sessionData: stored(), localData: { settings: { previews: false } } });
  replies.length = 0;
  const two = await boot(b2);
  b2.press();
  await two.settle();
  assert.deepEqual(replies[0].items.map((i) => i.preview), [null, null, null]);
});

test("settings from the app are copied into storage.local on start and when Safari regains focus", async () => {
  const app = { calls: [], settings: null, clearToken: null };
  app.reply = () => ({ settings: app.settings, clearToken: app.clearToken });
  const b = fakeBrowser({ tabs: threeTabs(), app });
  const { settle } = await boot(b);
  await settle();
  assert.deepEqual(app.calls, [{ type: "settings:get" }]);
  assert.equal(b.storage.local.data.settings, undefined, "the app has saved nothing yet");

  app.settings = { overlay: false, previews: false, maxItems: 5 };
  await sleep(1100); // calls are at most once a second
  b.windows.onFocusChanged.fire(1);
  await settle();
  await sleep(5);
  const s = b.storage.local.data.settings;
  assert.equal(s.overlay, false);
  assert.equal(s.maxItems, 5);
  assert.equal(s.shortcuts.next.code, "Tab");
});

test("a new clear token from the app wipes icons and is remembered", async () => {
  const app = { calls: [], settings: null, clearToken: "t0" };
  app.reply = () => ({ settings: app.settings, clearToken: app.clearToken });
  const b = fakeBrowser({ tabs: threeTabs(), app, localData: { clearToken: "t0" } });
  const { settle } = await boot(b);
  b.message({ type: "page:meta", icon: ICON_A }, 2);
  await settle();
  assert.equal(b.storage.session.data.state.icons[2], ICON_A, "same token at start: nothing cleared");

  app.clearToken = "t1"; // the user pressed Clear… in the app
  await sleep(1100);
  b.windows.onFocusChanged.fire(1);
  await settle();
  await sleep(5);
  await settle();
  assert.deepEqual(b.storage.session.data.state.icons, {});
  assert.equal(b.storage.local.data.clearToken, "t1");
});

const liveScript = () => (m) =>
  m.type === "switcher:show" ? { ok: true, hasFocus: true, modifiersHeld: true, shown: true } : { ok: true };

test("a page whose switcher is dead gets a fresh copy at press time and shows the switcher", async () => {
  // Tab 1 has no live content script (the extension was turned off and on while it was open).
  const b = fakeBrowser({ tabs: threeTabs(), sessionData: { healed: true }, inject: liveScript });
  const { settle } = await boot(b);
  b.press();
  await settle();
  assert.deepEqual(b._injected, [{ tabId: 1, files: ["content/switcher.js"] }]);
  assert.deepEqual(b._sent.map((x) => x.msg.type), ["switcher:show"]);
  assert.deepEqual(b._directSent.map((x) => x.msg.type), ["switcher:show"]);
  assert.equal(b.session().mode, "overlay");
  assert.equal(b.activeId(), 1); // no tab switch behind the user's back
});

test("a page whose messaging stays dead is driven directly: show, move and hide all arrive", async () => {
  // Open since before an update: Safari runs code there but delivers no messages, even to
  // a copy loaded afterwards. The on-load check loads a copy; presses then call it directly.
  const b = fakeBrowser({ tabs: threeTabs(), inject: liveScript, deadMessaging: true });
  const { settle } = await boot(b);
  await settle();
  assert.deepEqual(b._injected.map((x) => x.tabId).sort(), [1, 2]);
  b.press();
  await settle();
  assert.equal(b._injected.length, 2); // the copy already there is reused
  assert.equal(b.session().mode, "overlay");
  b.press();
  await settle();
  b.release();
  await settle();
  assert.deepEqual(b._directSent.filter((x) => x.tabId === 1).map((x) => x.msg.type), ["switcher:show", "switcher:move", "switcher:hide"]);
  assert.equal(b.session(), null);
});

test("where no script may run, a press still falls back to switching at once", async () => {
  const inject = () => {
    throw new Error("not allowed here");
  };
  const b = fakeBrowser({ tabs: threeTabs(), sessionData: { healed: true }, inject });
  const { settle } = await boot(b);
  b.press();
  await settle();
  assert.equal(b._injected.length, 1);
  assert.equal(b.activeId(), 2);
  assert.equal(b.session().mode, "fallback");
});

test("on load, open pages without a live switcher get one; live and empty pages are left alone", async () => {
  const content = { 1: liveScript() };
  const b = fakeBrowser({ tabs: threeTabs(), content, inject: liveScript });
  const { settle } = await boot(b);
  await settle();
  // Tab 3 has no url. Tab 2 is asked again after its copy is loaded, to confirm it took.
  assert.deepEqual(b._pings.sort(), [1, 2, 2]);
  assert.deepEqual(b._injected.map((x) => x.tabId), [2]);

  // A later wake of the same extension load does not check again...
  const again = fakeBrowser({ tabs: threeTabs(), sessionData: { healed: true }, inject: liveScript });
  const two = await boot(again);
  await two.settle();
  assert.deepEqual(again._pings, []);
  // ...but an install/update/enable always does.
  again.runtime.onInstalled.fire({});
  await two.settle();
  assert.deepEqual(again._injected.map((x) => x.tabId).sort(), [1, 2]);
});

// ---------------------------------------------------------------------------
// Snapshots for the app's panel

function panelApp() {
  const app = { calls: [], pushes: [], logs: [], settings: null, clearToken: null };
  app.reply = () => ({ settings: app.settings, clearToken: app.clearToken });
  return app;
}

test("snapshot: pushed at start with the MRU window list, one log line per push", async () => {
  const app = panelApp();
  const b = fakeBrowser({ tabs: threeTabs(), app });
  const { settle } = await boot(b);
  await settle();
  assert.equal(app.pushes.length, 1);
  const s = app.pushes[0];
  assert.equal(s.windowId, 1);
  assert.equal(s.focused, true);
  assert.equal(s.items[0].tabId, 1);
  assert.equal(s.items.length, 3);
  const logs = app.logs.filter((l) => l.what === "snapshot");
  assert.equal(logs.length, 1);
  assert.deepEqual(Object.keys(logs[0].data).sort(), ["delivered", "focused", "i", "items", "ms", "previews", "seq", "w"]);
});

test("snapshot: one push per tab switch, with the new order; an identical state is not pushed again", async () => {
  const app = panelApp();
  const b = fakeBrowser({ tabs: threeTabs(), app });
  const { settle } = await boot(b);
  await settle();
  const before = app.pushes.length;
  await sleep(260); // past the per-window throttle of the start push
  await b.tabs.update(2, { active: true });
  await settle();
  await sleep(10);
  await settle();
  assert.equal(app.pushes.length, before + 1);
  assert.deepEqual(app.pushes.at(-1).items.map((i) => i.tabId), [2, 1, 3]);
  assert.ok(app.pushes.at(-1).seq > app.pushes[0].seq);
  b.tabs.onActivated.fire({ tabId: 2, windowId: 1 });
  await settle();
  assert.equal(app.pushes.length, before + 1, "same content: nothing pushed");
});

test("snapshot: a second change inside 250 ms is held and goes out at the end of the window", async () => {
  const app = panelApp();
  const b = fakeBrowser({ tabs: threeTabs(), app });
  const { settle } = await boot(b);
  await settle();
  const before = app.pushes.length;
  await sleep(260);
  await b.tabs.update(2, { active: true });
  await settle();
  await b.tabs.update(3, { active: true });
  await settle();
  assert.equal(app.pushes.length, before + 1, "the second is held");
  await sleep(300);
  await settle();
  assert.equal(app.pushes.length, before + 2);
  assert.deepEqual(app.pushes.at(-1).items.map((i) => i.tabId), [3, 2, 1]);
});

test("snapshot: panel: false pushes nothing", async () => {
  const app = panelApp();
  const b = fakeBrowser({ tabs: threeTabs(), app, localData: { settings: { panel: false } } });
  const { settle } = await boot(b);
  await settle();
  await b.tabs.update(2, { active: true });
  await settle();
  await sleep(10);
  await settle();
  assert.equal(app.pushes.length, 0);
});

test("snapshot: a copy that sees no tabs stays silent", async () => {
  const app = panelApp();
  const b = fakeBrowser({ tabs: [], app });
  const { settle } = await boot(b);
  await settle();
  b.tabs.onActivated.fire({ tabId: 1, windowId: 1 });
  await settle();
  assert.equal(app.pushes.length, 0);
});

test("snapshot: private tabs send titles but no icon or preview", async () => {
  const app = panelApp();
  const b = fakeBrowser({ tabs: threeTabs().map((t) => ({ ...t, incognito: true })), app });
  const { settle } = await boot(b);
  b.message({ type: "page:meta", icon: ICON_A }, 1);
  await settle();
  assert.ok(app.pushes.length >= 1);
  const s = app.pushes.at(-1);
  assert.equal(s.private, true);
  assert.ok(s.items.every((i) => i.icon === null && i.preview === null));
  assert.equal(s.items[0].title, "One");
});

test("activate: an unknown tab or the wrong window does nothing", async () => {
  const b = fakeBrowser({ tabs: threeTabs() });
  const { settle } = await boot(b);
  await settle();
  const mruBefore = JSON.stringify(b.mru());
  b._helper.onMessage.fire({ name: "activate", userInfo: { windowId: 1, tabId: 99 } });
  b._helper.onMessage.fire({ name: "activate", userInfo: { windowId: 5, tabId: 2 } });
  b._helper.onMessage.fire({ name: "activate", userInfo: { windowId: "x", tabId: 2 } });
  await settle();
  assert.equal(b.activeId(), 1);
  assert.equal(JSON.stringify(b.mru()), mruBefore);
});

test("activate: a known tab is activated and promoted in the MRU", async () => {
  const b = fakeBrowser({ tabs: threeTabs() });
  const { settle } = await boot(b);
  await settle();
  b._helper.onMessage.fire({ name: "activate", userInfo: { windowId: 1, tabId: 3 } });
  await settle();
  await sleep(10);
  await settle();
  assert.equal(b.activeId(), 3);
  assert.equal(b.mru()[0], 3);
});
