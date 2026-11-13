// TabFlip background entry (wiring only). Owner: Agent 1.
//
// TEMPORARY SPIKE PROBES (Agent 0, Phase 0). This whole file is throw-away:
// it gathers evidence for questions S1-S11 in plans/01-agent0-scaffold-and-spike.md
// and stores it in storage.local under "spike". Revert the probe commit(s) to
// restore the stub. No network calls; hosts only (never full URLs); nothing is
// recorded about the content of private tabs.

import "./core/mru.js"; // S10: proves a static import resolves in the background.

const BOOT_AT = Date.now();
const BOOT_ID = BOOT_AT.toString(36) + "-" + Math.random().toString(36).slice(2, 8);
const MAX_EVENTS = 250;
const MAX_SNAPSHOTS = 14;
const MAX_LIST = 12;
const ACK_TIMEOUT_MS = 150;

let spike = null;
let lastEventAt = BOOT_AT;
let flushTimer = null;
let snapshotTimer = null;
let autoCaptures = 0;

function fresh() {
  return {
    v: 1,
    resetAt: Date.now(),
    boots: [],
    env: {},
    counts: {},
    events: [],
    snapshots: [],
    S1: { fires: [] },
    S2: { commandDeclared: null, commandFires: [], keydowns: [] },
    S4: { samples: [] },
    S5: { runs: [], replyStyles: null },
    S6: { caps: null, captures: [] },
    S7: { latest: null, pageIconLinks: [] },
    S9: {},
    S11: { contentReports: [] },
    optionsPage: {},
  };
}

function push(list, item, max = MAX_LIST) {
  list.push(item);
  while (list.length > max) list.shift();
}

function flushSoon() {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    try {
      await browser.storage.local.set({ spike });
    } catch (e) {
      console.warn("[TabFlip spike] flush failed", e);
    }
  }, 80);
}

function errText(e) {
  return e && e.message ? String(e.message) : String(e);
}

function hostOf(url) {
  if (!url) return "(no url)";
  try {
    const u = new URL(url);
    return u.host || u.protocol;
  } catch (e) {
    return "(unparsable)";
  }
}

function tabBrief(tab) {
  if (!tab) return null;
  return {
    id: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    active: tab.active,
    incognito: tab.incognito,
    host: tab.incognito ? "(private)" : hostOf(tab.url),
    urlPresent: typeof tab.url === "string" && tab.url.length > 0,
    status: tab.status,
  };
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timeout: true }), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function median(sorted) {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round(n) {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------- boot (S9, S10)

async function boot() {
  let stored = {};
  try {
    stored = await browser.storage.local.get(["spike", "spike_hb"]);
  } catch (e) {
    console.warn("[TabFlip spike] storage.local.get failed", e);
  }
  spike = stored.spike && stored.spike.v === 1 ? stored.spike : fresh();

  const bootRecord = {
    bootId: BOOT_ID,
    at: BOOT_AT,
    iso: new Date(BOOT_AT).toISOString(),
  };

  // Previous background instance: how long did it live, how long was it idle?
  const hb = stored.spike_hb;
  if (hb && hb.bootId !== BOOT_ID) {
    bootRecord.previous = {
      bootId: hb.bootId,
      livedMs: hb.lastAlive - hb.bootAt,
      idleBeforeStopMs: hb.lastAlive - hb.lastEventAt,
      deadForMs: BOOT_AT - hb.lastAlive,
      note: "heartbeat is written every 2 s, so values are accurate to about 2 s",
    };
  }

  // S9: storage.session availability and survival across background restarts.
  const s9 = { hasStorageSession: !!(browser.storage && browser.storage.session) };
  if (s9.hasStorageSession) {
    try {
      const got = await browser.storage.session.get("spikeSession");
      const prior = got.spikeSession;
      if (prior) {
        bootRecord.sessionSurvived = true;
        bootRecord.sessionFirstBootId = prior.firstBootId;
        bootRecord.sessionAgeMs = BOOT_AT - prior.firstBootAt;
        bootRecord.sessionBootCounter = prior.counter + 1;
        await browser.storage.session.set({
          spikeSession: { ...prior, counter: prior.counter + 1, lastBootId: BOOT_ID },
        });
      } else {
        bootRecord.sessionSurvived = false;
        await browser.storage.session.set({
          spikeSession: { firstBootId: BOOT_ID, firstBootAt: BOOT_AT, counter: 1, lastBootId: BOOT_ID },
        });
      }
      const back = await browser.storage.session.get("spikeSession");
      s9.roundTripOk = !!back.spikeSession && back.spikeSession.lastBootId === BOOT_ID;
    } catch (e) {
      s9.error = errText(e);
    }
  }
  spike.S9 = { ...spike.S9, ...s9 };
  push(spike.boots, bootRecord, 30);

  // S10 / S6: what kind of global scope is this and which APIs exist.
  const g = globalThis;
  spike.env = {
    backgroundLoaded: true,
    staticImportWorked: true,
    globalScope: g.constructor && g.constructor.name,
    hasWindow: typeof g.window !== "undefined",
    hasDocument: typeof g.document !== "undefined",
    hasImportScripts: typeof g.importScripts === "function",
    hasServiceWorkerGlobalScope: typeof g.ServiceWorkerGlobalScope !== "undefined",
    hasOffscreenCanvas: typeof g.OffscreenCanvas !== "undefined",
    hasCreateImageBitmap: typeof g.createImageBitmap === "function",
    hasChromeNamespace: typeof g.chrome !== "undefined",
    userAgent: g.navigator ? g.navigator.userAgent : null,
    manifestBackground: browser.runtime.getManifest().background,
    apis: {
      "tabs.captureVisibleTab": typeof browser.tabs.captureVisibleTab,
      "tabs.onReplaced": typeof browser.tabs.onReplaced,
      "tabs.onAttached": typeof browser.tabs.onAttached,
      "tabs.onDetached": typeof browser.tabs.onDetached,
      "windows.onFocusChanged": typeof (browser.windows && browser.windows.onFocusChanged),
      "commands.getAll": typeof (browser.commands && browser.commands.getAll),
      "commands.update": typeof (browser.commands && browser.commands.update),
      "commands.onChanged": typeof (browser.commands && browser.commands.onChanged),
      "extension.isAllowedIncognitoAccess": typeof (browser.extension && browser.extension.isAllowedIncognitoAccess),
      "runtime.openOptionsPage": typeof browser.runtime.openOptionsPage,
      "storage.session": typeof browser.storage.session,
    },
  };

  try {
    const cmds = await browser.commands.getAll();
    spike.env.commands = cmds.map((c) => ({ name: c.name, shortcut: c.shortcut, description: c.description }));
    const probe = cmds.find((c) => c.name === "probe-ctrl-tab");
    spike.S2.commandDeclared = probe ? { present: true, shortcut: probe.shortcut || "" } : { present: false };
  } catch (e) {
    spike.env.commandsError = errText(e);
  }

  try {
    if (browser.extension && browser.extension.isAllowedIncognitoAccess) {
      spike.S11.isAllowedIncognitoAccess = await browser.extension.isAllowedIncognitoAccess();
    }
  } catch (e) {
    spike.S11.isAllowedIncognitoAccessError = errText(e);
  }

  flushSoon();
  scheduleSnapshot("boot");
  probeFavicons("boot");

  // Heartbeat for S9 (see caveat in the options page: the write itself may
  // influence how long Safari keeps the background alive).
  const beat = () =>
    browser.storage.local
      .set({ spike_hb: { bootId: BOOT_ID, bootAt: BOOT_AT, lastAlive: Date.now(), lastEventAt } })
      .catch(() => {});
  beat();
  setInterval(beat, 2000);
}

const ready = boot().catch((e) => {
  console.error("[TabFlip spike] boot failed", e);
  if (!spike) spike = fresh();
  spike.env = { ...(spike.env || {}), bootError: errText(e) };
  flushSoon();
});

// ---------------------------------------------------------------- events (S8, S11)

function logEvent(name, data) {
  lastEventAt = Date.now();
  ready.then(() => {
    spike.counts[name] = (spike.counts[name] || 0) + 1;
    push(spike.events, { t: lastEventAt, sinceBootMs: lastEventAt - BOOT_AT, ev: name, ...data }, MAX_EVENTS);
    console.log("[TabFlip spike]", name, data);
    flushSoon();
  });
}

function scheduleSnapshot(reason) {
  clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => takeSnapshot(reason), 400);
}

async function takeSnapshot(reason) {
  await ready;
  try {
    const wins = await browser.windows.getAll({ populate: true });
    const snap = {
      t: Date.now(),
      reason,
      windows: wins.map((w) => ({
        id: w.id,
        focused: w.focused,
        incognito: w.incognito,
        type: w.type,
        tabs: (w.tabs || []).map((t) => ({
          id: t.id,
          index: t.index,
          active: t.active,
          incognito: t.incognito,
          host: t.incognito ? "(private)" : hostOf(t.url),
        })),
      })),
    };
    const prev = spike.snapshots[spike.snapshots.length - 1];
    if (prev) {
      const ids = (s) => new Set(s.windows.flatMap((w) => w.tabs.map((t) => t.id)));
      const wids = (s) => new Set(s.windows.map((w) => w.id));
      const a = ids(prev), b = ids(snap), wa = wids(prev), wb = wids(snap);
      snap.diffFromPrevious = {
        tabIdsAdded: [...b].filter((x) => !a.has(x)),
        tabIdsGone: [...a].filter((x) => !b.has(x)),
        windowIdsAdded: [...wb].filter((x) => !wa.has(x)),
        windowIdsGone: [...wa].filter((x) => !wb.has(x)),
      };
    }
    push(spike.snapshots, snap, MAX_SNAPSHOTS);
    const anyPrivate = snap.windows.some((w) => w.incognito || w.tabs.some((t) => t.incognito));
    if (anyPrivate) spike.S11.privateWindowSeenInSnapshot = { t: snap.t, windows: snap.windows.filter((w) => w.incognito).map((w) => w.id) };
    flushSoon();
  } catch (e) {
    logEvent("snapshot.error", { error: errText(e) });
  }
}

browser.tabs.onActivated.addListener((info) => {
  logEvent("tabs.onActivated", { tabId: info.tabId, windowId: info.windowId, previousTabId: info.previousTabId });
  scheduleSnapshot("tabs.onActivated");
  autoCapture(info);
  probeFavicons("onActivated");
});
browser.tabs.onCreated.addListener((tab) => {
  logEvent("tabs.onCreated", { tabId: tab.id, windowId: tab.windowId, index: tab.index, active: tab.active, incognito: tab.incognito });
  scheduleSnapshot("tabs.onCreated");
});
browser.tabs.onRemoved.addListener((tabId, info) => {
  logEvent("tabs.onRemoved", { tabId, windowId: info && info.windowId, isWindowClosing: info && info.isWindowClosing });
  scheduleSnapshot("tabs.onRemoved");
});
browser.tabs.onUpdated.addListener((tabId, change, tab) => {
  // Noisy: only count it, and log status transitions.
  if (change && change.status) {
    logEvent("tabs.onUpdated(status)", { tabId, windowId: tab && tab.windowId, status: change.status });
    if (change.status === "complete") probeFavicons("onUpdated");
  } else {
    ready.then(() => {
      spike.counts["tabs.onUpdated(other)"] = (spike.counts["tabs.onUpdated(other)"] || 0) + 1;
      flushSoon();
    });
  }
});
if (browser.tabs.onAttached) {
  browser.tabs.onAttached.addListener((tabId, info) => {
    logEvent("tabs.onAttached", { tabId, newWindowId: info && info.newWindowId, newPosition: info && info.newPosition });
    scheduleSnapshot("tabs.onAttached");
  });
}
if (browser.tabs.onDetached) {
  browser.tabs.onDetached.addListener((tabId, info) => {
    logEvent("tabs.onDetached", { tabId, oldWindowId: info && info.oldWindowId, oldPosition: info && info.oldPosition });
    scheduleSnapshot("tabs.onDetached");
  });
}
if (browser.tabs.onReplaced) {
  browser.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
    logEvent("tabs.onReplaced", { addedTabId, removedTabId });
    scheduleSnapshot("tabs.onReplaced");
  });
}
if (browser.tabs.onMoved) {
  browser.tabs.onMoved.addListener((tabId, info) => {
    logEvent("tabs.onMoved", { tabId, windowId: info && info.windowId, fromIndex: info && info.fromIndex, toIndex: info && info.toIndex });
  });
}
if (browser.windows) {
  if (browser.windows.onFocusChanged) {
    browser.windows.onFocusChanged.addListener((windowId) => {
      logEvent("windows.onFocusChanged", { windowId });
      scheduleSnapshot("windows.onFocusChanged");
    });
  }
  if (browser.windows.onCreated) {
    browser.windows.onCreated.addListener((win) => {
      logEvent("windows.onCreated", { windowId: win.id, incognito: win.incognito, type: win.type });
      scheduleSnapshot("windows.onCreated");
    });
  }
  if (browser.windows.onRemoved) {
    browser.windows.onRemoved.addListener((windowId) => {
      logEvent("windows.onRemoved", { windowId });
      scheduleSnapshot("windows.onRemoved");
    });
  }
}
browser.runtime.onInstalled.addListener((details) => {
  logEvent("runtime.onInstalled", { reason: details && details.reason });
  openOptions("onInstalled");
});
if (browser.runtime.onStartup) {
  browser.runtime.onStartup.addListener(() => logEvent("runtime.onStartup", {}));
}

async function openOptions(why) {
  await ready;
  try {
    await browser.runtime.openOptionsPage();
    spike.optionsPage[why] = { ok: true, t: Date.now() };
  } catch (e) {
    spike.optionsPage[why] = { ok: false, error: errText(e), t: Date.now() };
  }
  flushSoon();
}

// ---------------------------------------------------------------- commands (S1, S2, S4, S5, S6)

browser.commands.onCommand.addListener((name, tabArg) => {
  const firedAt = Date.now();
  logEvent("commands.onCommand", { name, tabArgPresent: !!tabArg, tabArgId: tabArg && tabArg.id });
  if (name === "flip") onFlip(firedAt, tabArg);
  else if (name === "probe-ctrl-tab") onCtrlTabCommand(firedAt);
  else if (name === "close-and-return") {
    // Spike only: nothing is closed. Used as a second "does it fire" data
    // point and as a guaranteed way to reach the results page.
    openOptions("closeAndReturnCommand");
  }
});

async function activeTab() {
  const out = {};
  try {
    const a = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    out.lastFocusedWindow = a[0] || null;
  } catch (e) {
    out.lastFocusedWindowError = errText(e);
  }
  try {
    const b = await browser.tabs.query({ active: true, currentWindow: true });
    out.currentWindow = b[0] || null;
  } catch (e) {
    out.currentWindowError = errText(e);
  }
  return out;
}

async function onFlip(firedAt, tabArg) {
  await ready;
  const q = await activeTab();
  const tab = q.lastFocusedWindow || q.currentWindow || tabArg || null;
  const fire = {
    t: firedAt,
    tab: tabBrief(tab),
    tabArg: tabArg ? tabBrief(tabArg) : null,
    queryAgreement: {
      lastFocusedWindowTabId: q.lastFocusedWindow ? q.lastFocusedWindow.id : null,
      currentWindowTabId: q.currentWindow ? q.currentWindow.id : null,
      errors: [q.lastFocusedWindowError, q.currentWindowError].filter(Boolean),
    },
  };

  if (tab && tab.id != null) {
    // S4 + first-message latency: this is the real "switcher:show" moment.
    const t0 = performance.now();
    let late = null;
    const p = browser.tabs
      .sendMessage(tab.id, { type: "spike:flipFired", firedAt })
      .then((r) => {
        late = round(performance.now() - t0);
        return r;
      })
      .catch((e) => ({ __error: errText(e) }));
    const res = await withTimeout(p, ACK_TIMEOUT_MS);
    if (res && res.__timeout) {
      fire.ack = { withinTimeout: false, timeoutMs: ACK_TIMEOUT_MS };
      // Keep waiting (up to 2 s) to learn whether it would have arrived late.
      const lateRes = await withTimeout(p, 2000);
      fire.ack.lateResult = lateRes && lateRes.__timeout ? "never (2 s)" : lateRes && lateRes.__error ? "error: " + lateRes.__error : "arrived after " + late + " ms";
      if (lateRes && !lateRes.__timeout && !lateRes.__error) fire.content = lateRes;
    } else if (res && res.__error) {
      fire.ack = { withinTimeout: false, error: res.__error, afterMs: round(performance.now() - t0) };
    } else if (res) {
      fire.ack = { withinTimeout: true, firstMessageMs: late };
      fire.content = res;
    } else {
      fire.ack = { withinTimeout: false, error: "empty response", afterMs: round(performance.now() - t0) };
    }
  } else {
    fire.ack = { withinTimeout: false, error: "no active tab found" };
  }

  fire.contentScriptReachable = !!fire.content;
  fire.textFieldFocused = fire.content ? fire.content.focusedEditable : null;
  push(spike.S1.fires, fire, 20);
  flushSoon();

  if (fire.content && tab) {
    await latencyRun(tab, "after flip command (active tab)");
  }
  if (tab) {
    await capture(tab, "after flip command (user gesture)");
  }
}

async function onCtrlTabCommand(firedAt) {
  await ready;
  const q = await activeTab();
  push(spike.S2.commandFires, { t: firedAt, tab: tabBrief(q.lastFocusedWindow || q.currentWindow) }, 10);
  flushSoon();
}

// ---------------------------------------------------------------- S5 latency

async function latencyRun(tab, label) {
  const samples = [];
  const errors = [];
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    try {
      const r = await withTimeout(browser.tabs.sendMessage(tab.id, { type: "spike:ping", i }), 2000);
      if (r && r.__timeout) errors.push("timeout");
      else if (r && r.ok) samples.push(round(performance.now() - t0));
      else errors.push("bad response");
    } catch (e) {
      errors.push(errText(e));
    }
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const run = {
    t: Date.now(),
    label,
    tab: tabBrief(tab),
    n: samples.length,
    medianMs: median(sorted),
    minMs: sorted.length ? sorted[0] : null,
    maxMs: sorted.length ? sorted[sorted.length - 1] : null,
    over150ms: samples.filter((s) => s > 150).length,
    samplesMs: samples,
    errors: errors.slice(0, 3),
    errorCount: errors.length,
  };
  push(spike.S5.runs, run, 8);

  // Which reply style works in the content script: returned Promise vs sendResponse.
  if (!spike.S5.replyStyles) {
    const styles = {};
    for (const type of ["spike:ping", "spike:pingCallback"]) {
      try {
        const r = await withTimeout(browser.tabs.sendMessage(tab.id, { type }), 1000);
        styles[type === "spike:ping" ? "returnedPromise" : "sendResponseCallback"] = r && r.__timeout ? "timeout" : r && r.ok ? "ok" : "bad response: " + JSON.stringify(r);
      } catch (e) {
        styles[type] = "error: " + errText(e);
      }
    }
    spike.S5.replyStyles = styles;
  }
  flushSoon();
  return run;
}

// ---------------------------------------------------------------- S6 capture

function autoCapture(info) {
  // No user gesture towards the extension here: a plain tab activation.
  if (autoCaptures >= 6) return;
  autoCaptures++;
  setTimeout(async () => {
    await ready;
    try {
      const tab = await browser.tabs.get(info.tabId);
      await capture(tab, "after tabs.onActivated (no user gesture)");
    } catch (e) {
      push(spike.S6.captures, { t: Date.now(), trigger: "after tabs.onActivated (no user gesture)", ok: false, error: "tabs.get: " + errText(e) }, 16);
      flushSoon();
    }
  }, 350);
}

function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(",");
  const head = dataUrl.slice(0, comma);
  const mime = (head.match(/^data:([^;]+)/) || [])[1] || "application/octet-stream";
  const bin = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function capture(tab, trigger) {
  const rec = { t: Date.now(), trigger, tab: tabBrief(tab) };
  if (tab.incognito) {
    rec.skipped = "private tab: not captured (F6)";
    push(spike.S6.captures, rec, 16);
    flushSoon();
    return;
  }
  try {
    const t0 = performance.now();
    const dataUrl = await withTimeout(browser.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 50 }), 5000);
    rec.captureMs = round(performance.now() - t0);
    if (dataUrl && dataUrl.__timeout) throw new Error("captureVisibleTab did not settle within 5 s");
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) throw new Error("unexpected result type: " + typeof dataUrl);
    rec.ok = true;
    rec.dataUrlChars = dataUrl.length;
    rec.approxBytes = Math.round((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75);
    rec.mime = dataUrl.slice(5, dataUrl.indexOf(";"));

    // Downscale path for previews: createImageBitmap + OffscreenCanvas (2D).
    const ds = {};
    try {
      const t1 = performance.now();
      const blob = dataUrlToBlob(dataUrl);
      if (typeof createImageBitmap !== "function") throw new Error("createImageBitmap is not defined");
      const bmp = await createImageBitmap(blob);
      ds.sourceWidth = bmp.width;
      ds.sourceHeight = bmp.height;
      ds.decodeMs = round(performance.now() - t1);
      if (typeof OffscreenCanvas === "undefined") throw new Error("OffscreenCanvas is not defined");
      const w = 320;
      const h = Math.max(1, Math.round((bmp.height / bmp.width) * w));
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("OffscreenCanvas.getContext('2d') returned null");
      const t2 = performance.now();
      ctx.drawImage(bmp, 0, 0, w, h);
      const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.6 });
      ds.ok = true;
      ds.outWidth = w;
      ds.outHeight = h;
      ds.outBytes = out.size;
      ds.outType = out.type;
      ds.drawAndEncodeMs = round(performance.now() - t2);
      if (bmp.close) bmp.close();
    } catch (e) {
      ds.ok = false;
      ds.error = errText(e);
    }
    rec.downscale = ds;
  } catch (e) {
    rec.ok = false;
    rec.error = errText(e);
  }
  push(spike.S6.captures, rec, 16);
  flushSoon();
}

// ---------------------------------------------------------------- S7 favicons

let favTimer = null;
function probeFavicons(reason) {
  clearTimeout(favTimer);
  favTimer = setTimeout(async () => {
    await ready;
    try {
      const tabs = await browser.tabs.query({});
      const rows = tabs.map((t) => {
        const f = t.favIconUrl;
        return {
          tabId: t.id,
          host: t.incognito ? "(private)" : hostOf(t.url),
          hasKey: "favIconUrl" in t,
          populated: typeof f === "string" && f.length > 0,
          scheme: typeof f === "string" && f.length ? f.slice(0, f.indexOf(":") + 1) : null,
          length: typeof f === "string" ? f.length : null,
        };
      });
      spike.S7.latest = {
        t: Date.now(),
        reason,
        tabCount: rows.length,
        populatedCount: rows.filter((r) => r.populated).length,
        tabs: rows.slice(0, 30),
      };
      flushSoon();
    } catch (e) {
      spike.S7.latest = { t: Date.now(), reason, error: errText(e) };
      flushSoon();
    }
  }, 600);
}

// ---------------------------------------------------------------- messages

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("spike:")) return undefined;
  lastEventAt = Date.now();
  return handleMessage(msg, sender).catch((e) => ({ ok: false, error: errText(e) }));
});

async function handleMessage(msg, sender) {
  await ready;
  const tab = sender && sender.tab;
  switch (msg.type) {
    case "spike:bgPing":
      return { ok: true, bootId: BOOT_ID, bootAt: BOOT_AT, uptimeMs: Date.now() - BOOT_AT };

    case "spike:reset": {
      const keep = spike;
      spike = fresh();
      spike.env = keep.env;
      spike.boots = keep.boots.slice(-1);
      spike.S9 = keep.S9;
      spike.S2.commandDeclared = keep.S2.commandDeclared;
      spike.S11.isAllowedIncognitoAccess = keep.S11.isAllowedIncognitoAccess;
      autoCaptures = 0;
      await browser.storage.local.set({ spike });
      return { ok: true };
    }

    case "spike:mark":
      logEvent("MARK", { label: String(msg.label || "").slice(0, 80) });
      await takeSnapshot("MARK: " + String(msg.label || "").slice(0, 80));
      return { ok: true };

    case "spike:runLatency": {
      // Options-page button: test every other tab in the current window that answers.
      const tabs = await browser.tabs.query({ lastFocusedWindow: true });
      let ran = 0;
      for (const t of tabs) {
        if (tab && t.id === tab.id) continue;
        if (ran >= 2) break;
        const probe = await withTimeout(browser.tabs.sendMessage(t.id, { type: "spike:ping" }).catch(() => null), 1000);
        if (probe && probe.ok) {
          await latencyRun(t, "options button (background tab: may be throttled)");
          ran++;
        }
      }
      return { ok: true, ran };
    }

    case "spike:afterFlip": {
      // S4: key events the page saw around/after the command.
      push(spike.S4.samples, { t: Date.now(), tab: tabBrief(tab), ...msg.data }, 12);
      flushSoon();
      return { ok: true };
    }

    case "spike:ctrlTab": {
      // S2: the page saw a Control-Tab keydown. Did Safari switch tabs anyway?
      const rec = { t: Date.now(), tab: tabBrief(tab), ...msg.data };
      push(spike.S2.keydowns, rec, 16);
      flushSoon();
      if (tab) {
        setTimeout(async () => {
          try {
            const now = await browser.tabs.query({ active: true, windowId: tab.windowId });
            rec.activeTabAfter500ms = now[0] ? now[0].id : null;
            rec.safariSwitchedTab = !!now[0] && now[0].id !== tab.id;
          } catch (e) {
            rec.afterCheckError = errText(e);
          }
          flushSoon();
        }, 500);
      }
      return { ok: true };
    }

    case "spike:pageMeta": {
      const d = msg.data || {};
      if (!d.incognito) {
        push(spike.S7.pageIconLinks, { t: Date.now(), host: tab ? hostOf(tab.url) : null, hasIconLink: d.hasIconLink, iconScheme: d.iconScheme, iconCount: d.iconCount }, 12);
      }
      push(
        spike.S11.contentReports,
        { t: Date.now(), tabId: tab && tab.id, tabIncognito: tab && tab.incognito, inIncognitoContext: d.incognito },
        12
      );
      if (d.incognito || (tab && tab.incognito)) {
        spike.S11.contentScriptRanInPrivateTab = { t: Date.now(), tabId: tab && tab.id, tabIncognito: tab && tab.incognito, inIncognitoContext: d.incognito };
      }
      flushSoon();
      return { ok: true };
    }

    default:
      return { ok: false, error: "unknown spike message" };
  }
}
