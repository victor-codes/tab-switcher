// TabFlip background entry (wiring only). Owner: Agent 1.
//
// A module service worker that Safari stops ~29 s after its last event. Therefore:
// - every listener is registered synchronously at top level (below);
// - nothing is kept in memory between events: each event loads state from
//   storage.session, reduces it, saves it, then performs the browser calls;
// - events are handled strictly one at a time, in arrival order (store.createQueue).
// All decisions live in core/mru.js and core/session.js; this file only translates
// browser events into reducer events and reducer effects into browser calls.

import * as mru from "./core/mru.js";
import * as sessions from "./core/session.js";
import { createQueue, createStore } from "./core/store.js";
import * as previews from "./core/previews.js"; // Agent 4; may still export nothing.

const api = globalThis.browser;
const store = createStore(api.storage.session ?? api.storage.local, api.storage.local);
const queue = createQueue();

/** The modifier the default shortcuts use (MacCtrl = Control). */
const MODIFIERS = ["Control"];
const MAX_ICON_URL_LENGTH = 4096;

let idleTimer = null;

/** Resolves when every event received so far has been handled (used by tests). */
export function whenIdle() {
  return queue.idle();
}

function isId(v) {
  return Number.isInteger(v) && v >= 0;
}

function hostOf(url) {
  if (typeof url !== "string" || !url) return "";
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Job plumbing

/**
 * Enqueue `fn(state, settings)`. State is loaded (and seeded on a fresh wake) before `fn`
 * runs and saved after it, unless `fn` already saved through `reduce`.
 */
function job(fn, { settings: wantSettings = false } = {}) {
  return queue.enqueue(async () => {
    const [{ state, fresh }, settings] = await Promise.all([
      store.load(),
      wantSettings ? store.loadSettings() : Promise.resolve(null),
    ]);
    if (fresh) await seedInto(state);
    await fn(state, settings);
    await store.save(state);
  });
}

async function seedInto(state) {
  try {
    const tabs = await api.tabs.query({});
    state.mru = mru.seed(state.mru, tabs);
  } catch (e) {
    console.warn("[TabFlip] seeding failed", e);
  }
}

/**
 * Feed `event` to the session reducer, apply its MRU effects, save, then run its browser
 * effects. Effects can produce follow-up events (the switcher:show ack), which are reduced
 * in the same job so nothing else interleaves.
 */
async function reduce(state, event, ctx = {}) {
  const queueOfEvents = [event];
  while (queueOfEvents.length) {
    const ev = queueOfEvents.shift();
    const r = sessions.step(state.session, ev, { ...ctx, now: Date.now() });
    state.session = r.session;
    const io = [];
    for (const eff of r.effects) {
      if (eff.type === "promote") state.mru = mru.activated(state.mru, eff.windowId, eff.tabId);
      else io.push(eff);
    }
    await store.save(state);
    for (const eff of io) {
      const follow = await perform(state, eff, ctx);
      if (follow) queueOfEvents.push(follow);
    }
  }
}

// ---------------------------------------------------------------------------
// Effects

function send(tabId, msg) {
  try {
    return Promise.resolve(api.tabs.sendMessage(tabId, msg)).catch(() => undefined);
  } catch {
    return Promise.resolve(undefined);
  }
}

async function sendWithTimeout(tabId, msg, ms) {
  let timer;
  const TIMEOUT = Symbol("timeout");
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
  });
  let rejected = false;
  const reply = Promise.resolve()
    .then(() => api.tabs.sendMessage(tabId, msg))
    .catch(() => {
      rejected = true;
      return undefined;
    });
  const result = await Promise.race([reply, timeout]);
  clearTimeout(timer);
  if (result === TIMEOUT) return { timedOut: true };
  return { timedOut: false, reply: rejected ? undefined : result };
}

async function previewOf(tabId) {
  try {
    const p = await previews.getPreview?.(tabId);
    return typeof p === "string" ? p : null;
  } catch {
    return null;
  }
}

async function buildItems(state, order, tabsById) {
  return Promise.all(
    order.map(async (tabId) => {
      const t = tabsById?.get(tabId);
      return {
        tabId,
        title: typeof t?.title === "string" ? t.title : "",
        host: hostOf(t?.url),
        icon: state.icons[tabId] ?? null,
        preview: await previewOf(tabId),
      };
    })
  );
}

async function perform(state, eff, ctx) {
  switch (eff.type) {
    case "show": {
      const items = await buildItems(state, eff.order, ctx.tabsById);
      const msg = { type: "switcher:show", items, selectedIndex: eff.selectedIndex, modifiers: MODIFIERS };
      const r = await sendWithTimeout(eff.tabId, msg, eff.ackTimeoutMs);
      return r.timedOut ? { type: "ackTimeout", token: eff.token } : { type: "ack", token: eff.token, reply: r.reply };
    }
    case "move":
      send(eff.tabId, { type: "switcher:move", selectedIndex: eff.selectedIndex });
      return null;
    case "hide":
      send(eff.tabId, { type: "switcher:hide" });
      return null;
    case "activate":
      try {
        await api.tabs.update(eff.tabId, { active: true });
      } catch (e) {
        console.warn("[TabFlip] activate failed", eff.tabId, e);
      }
      return null;
    case "remove":
      try {
        await api.tabs.remove(eff.tabId);
      } catch (e) {
        console.warn("[TabFlip] remove failed", eff.tabId, e);
      }
      return null;
    case "startIdleTimer":
      // Best effort: the worker may be stopped before this fires. session.step also
      // expires a stale fallback session lazily on the next event.
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimer = null;
        job((state) => reduce(state, { type: "idleTimeout", token: eff.token }));
      }, eff.ms);
      return null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Commands

async function resolveTab(tab) {
  if (tab && isId(tab.id) && isId(tab.windowId)) return tab;
  try {
    const [active] = await api.tabs.query({ active: true, currentWindow: true });
    return active && isId(active.id) && isId(active.windowId) ? active : null;
  } catch {
    return null;
  }
}

/** Reconcile the window's MRU with the real tab list; returns the tabs by id. */
async function syncWindow(state, windowId) {
  let tabs = [];
  try {
    tabs = await api.tabs.query({ windowId });
  } catch (e) {
    console.warn("[TabFlip] tabs.query failed", e);
  }
  if (tabs.length) state.mru = mru.syncWindow(state.mru, windowId, tabs);
  return new Map(tabs.map((t) => [t.id, t]));
}

function onCommand(command, tab) {
  if (command !== "flip" && command !== "close-and-return") return;
  job(
    async (state, settings) => {
      const t = await resolveTab(tab);
      if (!t) return;
      const tabsById = await syncWindow(state, t.windowId);
      const order = mru.list(state.mru, t.windowId);
      if (command === "flip") {
        await reduce(state, { type: "flip", windowId: t.windowId, tabId: t.id }, { settings, order, tabsById });
      } else {
        await reduce(state, { type: "closeAndReturn", windowId: t.windowId, tabId: t.id }, { order });
      }
    },
    { settings: command === "flip" }
  );
}

// ---------------------------------------------------------------------------
// Tab and window events

function onActivated(info) {
  if (!info || !isId(info.tabId) || !isId(info.windowId)) return;
  job((state) => reduce(state, { type: "activated", windowId: info.windowId, tabId: info.tabId }));
}

function onCreated(tab) {
  // Opening an extension page creates a transient tab with windowId -1: ignore it.
  if (!tab || !isId(tab.id) || !isId(tab.windowId)) return;
  job(async (state) => {
    if (tab.active) {
      // Safari sends no onActivated for a tab created already active.
      await reduce(state, { type: "activated", windowId: tab.windowId, tabId: tab.id });
    } else {
      state.mru = mru.created(state.mru, tab.windowId, tab.id);
    }
  });
}

function onRemoved(tabId, info) {
  job(async (state) => {
    state.mru = mru.removed(state.mru, info?.windowId, tabId);
    delete state.icons[tabId];
    await reduce(state, { type: "external", reason: "removed" });
  });
}

function onReplaced(addedTabId, removedTabId) {
  job(async (state) => {
    state.mru = mru.replaced(state.mru, removedTabId, addedTabId);
    if (state.icons[removedTabId] !== undefined) {
      state.icons[addedTabId] = state.icons[removedTabId];
      delete state.icons[removedTabId];
    }
    await reduce(state, { type: "external", reason: "replaced" });
  });
}

function onAttached(tabId, info) {
  job(async (state) => {
    state.mru = mru.attached(state.mru, info?.newWindowId, tabId);
    await reduce(state, { type: "external", reason: "attached" });
  });
}

function onDetached(tabId, info) {
  job(async (state) => {
    state.mru = mru.detached(state.mru, info?.oldWindowId, tabId);
    await reduce(state, { type: "external", reason: "detached" });
  });
}

function onWindowRemoved(windowId) {
  job(async (state) => {
    state.mru = mru.windowRemoved(state.mru, windowId);
    if (state.session && state.session.windowId === windowId) {
      await reduce(state, { type: "external", reason: "windowRemoved" });
    }
  });
}

function onFocusChanged(windowId) {
  job((state) => reduce(state, { type: "focusChanged", windowId }));
}

function onStartupOrInstalled() {
  job((state) => seedInto(state));
}

// ---------------------------------------------------------------------------
// Messages from content scripts

function validIcon(icon) {
  return (
    typeof icon === "string" &&
    icon.length <= MAX_ICON_URL_LENGTH &&
    /^(https?:|data:image\/)/i.test(icon)
  );
}

function onMessage(msg, sender) {
  if (!msg || typeof msg.type !== "string" || !sender || !sender.tab) return undefined;
  if (sender.id && api.runtime.id && sender.id !== api.runtime.id) return undefined;
  const senderTab = sender.tab;
  switch (msg.type) {
    case "switcher:commit":
      job((state) => reduce(state, { type: "commit", senderTabId: senderTab.id, tabId: msg.tabId }));
      break;
    case "switcher:cancel":
      job((state) => reduce(state, { type: "cancel", senderTabId: senderTab.id }));
      break;
    case "page:meta":
      // Nothing is stored for private tabs.
      if (senderTab.incognito || !isId(senderTab.id)) break;
      job(async (state) => {
        if (validIcon(msg.icon)) state.icons[senderTab.id] = msg.icon;
        else delete state.icons[senderTab.id];
      });
      break;
    default:
      break;
  }
  return undefined; // no reply to any message
}

// ---------------------------------------------------------------------------
// Listeners: synchronous, top level, so a stopped worker is woken for them.

api.commands.onCommand.addListener(onCommand);
api.tabs.onActivated.addListener(onActivated);
api.tabs.onCreated.addListener(onCreated);
api.tabs.onRemoved.addListener(onRemoved);
api.tabs.onReplaced.addListener(onReplaced);
api.tabs.onAttached.addListener(onAttached);
api.tabs.onDetached.addListener(onDetached);
api.windows.onRemoved.addListener(onWindowRemoved);
api.windows.onFocusChanged.addListener(onFocusChanged);
api.runtime.onStartup.addListener(onStartupOrInstalled);
api.runtime.onInstalled.addListener(onStartupOrInstalled);
api.runtime.onMessage.addListener(onMessage);
