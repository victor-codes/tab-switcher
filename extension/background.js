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
import { createQueue, createStore, SETTINGS_KEY, STATE_KEY } from "./core/store.js";
import { CLEAR_TOKEN_KEY, planSync } from "./core/appsync.js";
import * as previews from "./core/previews.js";
import { holdModifiers } from "./core/shortcuts.js";

const api = globalThis.browser;
const stateArea = api.storage.session ?? api.storage.local;
const store = createStore(stateArea, api.storage.local);
const queue = createQueue();

/**
 * Previews run on their own serial queue (core/previews.js) so a capture never delays a
 * command. A capture is skipped while a switch session is running.
 */
const shots = previews.createPreviews({
  area: stateArea,
  tabs: api.tabs,
  loadSettings: () => store.loadSettings(),
  isSessionActive: async () => {
    const { state } = await store.load();
    return !!state.session && !sessions.isStale(state.session, Date.now());
  },
});

/** Keys held while browsing when an event doesn't say (the default ⌃Tab holds Control). */
const MODIFIERS = ["Control"];
/** Icons are small data:image URLs made by the content script (never fetched from here). */
const MAX_ICON_CHARS = 8192;
/** Longest the switcher:show path waits for stored previews before sending without them. */
const PREVIEW_BUDGET_MS = 60;
/** Storage keys left behind by the Phase 0 spike probe. */
const SPIKE_LOCAL_KEYS = ["spike", "spike_hb", "spike_notes", "spike_cfg"];
const SPIKE_SESSION_KEYS = ["spikeSession"];

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

async function buildItems(state, order, tabsById, settings) {
  // One storage read for every preview, bounded so a slow read never delays the overlay.
  const shotById = settings?.previews === false ? {} : await shots.getMany(order, { budgetMs: PREVIEW_BUDGET_MS });
  return order.map((tabId) => {
    const t = tabsById?.get(tabId);
    const icon = state.icons[tabId];
    return {
      tabId,
      title: typeof t?.title === "string" ? t.title : "",
      host: hostOf(t?.url),
      icon: validIcon(icon) ? icon : null,
      preview: shotById[tabId] ?? null,
    };
  });
}

async function perform(state, eff, ctx) {
  switch (eff.type) {
    case "show": {
      const items = await buildItems(state, eff.order, ctx.tabsById, ctx.settings);
      const msg = { type: "switcher:show", items, selectedIndex: eff.selectedIndex, modifiers: eff.modifiers ?? MODIFIERS };
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

/**
 * A switch shortcut: from the TabFlip app (senderTab null: the active tab of the focused
 * window), or matched by the content script on the page when the helper isn't running.
 * dir 1 = to older tabs, -1 = back. The keys to hold come from the stored shortcuts,
 * never from the page.
 */
function onPageShortcut(senderTab, dir) {
  job(
    async (state, settings) => {
      const t = await resolveTab(senderTab);
      if (!t) return;
      const tabsById = await syncWindow(state, t.windowId);
      const order = mru.list(state.mru, t.windowId);
      const { next, prev } = settings.shortcuts;
      const modifiers = holdModifiers(next, prev);
      await reduce(state, { type: "flip", windowId: t.windowId, tabId: t.id, dir, modifiers }, { settings, order, tabsById });
    },
    { settings: true }
  );
}

// ---------------------------------------------------------------------------
// Shortcuts from the TabFlip app
//
// Safari won't give an extension ⌃Tab, so the TabFlip app (running in the background) claims
// the user's shortcuts while Safari is in front and sends each press here through the
// app: SFSafariApplication.dispatchMessage arrives on a port opened with connectNative.
//   { name: "flip", userInfo: { dir: 1 | -1 } }   a shortcut was pressed
//   { name: "release" }                           the held modifier was let go

function onAppMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  const name = msg.name ?? msg.type;
  const info = msg.userInfo && typeof msg.userInfo === "object" ? msg.userInfo : msg;
  if (name === "flip") onPageShortcut(null, Number(info.dir) === -1 ? -1 : 1);
  else if (name === "release") job((state) => reduce(state, { type: "release" }));
}

let appPort = null;

/** Open (or reopen) the port the helper's messages arrive on. */
function connectApp() {
  if (appPort || typeof api.runtime.connectNative !== "function") return;
  try {
    const port = api.runtime.connectNative("application.id");
    port.onMessage.addListener(onAppMessage);
    port.onDisconnect?.addListener(() => {
      if (appPort === port) appPort = null;
    });
    appPort = port;
  } catch (e) {
    console.warn("[TabFlip] could not connect to the app", e);
  }
}

// ---------------------------------------------------------------------------
// Tab and window events

function onActivated(info) {
  if (!info || !isId(info.tabId) || !isId(info.windowId)) return;
  job((state) => reduce(state, { type: "activated", windowId: info.windowId, tabId: info.tabId }));
  shots.schedule(info.tabId, info.windowId);
}

function onUpdated(tabId, change, tab) {
  // The active tab finished loading: refresh its preview.
  if (change?.status !== "complete" || !tab?.active || !isId(tab.windowId)) return;
  shots.schedule(tabId, tab.windowId);
}

function onCreated(tab) {
  // Opening an extension page creates a transient tab with windowId -1: ignore it.
  if (!tab || !isId(tab.id) || !isId(tab.windowId)) return;
  job(async (state) => {
    if (tab.active) {
      // Safari sends no onActivated for a tab created already active.
      await reduce(state, { type: "activated", windowId: tab.windowId, tabId: tab.id });
      shots.schedule(tab.id, tab.windowId);
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
  shots.remove(tabId);
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
  // Coming back to Safari, often straight from the TabFlip app: pick up new settings.
  if (windowId !== api.windows.WINDOW_ID_NONE && windowId !== -1) {
    syncFromApp();
    connectApp();
  }
}

// ---------------------------------------------------------------------------
// Settings from the TabFlip app (core/appsync.js)

/** Don't ask the app more than once a second (focus changes come in bursts). */
const SYNC_GAP_MS = 1000;
let lastSyncAt = -Infinity;

/**
 * Ask the app's native handler for the settings and copy them into storage.local.
 * Never blocks event handling; failures (no app, old Safari) leave the stored settings as they are.
 */
function syncFromApp() {
  const now = Date.now();
  if (now - lastSyncAt < SYNC_GAP_MS) return Promise.resolve();
  lastSyncAt = now;
  if (typeof api.runtime.sendNativeMessage !== "function" || !api.storage.local) return Promise.resolve();
  return Promise.resolve()
    .then(() => api.runtime.sendNativeMessage("application.id", { type: "settings:get" }))
    .then(async (reply) => {
      const got = (await api.storage.local.get([SETTINGS_KEY, CLEAR_TOKEN_KEY])) || {};
      const plan = planSync(reply, { settings: got[SETTINGS_KEY], clearToken: got[CLEAR_TOKEN_KEY] });
      if (plan.settings) await api.storage.local.set({ [SETTINGS_KEY]: plan.settings });
      if (plan.clearToken) {
        const result = await clearAllData();
        if (result.ok) await api.storage.local.set({ [CLEAR_TOKEN_KEY]: plan.clearToken });
      }
    })
    .catch((e) => console.warn("[TabFlip] settings sync skipped", e));
}

function onStartupOrInstalled() {
  job((state) => seedInto(state));
  syncFromApp();
  removeSpikeData();
  Promise.resolve()
    .then(() => api.tabs.query({}))
    .then((tabs) => shots.prune(tabs.map((t) => t.id)))
    .catch((e) => console.warn("[TabFlip] preview prune skipped", e));
}

/** One-off cleanup of what the Phase 0 spike probe stored. */
function removeSpikeData() {
  Promise.resolve()
    .then(() =>
      Promise.all([api.storage.local?.remove?.(SPIKE_LOCAL_KEYS), api.storage.session?.remove?.(SPIKE_SESSION_KEYS)])
    )
    .catch(() => undefined);
}

function onStorageChanged(changes, areaName) {
  // Turning previews off deletes the stored pictures (the options page promises this).
  if (areaName !== "local" || !changes?.settings) return;
  const next = changes.settings.newValue;
  if (next && typeof next === "object" && next.previews === false) {
    shots.clearAll().catch((e) => console.warn("[TabFlip] clearing previews failed", e));
  }
}

/**
 * data:clear (the app's "Clear…", via syncFromApp; or an extension page): wipe previews, icons and MRU, then re-seed. Resolves to
 * { ok: true } or { ok: false, error } — never undefined, so the page can confirm.
 */
function clearAllData() {
  return new Promise((resolve) => {
    job(async (state) => {
      try {
        await shots.clearAll();
        if (state.session) await reduce(state, { type: "external", reason: "clear" });
        state.session = null;
        state.mru = mru.empty();
        state.icons = {};
        await seedInto(state);
        // Write directly (store.save only logs failures): the reply must reflect reality.
        await stateArea.set({ [STATE_KEY]: state });
        resolve({ ok: true });
      } catch (e) {
        resolve({ ok: false, error: String((e && e.message) || e || "unknown error") });
      }
    }).then(() => resolve({ ok: false, error: "the background could not load its state" }));
  });
}

// ---------------------------------------------------------------------------
// Messages from content scripts

/** Only small inline raster icons are stored or shown: an icon never causes a request. */
function validIcon(icon) {
  return (
    typeof icon === "string" &&
    icon.length <= MAX_ICON_CHARS &&
    /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/]+=*$/i.test(icon)
  );
}

/**
 * True for our own extension pages (the options page). Safari may or may not attach
 * `sender.tab` for an options page shown in a tab, so decide by the sender's URL.
 */
function isExtensionPage(sender) {
  let base = "";
  try {
    base = typeof api.runtime.getURL === "function" ? api.runtime.getURL("") : "";
  } catch {
    base = "";
  }
  const url = typeof sender.url === "string" ? sender.url : sender.tab?.url;
  if (base && typeof url === "string") return url.startsWith(base);
  return !sender.tab; // nothing to go by: only extension pages send without a tab
}

function onMessage(msg, sender) {
  if (!msg || typeof msg.type !== "string" || !sender) return undefined;
  if (sender.id && api.runtime.id && sender.id !== api.runtime.id) return undefined;
  if (msg.type === "data:clear") {
    // The returned promise is the reply (both reply styles work in Safari; measured).
    return isExtensionPage(sender) ? clearAllData() : undefined;
  }
  if (!sender.tab) return undefined;
  const senderTab = sender.tab;
  switch (msg.type) {
    case "switcher:commit":
      job((state) => reduce(state, { type: "commit", senderTabId: senderTab.id, tabId: msg.tabId }));
      break;
    case "switcher:key":
      onPageShortcut(senderTab, msg.dir === -1 ? -1 : 1);
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
  return undefined; // no reply to content-script messages
}

// ---------------------------------------------------------------------------
// Listeners: synchronous, top level, so a stopped worker is woken for them.

api.tabs.onActivated.addListener(onActivated);
api.tabs.onUpdated?.addListener(onUpdated);
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
api.storage.onChanged?.addListener(onStorageChanged);

// Each time Safari starts this worker, check the app for changed settings and open the
// port the app's key presses arrive on.
syncFromApp();
connectApp();
