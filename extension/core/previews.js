// TabFlip core/previews.js. Owner: Agent 4.
//
// Thumbnail previews of tabs for the switcher overlay (F4), kept private (F6).
//
// Storage (browser.storage.session, so previews vanish when Safari quits):
//   "preview:<tabId>" -> { dataUrl: "data:image/jpeg;base64,...", at: ms }
//   "previewIndex"    -> { [tabId]: at }   small index used for throttling and eviction,
//                                           so no code path ever has to read every image.
//
// The background is a service worker that Safari stops ~29 s after its last event, so:
// - every decision reads storage (throttle times live in the index, not in memory);
// - the only in-memory state is the pending capture timers, which are best effort: if the
//   worker dies before one fires, that capture is simply skipped;
// - work is serialised on a local queue so index read-modify-writes never interleave.
//
// Pure helpers (exported, tested in tests/previews.test.js): captureDecision, evict,
// pruneIndex, normalizeIndex, cropRect, previewKey, tabIdOfKey, isPreviewDataUrl.

export const PREVIEW_PREFIX = "preview:";
export const INDEX_KEY = "previewIndex";
export const MAX_PREVIEWS = 60;
/** At most one capture per tab per this interval. */
export const MIN_INTERVAL_MS = 5000;
/** Delay after activation / load before capturing (lets the page paint). */
export const SETTLE_MS = 600;
/** When a capture was skipped because a switch session was running, try again after this. */
export const SESSION_RETRY_MS = 1200;
export const SESSION_RETRIES = 3;
export const PREVIEW_WIDTH = 480;
/** The overlay shows previews at 16:10, top-aligned; anything below that is never seen. */
export const PREVIEW_ASPECT = 10 / 16;
export const PREVIEW_QUALITY = 0.6;
/** Largest stored preview (characters of the data URL); larger results are dropped. */
export const MAX_PREVIEW_CHARS = 200 * 1024;

function isId(v) {
  return Number.isInteger(v) && v >= 0;
}

export function previewKey(tabId) {
  return PREVIEW_PREFIX + tabId;
}

/** The tab id of a "preview:<id>" key, or null. */
export function tabIdOfKey(key) {
  if (typeof key !== "string" || !key.startsWith(PREVIEW_PREFIX)) return null;
  const rest = key.slice(PREVIEW_PREFIX.length);
  if (!/^\d+$/.test(rest)) return null;
  const n = Number(rest);
  return isId(n) ? n : null;
}

export function isPreviewDataUrl(v) {
  return typeof v === "string" && v.length <= MAX_PREVIEW_CHARS && /^data:image\/(jpeg|png|webp);base64,/i.test(v);
}

/** Coerce a stored index into { [tabId]: at } with numeric values only. */
export function normalizeIndex(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw)) {
    if (/^\d+$/.test(k) && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/**
 * Whether `tab` may be captured now. Returns { ok: true } or { ok: false, reason }.
 * ctx: { settings, sessionActive, lastAt, now }
 * Reasons: "disabled", "notab", "incognito", "inactive", "nourl", "loading", "session", "throttled".
 */
export function captureDecision(tab, ctx = {}) {
  const now = Number.isFinite(ctx.now) ? ctx.now : 0;
  if (ctx.settings && ctx.settings.previews === false) return { ok: false, reason: "disabled" };
  if (!tab || !isId(tab.id) || !isId(tab.windowId)) return { ok: false, reason: "notab" };
  if (tab.incognito) return { ok: false, reason: "incognito" };
  if (!tab.active) return { ok: false, reason: "inactive" };
  // Measured: capture fails without a URL and yields a blank image while loading.
  if (typeof tab.url !== "string" || !tab.url) return { ok: false, reason: "nourl" };
  if (tab.status !== "complete") return { ok: false, reason: "loading" };
  // The overlay (or a fallback hop) would be in the picture.
  if (ctx.sessionActive) return { ok: false, reason: "session" };
  if (Number.isFinite(ctx.lastAt) && now - ctx.lastAt < MIN_INTERVAL_MS && now >= ctx.lastAt) {
    return { ok: false, reason: "throttled" };
  }
  return { ok: true };
}

/**
 * Keep at most `max` entries, dropping the least recently captured first.
 * Returns { index, drop: number[] } without mutating the input.
 */
export function evict(index, max = MAX_PREVIEWS) {
  const entries = Object.entries(normalizeIndex(index)).sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]));
  const keep = entries.slice(0, Math.max(0, max));
  const drop = entries.slice(Math.max(0, max)).map(([k]) => Number(k));
  return { index: Object.fromEntries(keep), drop };
}

/** Drop entries whose tab no longer exists. Returns { index, drop: number[] }. */
export function pruneIndex(index, liveIds) {
  const live = new Set(Array.from(liveIds || [], Number));
  const next = {};
  const drop = [];
  for (const [k, v] of Object.entries(normalizeIndex(index))) {
    if (live.has(Number(k))) next[k] = v;
    else drop.push(Number(k));
  }
  return { index: next, drop };
}

/**
 * Source and destination rectangles for the downscale: keep the top 16:10 of the capture
 * (what the overlay shows), scaled to `width` (never upscaled).
 */
export function cropRect(srcW, srcH, width = PREVIEW_WIDTH, aspect = PREVIEW_ASPECT) {
  const sw = Math.max(1, Math.round(srcW) || 1);
  const sh = Math.max(1, Math.min(Math.round(srcH) || 1, Math.round(sw * aspect)));
  const dw = Math.max(1, Math.min(width, sw));
  const dh = Math.max(1, Math.round((dw * sh) / sw));
  return { sx: 0, sy: 0, sw, sh, dw, dh };
}

// ---------------------------------------------------------------------------
// Image helpers (service worker globals: createImageBitmap, OffscreenCanvas, atob, btoa)

function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(",");
  const mime = (/^data:([^;,]+)/.exec(dataUrl) || [])[1] || "application/octet-stream";
  const bin = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return `data:${blob.type || "image/jpeg"};base64,${btoa(bin)}`;
}

/** Downscale a captureVisibleTab data URL to a small JPEG data URL (measured: a few ms). */
export async function downscale(dataUrl, { width = PREVIEW_WIDTH, quality = PREVIEW_QUALITY } = {}) {
  const bmp = await createImageBitmap(dataUrlToBlob(dataUrl));
  try {
    const r = cropRect(bmp.width, bmp.height, width);
    const canvas = new OffscreenCanvas(r.dw, r.dh);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(bmp, r.sx, r.sy, r.sw, r.sh, 0, 0, r.dw, r.dh);
    const out = await canvas.convertToBlob({ type: "image/jpeg", quality });
    return blobToDataUrl(out);
  } finally {
    if (typeof bmp.close === "function") bmp.close();
  }
}

// ---------------------------------------------------------------------------
// Storage-backed service

/** A serial runner whose returned promise carries the job's own result or rejection. */
function serial() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

/**
 * deps: {
 *   area,              storage.session-like ({ get, set, remove })
 *   tabs,              browser.tabs ({ get, query, captureVisibleTab })
 *   loadSettings,      async () => settings
 *   isSessionActive,   async () => boolean (a switch session is running)
 *   now?, encode?, setTimer?, clearTimer?
 * }
 */
export function createPreviews(deps) {
  const {
    area,
    tabs,
    loadSettings = async () => ({ previews: true }),
    isSessionActive = async () => false,
    now = () => Date.now(),
    encode = downscale,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (t) => clearTimeout(t),
  } = deps || {};
  const run = serial();
  /** Pending capture timers by window id (best effort; lost if the worker stops). */
  const timers = new Map();

  async function readIndex() {
    const got = (await area.get(INDEX_KEY)) || {};
    return normalizeIndex(got[INDEX_KEY]);
  }

  async function removeKeys(keys) {
    if (keys.length && typeof area.remove === "function") await area.remove(keys);
  }

  /** One capture attempt for `tabId`. Resolves to the decision reason ("ok" when stored). */
  async function captureNow(tabId) {
    return run(async () => {
      const settings = await loadSettings();
      if (settings && settings.previews === false) return "disabled";
      if (typeof tabs?.get !== "function" || typeof tabs?.captureVisibleTab !== "function") return "unsupported";
      let tab;
      try {
        tab = await tabs.get(tabId);
      } catch {
        return "notab";
      }
      const index = await readIndex();
      const d = captureDecision(tab, { settings, sessionActive: await isSessionActive(), lastAt: index[tabId], now: now() });
      if (!d.ok) return d.reason;

      const raw = await tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 80 });
      // The user may have switched tabs or started a gesture while we captured.
      const [active] = await tabs.query({ active: true, windowId: tab.windowId });
      if (!active || active.id !== tabId) return "inactive";
      if (await isSessionActive()) return "session";
      if (typeof raw !== "string" || !raw.startsWith("data:image/")) return "failed";

      const dataUrl = await encode(raw);
      if (!isPreviewDataUrl(dataUrl)) return "failed";
      const at = now();
      const ev = evict({ ...index, [tabId]: at }, MAX_PREVIEWS);
      await area.set({ [previewKey(tabId)]: { dataUrl, at }, [INDEX_KEY]: ev.index });
      await removeKeys(ev.drop.map(previewKey));
      return "ok";
    }).catch((e) => {
      console.warn("[TabFlip] preview capture failed", tabId, e);
      return "error";
    });
  }

  /**
   * Capture `tabId` after `delay` ms, replacing any capture pending for the same window
   * (debounce). Retries a few times if a switch session was running.
   */
  function schedule(tabId, windowId, delay = SETTLE_MS, retries = SESSION_RETRIES) {
    if (!isId(tabId) || !isId(windowId)) return;
    const prev = timers.get(windowId);
    if (prev !== undefined) clearTimer(prev);
    const t = setTimer(async () => {
      if (timers.get(windowId) === t) timers.delete(windowId);
      const reason = await captureNow(tabId);
      if (reason === "session" && retries > 0 && !timers.has(windowId)) {
        schedule(tabId, windowId, SESSION_RETRY_MS, retries - 1);
      }
    }, delay);
    timers.set(windowId, t);
  }

  function cancelAll() {
    for (const t of timers.values()) clearTimer(t);
    timers.clear();
  }

  /**
   * Previews for `tabIds` with a single storage read: resolves to { [tabId]: dataUrl }.
   * If `budgetMs` is given and storage is slower, resolves to {} rather than delay the caller.
   */
  async function getMany(tabIds, { budgetMs } = {}) {
    const ids = (Array.isArray(tabIds) ? tabIds : []).filter(isId);
    if (!ids.length) return {};
    const read = (async () => {
      const got = (await area.get(ids.map(previewKey))) || {};
      const out = {};
      for (const id of ids) {
        const v = got[previewKey(id)];
        if (v && isPreviewDataUrl(v.dataUrl)) out[id] = v.dataUrl;
      }
      return out;
    })().catch(() => ({}));
    if (!(budgetMs > 0)) return read;
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve({}), budgetMs);
    });
    const r = await Promise.race([read, late]);
    clearTimeout(timer);
    return r;
  }

  async function get(tabId) {
    const m = await getMany([tabId]);
    return m[tabId] ?? null;
  }

  /** Forget one tab's preview (tab closed). */
  function remove(tabId) {
    if (!isId(tabId)) return Promise.resolve();
    return run(async () => {
      const index = await readIndex();
      await removeKeys([previewKey(tabId)]);
      if (index[tabId] !== undefined) {
        delete index[tabId];
        await area.set({ [INDEX_KEY]: index });
      }
    }).catch((e) => console.warn("[TabFlip] preview remove failed", tabId, e));
  }

  /** Drop previews of tabs that no longer exist (startup). */
  function prune(liveIds) {
    return run(async () => {
      const keys = await allPreviewKeys();
      const live = new Set(Array.from(liveIds || [], Number));
      const stale = keys.filter((k) => !live.has(tabIdOfKey(k)));
      const p = pruneIndex(await readIndex(), live);
      await removeKeys(stale);
      await area.set({ [INDEX_KEY]: p.index });
      return stale.length;
    }).catch((e) => {
      console.warn("[TabFlip] preview prune failed", e);
      return 0;
    });
  }

  /** Every "preview:" key in the area (falls back to the index if get(null) is unsupported). */
  async function allPreviewKeys() {
    const fromIndex = Object.keys(await readIndex()).map((k) => previewKey(k));
    let all = [];
    try {
      all = Object.keys((await area.get(null)) || {}).filter((k) => tabIdOfKey(k) !== null);
    } catch {
      all = [];
    }
    return Array.from(new Set([...all, ...fromIndex]));
  }

  /** Delete every stored preview. Rejects if storage refuses (data:clear reports it). */
  function clearAll() {
    cancelAll();
    return run(async () => {
      const keys = await allPreviewKeys();
      if (typeof area.remove === "function") await area.remove([...keys, INDEX_KEY]);
      else await area.set({ [INDEX_KEY]: {} });
      return keys.length;
    });
  }

  return { schedule, captureNow, cancelAll, getMany, get, remove, prune, clearAll };
}

/** Preview data URL of `tabId`, or null. Reads browser.storage.session directly. */
export async function getPreview(tabId) {
  try {
    const area = globalThis.browser?.storage?.session;
    if (!area || !isId(tabId)) return null;
    const got = (await area.get(previewKey(tabId))) || {};
    const v = got[previewKey(tabId)];
    return v && isPreviewDataUrl(v.dataUrl) ? v.dataUrl : null;
  } catch {
    return null;
  }
}
