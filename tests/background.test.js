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
      return key in shared ? { [key]: structuredClone(shared[key]) } : {};
    },
    async set(obj) {
      Object.assign(shared, structuredClone(obj));
    },
  };
}

/**
 * Fake Safari. `tabs`: [{ id, windowId, title, url, active }] in tab-strip order.
 * `content`: { [tabId]: (msg) => reply | "reject" | "hang" } — tabs without an entry have
 * no content script and answer sendMessage with undefined, as measured.
 */
function fakeBrowser({ tabs, content = {}, sessionData = {}, localData = {} }) {
  const b = {
    _tabs: tabs.map((t) => ({ ...t })),
    _focused: tabs[0]?.windowId ?? 1,
    _sent: [],
    _content: content,
    storage: { session: area(sessionData), local: area(localData) },
    runtime: { id: "tabflip", onStartup: event(), onInstalled: event(), onMessage: event() },
    commands: { onCommand: event() },
    windows: { onRemoved: event(), onFocusChanged: event() },
    tabs: {
      onActivated: event(),
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
    command(name, windowId = b._focused) {
      const active = b._tabs.find((t) => t.windowId === windowId && t.active);
      b.commands.onCommand.fire(name, { ...active });
    },
    message(msg, fromTabId) {
      b.runtime.onMessage.fire(msg, { id: "tabflip", tab: b.tab(fromTabId) });
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
    b.commands.onCommand, b.tabs.onActivated, b.tabs.onCreated, b.tabs.onRemoved, b.tabs.onReplaced,
    b.tabs.onAttached, b.tabs.onDetached, b.windows.onRemoved, b.windows.onFocusChanged,
    b.runtime.onStartup, b.runtime.onInstalled, b.runtime.onMessage,
  ]) {
    assert.equal(ev.listeners.length, 1);
  }
});

test("fallback (no content script): flip A->B, then A again after the idle window (lazy expiry)", async () => {
  const b = fakeBrowser({ tabs: threeTabs() });
  const { settle } = await boot(b);
  b.command("flip");
  await settle();
  assert.equal(b.activeId(), 2);
  assert.equal(b.session().mode, "fallback");
  assert.deepEqual(b.mru(), [1, 2, 3], "not promoted during the session");
  assert.deepEqual(b._sent.map((s) => s.msg.type), ["switcher:show"]);

  clockOffset += 5000; // the idle timer is irrelevant now: lazy expiry handles it
  b.command("flip");
  await settle();
  assert.equal(b.activeId(), 1);
  assert.deepEqual(b.session().order, [2, 1, 3]);
});

test("fallback: the 1000 ms idle timer ends the session and promotes the final tab", async () => {
  const b = fakeBrowser({ tabs: threeTabs() });
  const { settle } = await boot(b);
  b.command("flip");
  await settle();
  b.command("flip");
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
  b.message({ type: "page:meta", icon: "https://two.example/favicon.ico" }, 2);
  await settle();
  b.command("flip");
  await settle();
  const show = replies[0];
  assert.equal(show.type, "switcher:show");
  assert.equal(show.selectedIndex, 1);
  assert.deepEqual(show.modifiers, ["Control"]);
  assert.deepEqual(show.items, [
    { tabId: 1, title: "One", host: "one.example", icon: null, preview: null },
    { tabId: 2, title: "Two", host: "two.example", icon: "https://two.example/favicon.ico", preview: null },
    { tabId: 3, title: "Three", host: "", icon: null, preview: null },
  ]);
  assert.equal(b.activeId(), 1, "overlay mode does not switch yet");
  b.command("flip");
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
  b.command("flip");
  await settle();
  assert.equal(b.activeId(), 2);
  assert.deepEqual(b.mru(), [2, 1, 3]);
  b.command("flip");
  await settle();
  assert.equal(b.activeId(), 1);
  assert.deepEqual(b.mru(), [1, 2, 3]);
});

test("ack hasFocus:false goes to fallback", async () => {
  const content = { 1: (m) => (m.type === "switcher:show" ? { ok: true, hasFocus: false, modifiersHeld: true } : { ok: true }) };
  const b = fakeBrowser({ tabs: threeTabs(), content });
  const { settle } = await boot(b);
  b.command("flip");
  await settle();
  assert.equal(b.activeId(), 2);
  assert.equal(b.session().mode, "fallback");
});

test("rejected sendMessage and a hung page both go to fallback", async () => {
  for (const reply of ["reject", "hang"]) {
    const b = fakeBrowser({ tabs: threeTabs(), content: { 1: () => reply } });
    const { settle } = await boot(b);
    const t0 = realNow();
    b.command("flip");
    await settle();
    if (reply === "hang") await sleep(200);
    await settle();
    assert.equal(b.activeId(), 2, reply);
    assert.equal(b.session().mode, "fallback", reply);
    if (reply === "reject") assert.ok(realNow() - t0 < 140, "no waiting for the ack timer");
  }
});

test("close-and-return activates the previous MRU tab, not the neighbour", async () => {
  const tabs = [
    { id: 1, windowId: 1, url: "https://a.example/", active: false },
    { id: 2, windowId: 1, url: "https://b.example/", active: true },
    { id: 3, windowId: 1, url: "https://c.example/", active: false },
    { id: 4, windowId: 1, url: "https://d.example/", active: false },
  ];
  const b = fakeBrowser({ tabs });
  const { settle } = await boot(b);
  b.runtime.onStartup.fire();
  await settle();
  assert.deepEqual(b.mru(), [2, 1, 3, 4], "seeded: active first, then tab-strip order");
  await b.tabs.update(4, { active: true });
  await settle();
  await b.tabs.update(3, { active: true });
  await settle();
  assert.deepEqual(b.mru(), [3, 4, 2, 1]);
  b.command("close-and-return");
  await settle();
  assert.equal(b.activeId(), 4);
  assert.equal(b._tabs.some((t) => t.id === 3), false);
  assert.deepEqual(b.mru(), [4, 2, 1]);
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

  // Worker stopped; a new instance wakes on the command with the same storage.session.
  const second = fakeBrowser({ tabs: first._tabs, sessionData });
  const two = await boot(second);
  second.command("flip");
  await two.settle();
  assert.equal(second.activeId(), 2);
});

test("cold start across a fallback session: the MRU ends up correct without the idle timer", async () => {
  const sessionData = {};
  const first = fakeBrowser({ tabs: threeTabs(), sessionData, localData: { settings: { overlay: false } } });
  const one = await boot(first);
  first.command("flip");
  await one.settle();
  first.command("flip");
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
  b.command("flip");
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
  b.message({ type: "page:meta", icon: "https://p.example/i.png" }, 7);
  b.message({ type: "page:meta", icon: "javascript:alert(1)" }, 2);
  b.message({ type: "data:clear" }, 1);
  b.message({ type: "switcher:commit", tabId: 2 }, 1); // no session: ignored
  await settle();
  const icons = b.storage.session.data.state.icons;
  assert.deepEqual(icons, {});
  assert.equal(b.activeId(1), 1);
});
