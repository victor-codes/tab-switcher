// Tab Switcher background entry (wiring only). Owner: Agent 1.
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
import { buildSnapshot, holdFor, sameContent, shouldPush } from "./core/snapshot.js";

const api = globalThis.browser;
const stateArea = api.storage.session ?? api.storage.local;
const store = createStore(stateArea, api.storage.local);
const queue = createQueue();

/**
 * Previews run on their own serial queue (core/previews.js) so a capture never delays a
 * command. A capture is skipped while a switch session is running.
 */
/** The state area, reporting each stored preview so the app's snapshot can carry it. */
const previewArea = {
  get: (k) => stateArea.get(k),
  remove: (k) => stateArea.remove(k),
  async set(obj) {
    await stateArea.set(obj);
    try {
      for (const key of Object.keys(obj || {})) {
        const id = previews.tabIdOfKey(key);
        if (id !== null) queuePushForTab(id);
      }
    } catch {
      /* a snapshot must never break a capture */
    }
  },
};
const shots = previews.createPreviews({
  area: previewArea,
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

/**
 * Diagnostics: a short line in the Mac's log (through the app's native handler, which
 * writes it with os_log), so a problem can be read afterwards with
 *   log show --last 10m --predicate 'subsystem == "xyz.ayovictor.tabswitcher"'
 * Only event names, counts and timings: never a URL, title or anything from a page.
 */
const INSTANCE = Math.random().toString(36).slice(2, 6);
function diag(what, data = {}) {
  data = { ...data, i: INSTANCE };
  try {
    if (typeof api.runtime.sendNativeMessage !== "function") return;
    Promise.resolve(api.runtime.sendNativeMessage("application.id", { type: "log", what, data })).catch(() => {});
  } catch {
    /* diagnostics must never break anything */
  }
}

/** Resolves when every event received so far has been handled (used by tests). */
export function whenIdle() {
  return Promise.all([queue.idle(), sendChain]).then(() => undefined);
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
    console.warn("[Tab Switcher] seeding failed", e);
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
  let rejected = null;
  const reply = Promise.resolve()
    .then(() => api.tabs.sendMessage(tabId, msg))
    .catch((e) => {
      rejected = String((e && e.message) || e).slice(0, 120) || "rejected";
      return undefined;
    });
  const result = await Promise.race([reply, timeout]);
  clearTimeout(timer);
  if (result === TIMEOUT) return { timedOut: true };
  return { timedOut: false, reply: rejected ? undefined : result, error: rejected };
}

/** Longest a press waits for a fresh copy of the switcher to load into the page. */
const INJECT_BUDGET_MS = 400;
const SWITCHER_FILE = "content/switcher.js";

/**
 * Load the switcher into a page that is already open. Safari only puts it into pages as
 * they load, and each time the extension is updated or turned off and on, the copies in
 * open pages go dead (they can no longer hear the background), so those pages would never
 * show the switcher again until reloaded. Resolves true when the script ran.
 * Fails quietly where Safari allows no script (Start Page, PDFs, denied sites).
 */
function summarize(res) {
  try {
    if (!Array.isArray(res)) return typeof res;
    return res.map((r) => (r && r.error ? "err:" + String(r.error.message || r.error).slice(0, 80) : "f" + r?.frameId + ":" + typeof r?.result)).join(",");
  } catch {
    return "?";
  }
}

/**
 * Hand a message to the page's switcher by running a call in the page, for pages whose
 * messaging is dead (see content/switcher.js, __tabSwitcherDeliver). Resolves with the page's
 * reply, null when the page has no switcher loaded, undefined when no code may run there.
 */
async function execDeliver(tabId, msg, ms = INJECT_BUDGET_MS) {
  if (!isId(tabId) || typeof api.scripting?.executeScript !== "function") return undefined;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  const run = Promise.resolve()
    .then(() =>
      api.scripting.executeScript({
        target: { tabId },
        func: (m) => (typeof globalThis.__tabSwitcherDeliver === "function" ? globalThis.__tabSwitcherDeliver(m) ?? null : null),
        args: [msg],
      })
    )
    .then((res) => (Array.isArray(res) && res[0] && !res[0].error ? res[0].result ?? null : undefined))
    .catch(() => undefined);
  const result = await Promise.race([run, timeout]);
  clearTimeout(timer);
  return result;
}

/** Send to the page's switcher by message, or directly where its messaging is dead. */
async function deliver(tabId, msg) {
  const reply = await send(tabId, msg);
  if (reply !== undefined) return reply;
  return execDeliver(tabId, msg);
}

async function injectSwitcher(tabId) {
  if (!isId(tabId)) return { ok: false, error: "no tab" };
  if (typeof api.scripting?.executeScript !== "function") return { ok: false, error: "no scripting API" };
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: "timeout" }), INJECT_BUDGET_MS);
  });
  const run = Promise.resolve()
    .then(() => api.scripting.executeScript({ target: { tabId }, files: [SWITCHER_FILE] }))
    .then((res) => {
      const sum = summarize(res);
      return sum.startsWith("err:") ? { ok: false, error: sum.slice(4) } : { ok: true, res: sum };
    })
    .catch((e) => ({ ok: false, error: String((e && e.message) || e).slice(0, 120) }));
  const result = await Promise.race([run, timeout]);
  clearTimeout(timer);
  return result;
}

/** Marks (per extension load) that open pages were already checked by healOpenTabs. */
const HEALED_KEY = "healed";

/**
 * Give every open page that has no live switcher a fresh one. Runs once each time the
 * extension is loaded (install, update, turned on, Safari start), off the event queue.
 */
async function healOpenTabs({ force = false } = {}) {
  try {
    if (!force && (await stateArea.get(HEALED_KEY))?.[HEALED_KEY]) return;
    await stateArea.set({ [HEALED_KEY]: true });
    const tabs = await api.tabs.query({});
    const count = { tabs: tabs.length, noUrl: 0, alive: 0, slow: 0, injected: 0, failed: 0, error: "" };
    await Promise.all(
      tabs.map(async (t) => {
        if (!isId(t.id) || !t.url) return void count.noUrl++; // empty or not yet loaded: Safari will load it itself
        const r = await sendWithTimeout(t.id, { type: "switcher:ping" }, 1000);
        if (r.timedOut) return void count.slow++;
        if (r.reply?.ok === true) return void count.alive++;
        const done = await injectSwitcher(t.id);
        if (done.ok) {
          count.injected++;
          const again = await sendWithTimeout(t.id, { type: "switcher:ping" }, 1000);
          if (again.reply?.ok === true) count.revived = (count.revived || 0) + 1;
          else if ((await execDeliver(t.id, { type: "switcher:ping" }))?.ok === true) count.direct = (count.direct || 0) + 1;
          else count.deaf = (count.deaf || 0) + 1;
        } else {
          count.failed++;
          count.error ||= done.error;
        }
      })
    );
    diag("heal", count);
  } catch (e) {
    console.warn("[Tab Switcher] checking open pages failed", e);
  }
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
      const msg = { type: "switcher:show", items, selectedIndex: eff.selectedIndex, modifiers: eff.modifiers ?? MODIFIERS, assumeHeld: eff.assumeHeld === true };
      const t0 = Date.now();
      let r = await sendWithTimeout(eff.tabId, msg, eff.ackTimeoutMs);
      const first = r.timedOut ? "timeout" : r.reply === undefined ? "none" : "reply";
      let injected = null;
      // No answer at all: the page's copy of the switcher is missing or dead (see
      // injectSwitcher). Put a fresh one in and ask once more before giving up on it.
      let via = "message";
      if (first === "none") {
        // Dead messaging but a live copy (loaded by healOpenTabs): call it directly.
        let direct = await execDeliver(eff.tabId, msg);
        if (direct === null) {
          injected = await injectSwitcher(eff.tabId);
          if (injected.ok) direct = await execDeliver(eff.tabId, msg);
        }
        if (direct) {
          r = { timedOut: false, reply: direct };
          via = "direct";
        }
      }
// Logged only when the switcher did not appear, so a failure can be read afterwards.
      if (r.timedOut || r.reply?.shown !== true)
        diag("show", {
          first,
          injected: injected && (injected.ok ? "ok" : injected.error),
          via,
          final: r.timedOut ? "timeout" : r.reply === undefined ? "none" : r.reply?.shown === true ? "shown" : "notShown",
          hasFocus: r.reply?.hasFocus,
          held: r.reply?.modifiersHeld,
          items: items.length,
          hasUrl: !!ctx.tabsById?.get(eff.tabId)?.url,
          ms: Date.now() - t0,
        });
      return r.timedOut ? { type: "ackTimeout", token: eff.token } : { type: "ack", token: eff.token, reply: r.reply };
    }
    case "move":
      deliver(eff.tabId, { type: "switcher:move", selectedIndex: eff.selectedIndex });
      return null;
    case "hide":
      deliver(eff.tabId, { type: "switcher:hide" });
      return null;
    case "activate":
      try {
        await api.tabs.update(eff.tabId, { active: true });
      } catch (e) {
        console.warn("[Tab Switcher] activate failed", eff.tabId, e);
      }
      return null;
    case "remove":
      try {
        await api.tabs.remove(eff.tabId);
      } catch (e) {
        console.warn("[Tab Switcher] remove failed", eff.tabId, e);
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
    console.warn("[Tab Switcher] tabs.query failed", e);
  }
  if (tabs.length) state.mru = mru.syncWindow(state.mru, windowId, tabs);
  return new Map(tabs.map((t) => [t.id, t]));
}

/**
 * A switch shortcut: from the Tab Switcher app (senderTab null: the active tab of the focused
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
      await reduce(state, { type: "flip", windowId: t.windowId, tabId: t.id, dir, modifiers, trusted: !senderTab }, { settings, order, tabsById });
    },
    { settings: true }
  );
}

// ---------------------------------------------------------------------------
// Shortcuts from the Tab Switcher app
//
// Safari won't give an extension ⌃Tab, so the Tab Switcher app (running in the background) claims
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
  else if (name === "activate") onActivate(info.windowId, info.tabId);
  else if (name === "snapshot:request") {
    // The app has no snapshot (it just started, or Safari came back without one): push
    // every window again, even if unchanged since the last push.
    lastPushed.clear();
    queuePushAll();
  }
}

/**
 * The panel in the app chose a tab. Both backgrounds get this; the one that does not know
 * the tab in that window (the empty one) ignores it silently.
 */
function onActivate(windowId, tabId) {
  if (!isId(windowId) || !isId(tabId)) return;
  job(async (state) => {
    if (!mru.list(state.mru, windowId).includes(tabId)) return;
    try {
      await api.tabs.update(tabId, { active: true });
    } catch (e) {
      console.warn("[Tab Switcher] activate failed", tabId, e);
      return;
    }
    state.mru = mru.activated(state.mru, windowId, tabId);
  });
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
      diag("port closed");
    });
    appPort = port;
  } catch (e) {
    console.warn("[Tab Switcher] could not connect to the app", e);
  }
}

// ---------------------------------------------------------------------------
// Snapshots for the app's panel (core/snapshot.js)
//
// The app draws the switcher from the latest snapshot of each window, pushed here through
// the native handler. Held in memory only: after an unload the instance id changes, so the
// app takes the first push of the new copy whatever its seq.

/** windowId -> { snap, at } of the last push (snap.focused is kept current by focus changes). */
const lastPushed = new Map();
/** windowId -> timer of a push held back by the throttle. */
const holdTimers = new Map();
/** Pushes go out one after another, in order, without blocking the event queue. */
let sendChain = Promise.resolve();
let pushSeq = 0;
let focusedWindowId = null;

async function currentFocusedWindow() {
  if (isId(focusedWindowId)) return focusedWindowId;
  try {
    const [active] = await api.tabs.query({ active: true, currentWindow: true });
    if (active && isId(active.windowId)) focusedWindowId = active.windowId;
  } catch {
    /* unknown: nothing is marked focused */
  }
  return focusedWindowId;
}

/** Build the window's snapshot and push it unless it is empty, unchanged or throttled. */
async function pushWindow(state, windowId, settings, onlyTabId) {
  if (settings.panel === false || !isId(windowId) || typeof api.runtime.sendNativeMessage !== "function") return;
  const tabsById = await syncWindow(state, windowId);
  const order = mru.list(state.mru, windowId);
  if (onlyTabId !== undefined && !order.slice(0, settings.maxItems).includes(onlyTabId)) return;
  const priv = [...tabsById.values()].some((t) => t.incognito === true);
  const shotById = settings.previews === false || priv ? {} : await shots.getMany(order.slice(0, settings.maxItems), { budgetMs: PREVIEW_BUDGET_MS });
  const snap = buildSnapshot({
    instance: INSTANCE,
    seq: pushSeq + 1,
    windowId,
    focused: windowId === (await currentFocusedWindow()),
    private: priv,
    order,
    tabsById,
    icons: state.icons,
    previews: shotById,
    settings,
  });
  if (!snap) return; // this copy sees no tabs: stay silent
  const now = Date.now();
  const last = lastPushed.get(windowId);
  if (!shouldPush(last?.snap, snap, now, last?.at)) {
    const wait = holdFor(now, last?.at);
    if (wait > 0 && !sameContent(last?.snap, snap) && !holdTimers.has(windowId)) {
      holdTimers.set(
        windowId,
        setTimeout(() => {
          holdTimers.delete(windowId);
          queuePush(windowId);
        }, wait)
      );
    }
    return;
  }
  pushSeq = snap.seq;
  lastPushed.set(windowId, { snap, at: now });
  sendChain = sendChain.then(async () => {
    const t0 = Date.now();
    let delivered = null;
    try {
      const reply = await api.runtime.sendNativeMessage("application.id", { type: "snapshot:push", snapshot: snap });
      delivered = reply?.delivered === true;
    } catch {
      delivered = false;
    }
    // Not delivered (the app is not running yet, or is starting): forget it, so the next
    // change pushes again instead of being dropped as "unchanged".
    if (!delivered && lastPushed.get(windowId)?.snap === snap) lastPushed.delete(windowId);
    diag("snapshot", { w: windowId, seq: snap.seq, items: snap.items.length, previews: snap.items.filter((i) => i.preview).length, focused: snap.focused, delivered, ms: Date.now() - t0 });
  });
}

function queuePush(windowId, onlyTabId) {
  if (!isId(windowId)) return Promise.resolve();
  return job((state, settings) => pushWindow(state, windowId, settings, onlyTabId), { settings: true });
}

function queuePushForTab(tabId) {
  return job(
    async (state, settings) => {
      const windowId = mru.windowOf(state.mru, tabId);
      if (isId(windowId)) await pushWindow(state, windowId, settings);
    },
    { settings: true }
  );
}

/** Every window this copy knows (start, settings turned on). */
function queuePushAll() {
  return job(
    async (state, settings) => {
      let tabs = [];
      try {
        tabs = await api.tabs.query({});
      } catch {
        return;
      }
      for (const w of new Set(tabs.map((t) => t.windowId))) await pushWindow(state, w, settings);
    },
    { settings: true }
  );
}

// ---------------------------------------------------------------------------
// Tab and window events

function onActivated(info) {
  if (!info || !isId(info.tabId) || !isId(info.windowId)) return;
  job((state) => reduce(state, { type: "activated", windowId: info.windowId, tabId: info.tabId }));
  shots.schedule(info.tabId, info.windowId);
  queuePush(info.windowId);
}

function onUpdated(tabId, change, tab) {
  // A listed tab's title or address changed: the app's list shows both.
  if ((change?.title !== undefined || change?.url !== undefined) && isId(tab?.windowId)) queuePush(tab.windowId, tabId);
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
  queuePush(tab.windowId);
}

function onRemoved(tabId, info) {
  job(async (state) => {
    state.mru = mru.removed(state.mru, info?.windowId, tabId);
    delete state.icons[tabId];
    await reduce(state, { type: "external", reason: "removed" });
  });
  shots.remove(tabId);
  if (!info?.isWindowClosing) queuePush(info?.windowId);
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
  queuePush(info?.newWindowId);
}

function onDetached(tabId, info) {
  job(async (state) => {
    state.mru = mru.detached(state.mru, info?.oldWindowId, tabId);
    await reduce(state, { type: "external", reason: "detached" });
  });
  queuePush(info?.oldWindowId);
}

function onWindowRemoved(windowId) {
  lastPushed.delete(windowId);
  clearTimeout(holdTimers.get(windowId));
  holdTimers.delete(windowId);
  if (focusedWindowId === windowId) focusedWindowId = null;
  job(async (state) => {
    state.mru = mru.windowRemoved(state.mru, windowId);
    if (state.session && state.session.windowId === windowId) {
      await reduce(state, { type: "external", reason: "windowRemoved" });
    }
  });
}

/**
 * Tell the app which browser window has focus: its id, or null when none does (Safari's
 * Settings window and other non-browser windows, or another app in front). While it is
 * null the app lets go of the shortcuts, so they do nothing there. `bounds` (screen
 * points, top-left origin, or null) lets the panel find that window on screen rather
 * than centring on whichever Safari window is listed first, such as an open Settings window.
 */
function pushFocus(windowId) {
  if (typeof api.runtime.sendNativeMessage !== "function") return;
  const id = isId(windowId) ? windowId : null;
  sendChain = sendChain.then(async () => {
    let bounds = null;
    if (id !== null && typeof api.windows.get === "function") {
      try {
        const w = await api.windows.get(id);
        if ([w?.left, w?.top, w?.width, w?.height].every(Number.isFinite)) {
          bounds = { x: w.left, y: w.top, width: w.width, height: w.height };
        }
      } catch {
        /* no bounds: the panel centres on the front Safari window */
      }
    }
    let delivered = false;
    try {
      const reply = await api.runtime.sendNativeMessage("application.id", { type: "focus:push", windowId: id, bounds });
      delivered = reply?.delivered === true;
    } catch {
      /* the app is not running: nothing to tell */
    }
    diag("focus", { w: id, bounds, delivered });
  });
}

function onFocusChanged(windowId) {
  job((state) => reduce(state, { type: "focusChanged", windowId }));
  pushFocus(windowId);
  // Coming back to Safari, often straight from the Tab Switcher app: pick up new settings.
  if (windowId !== api.windows.WINDOW_ID_NONE && windowId !== -1) {
    // The window that was focused is not any more: its last push must not count as "same".
    const was = lastPushed.get(focusedWindowId);
    if (was && focusedWindowId !== windowId) was.snap = { ...was.snap, focused: false };
    focusedWindowId = isId(windowId) ? windowId : focusedWindowId;
    syncFromApp();
    connectApp();
    queuePush(windowId);
  }
}

// ---------------------------------------------------------------------------
// Settings from the Tab Switcher app (core/appsync.js)

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
    .catch((e) => console.warn("[Tab Switcher] settings sync skipped", e));
}

function onStartupOrInstalled() {
  job((state) => seedInto(state));
  queuePushAll();
  syncFromApp();
  removeSpikeData();
  healOpenTabs({ force: true });
  Promise.resolve()
    .then(() => api.tabs.query({}))
    .then((tabs) => shots.prune(tabs.map((t) => t.id)))
    .catch((e) => console.warn("[Tab Switcher] preview prune skipped", e));
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
  // Panel turned off: the app forgets its snapshots, so forget what was pushed. Anything
  // else (turned on, maxItems, previews): push again.
  if (next?.panel === false) {
    lastPushed.clear();
  } else {
    queuePushAll();
  }
  if (next && typeof next === "object" && next.previews === false) {
    shots.clearAll().catch((e) => console.warn("[Tab Switcher] clearing previews failed", e));
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
  if (msg.type === "keepalive") {
    // A visible page wakes this background every 20 seconds (content/switcher.js) so it
    // stays loaded for the app's key presses; make sure their port is open.
    connectApp();
    return undefined;
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
queuePushAll();
healOpenTabs();
Promise.resolve()
  .then(() => api.permissions?.contains?.({ origins: ["<all_urls>"] }))
  .then((all) => diag("start", { allSites: all, scripting: typeof api.scripting?.executeScript === "function", port: !!appPort }))
  .catch((e) => diag("start", { error: String(e).slice(0, 120) }));

// Safari unloads an idle background after about 30 seconds, and a key press the app
// sends while it is unloaded is dropped (dispatchMessage does not wake it). Visible
// pages ping it (content/switcher.js), but nothing runs on the Start Page or on sites
// Tab Switcher may not access, so an alarm also wakes it every 30 seconds.
api.alarms?.create?.("keepalive", { periodInMinutes: 0.5 });
api.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm?.name === "keepalive") connectApp();
});

