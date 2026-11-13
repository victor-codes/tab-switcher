// TabFlip core/store.js. Owner: Agent 1.
//
// Write-through persistence for the non-persistent background, plus a serial queue so
// events are handled one at a time in arrival order.
//
// State (browser.storage.session, key "state"): { mru, session, icons: { [tabId]: dataUrl } }
// (Previews are stored beside it under "preview:<tabId>" by core/previews.js.)
// Settings (browser.storage.local, key "settings"): { overlay, previews, maxItems }

import { normalize as normalizeMru } from "./mru.js";

export const STATE_KEY = "state";
export const SETTINGS_KEY = "settings";
export const DEFAULT_SETTINGS = Object.freeze({ overlay: true, previews: true, maxItems: 8 });

/** A fresh, empty state. */
export function emptyState() {
  return { mru: { windows: {} }, session: null, icons: {} };
}

/** Coerce whatever storage returned into a well-formed state. */
export function normalizeState(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const icons = {};
  if (s.icons && typeof s.icons === "object") {
    for (const [k, v] of Object.entries(s.icons)) if (typeof v === "string") icons[k] = v;
  }
  const session = s.session && typeof s.session === "object" && Array.isArray(s.session.order) ? s.session : null;
  if (session && !Array.isArray(session.expect)) session.expect = [];
  return { mru: normalizeMru(s.mru), session, icons };
}

/** Coerce stored settings, filling defaults. */
export function normalizeSettings(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const maxItems = Number.isInteger(s.maxItems) && s.maxItems >= 2 && s.maxItems <= 50 ? s.maxItems : DEFAULT_SETTINGS.maxItems;
  return {
    overlay: typeof s.overlay === "boolean" ? s.overlay : DEFAULT_SETTINGS.overlay,
    previews: typeof s.previews === "boolean" ? s.previews : DEFAULT_SETTINGS.previews,
    maxItems,
  };
}

/**
 * Store over a `storage.StorageArea`-like object (get/set returning promises).
 * `load()` resolves to { state, fresh } where `fresh` is true when nothing was stored yet
 * (first wake since Safari started, or after an install): the caller should seed.
 */
export function createStore(area, localArea) {
  return {
    async load() {
      let got = {};
      try {
        got = (await area.get(STATE_KEY)) || {};
      } catch (e) {
        console.warn("[TabFlip] state load failed", e);
      }
      const raw = got[STATE_KEY];
      return { state: normalizeState(raw), fresh: raw === undefined || raw === null };
    },
    async save(state) {
      try {
        await area.set({ [STATE_KEY]: state });
      } catch (e) {
        console.warn("[TabFlip] state save failed", e);
      }
    },
    async loadSettings() {
      if (!localArea) return { ...DEFAULT_SETTINGS };
      try {
        const got = (await localArea.get(SETTINGS_KEY)) || {};
        return normalizeSettings(got[SETTINGS_KEY]);
      } catch (e) {
        return { ...DEFAULT_SETTINGS };
      }
    },
  };
}

/**
 * A serial promise queue. `enqueue(fn)` runs `fn` after every earlier job settled and
 * resolves to its result; a failing job is logged, resolves to undefined and does not block
 * later ones (the returned promise never rejects, so listeners can fire and forget).
 * `idle()` resolves once everything enqueued so far has settled.
 */
export function createQueue() {
  let tail = Promise.resolve();
  return {
    enqueue(fn) {
      const run = tail.then(() => fn()).catch((e) => {
        console.error("[TabFlip] event handler failed", e);
        return undefined;
      });
      tail = run;
      return run;
    },
    idle() {
      return tail;
    },
  };
}
