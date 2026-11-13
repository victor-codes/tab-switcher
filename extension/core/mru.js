// TabFlip core/mru.js. Owner: Agent 1.
//
// Per-window most-recently-used tab order. Pure: no browser API, no mutation.
// State: { windows: { [windowId]: number[] /* tabIds, most recent first */ } }
// Every function tolerates unknown ids and malformed state and never throws.

/** A fresh, empty MRU state. */
export function empty() {
  return { windows: {} };
}

function isId(v) {
  return Number.isInteger(v) && v >= 0;
}

function key(windowId) {
  return String(windowId);
}

/** Returns a well-formed copy-on-write view of `state` (arrays are not copied). */
export function normalize(state) {
  const out = { windows: {} };
  const src = state && typeof state === "object" && state.windows && typeof state.windows === "object" ? state.windows : {};
  for (const [k, ids] of Object.entries(src)) {
    if (!Array.isArray(ids)) continue;
    const clean = ids.filter(isId);
    if (clean.length) out.windows[k] = clean;
  }
  return out;
}

function withWindows(state, windows) {
  const next = {};
  for (const [k, ids] of Object.entries(windows)) if (ids.length) next[k] = ids;
  return { windows: next };
}

function withoutTab(windows, tabId) {
  const next = {};
  for (const [k, ids] of Object.entries(windows)) next[k] = ids.includes(tabId) ? ids.filter((id) => id !== tabId) : ids;
  return next;
}

/** Tab ids of `windowId`, most recent first (a copy; [] when unknown). */
export function list(state, windowId) {
  const ids = normalize(state).windows[key(windowId)];
  return ids ? ids.slice() : [];
}

/** The window id that holds `tabId`, or null. */
export function windowOf(state, tabId) {
  for (const [k, ids] of Object.entries(normalize(state).windows)) if (ids.includes(tabId)) return Number(k);
  return null;
}

/** `tabId` became active in `windowId`: move it to the front (removing it from any other window). */
export function activated(state, windowId, tabId) {
  const s = normalize(state);
  if (!isId(windowId) || !isId(tabId)) return s;
  const windows = withoutTab(s.windows, tabId);
  windows[key(windowId)] = [tabId, ...(windows[key(windowId)] || [])];
  return withWindows(s, windows);
}

/** A background tab was created: append it (no-op if the id is already known anywhere). */
export function created(state, windowId, tabId) {
  const s = normalize(state);
  if (!isId(windowId) || !isId(tabId) || windowOf(s, tabId) !== null) return s;
  const windows = { ...s.windows };
  windows[key(windowId)] = [...(windows[key(windowId)] || []), tabId];
  return withWindows(s, windows);
}

/** `tabId` was closed. The window hint is ignored: the id is removed wherever it is. */
export function removed(state, _windowId, tabId) {
  const s = normalize(state);
  return withWindows(s, withoutTab(s.windows, tabId));
}

/** `tabId` was attached to `windowId`: drop it elsewhere, append it here if absent. */
export function attached(state, windowId, tabId) {
  const s = normalize(state);
  if (!isId(windowId) || !isId(tabId)) return s;
  const own = s.windows[key(windowId)] || [];
  if (own.includes(tabId)) return s;
  const windows = withoutTab(s.windows, tabId);
  windows[key(windowId)] = [...own, tabId];
  return withWindows(s, windows);
}

/** `tabId` was detached from `windowId`. */
export function detached(state, windowId, tabId) {
  const s = normalize(state);
  const own = s.windows[key(windowId)];
  if (!own || !own.includes(tabId)) return s;
  return withWindows(s, { ...s.windows, [key(windowId)]: own.filter((id) => id !== tabId) });
}

/** `oldId` was replaced by `newId`: `newId` takes `oldId`'s position. No-op if `oldId` is unknown. */
export function replaced(state, oldId, newId) {
  const s = normalize(state);
  if (!isId(newId) || oldId === newId || windowOf(s, oldId) === null) return s;
  const windows = withoutTab(s.windows, newId);
  for (const [k, ids] of Object.entries(windows)) {
    const i = ids.indexOf(oldId);
    if (i !== -1) windows[k] = [...ids.slice(0, i), newId, ...ids.slice(i + 1)];
  }
  return withWindows(s, windows);
}

/** The window closed. */
export function windowRemoved(state, windowId) {
  const s = normalize(state);
  const windows = { ...s.windows };
  delete windows[key(windowId)];
  return withWindows(s, windows);
}

function groupByWindow(tabs) {
  const byWindow = new Map();
  for (const t of Array.isArray(tabs) ? tabs : []) {
    if (!t || !isId(t.id) || !isId(t.windowId)) continue; // windowId -1: not in a window yet
    if (!byWindow.has(t.windowId)) byWindow.set(t.windowId, []);
    byWindow.get(t.windowId).push(t);
  }
  for (const group of byWindow.values()) group.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return byWindow;
}

function merge(existing, windowTabs, putActiveFirst) {
  const present = new Set(windowTabs.map((t) => t.id));
  const active = putActiveFirst ? windowTabs.find((t) => t.active) : undefined;
  const out = active ? [active.id] : [];
  for (const id of existing) if (present.has(id) && !out.includes(id)) out.push(id);
  for (const t of windowTabs) if (!out.includes(t.id)) out.push(t.id);
  return out;
}

/**
 * Rebuild from a full `tabs.query({})` snapshot. Per window: the active tab first, then ids
 * already known in their existing order, then unknown ids in tab-strip order. Windows and
 * tabs absent from the snapshot are dropped.
 */
export function seed(state, tabs) {
  const s = normalize(state);
  const windows = {};
  for (const [windowId, group] of groupByWindow(tabs)) {
    windows[key(windowId)] = merge(s.windows[key(windowId)] || [], group, true);
  }
  return withWindows(s, windows);
}

/**
 * Reconcile one window with `tabs.query({ windowId })`: drop ids that no longer exist there,
 * append unknown ids in tab-strip order. Never reorders known ids (safe during a session).
 */
export function syncWindow(state, windowId, tabs) {
  const s = normalize(state);
  if (!isId(windowId)) return s;
  const group = (Array.isArray(tabs) ? tabs : []).filter((t) => t && isId(t.id) && t.windowId === windowId);
  group.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const windows = { ...s.windows };
  // An id now in this window must not linger in another one.
  for (const t of group) {
    for (const [k, ids] of Object.entries(windows)) {
      if (k !== key(windowId) && ids.includes(t.id)) windows[k] = ids.filter((id) => id !== t.id);
    }
  }
  windows[key(windowId)] = merge(windows[key(windowId)] || [], group, false);
  return withWindows(s, windows);
}
