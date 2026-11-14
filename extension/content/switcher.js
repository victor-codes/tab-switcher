// TabFlip content/switcher.js — single classic script, no imports. Owner: Agent 2.
//
// Runs at document_start in the top frame of every page. It does three things:
//   1. Passively tracks which modifier keys are held (never blocks a key unless
//      the overlay is shown).
//   2. Renders the switcher overlay on `switcher:show` (only when the page has
//      focus and the modifiers are still held), updates it on `switcher:move`,
//      removes it on `switcher:hide`, and reports `switcher:commit` /
//      `switcher:cancel` back to the background.
//   3. Sends `page:meta` once the page has loaded: this page's own icon, redrawn as a
//      small data:image URL (or null), so no overlay ever loads an icon from the network.
//
// Replies always use the returned-Promise style (both styles work in Safari;
// this file uses only one).

(() => {
  "use strict";

  if (typeof browser === "undefined" || !browser.runtime || !browser.runtime.onMessage) return;
  if (globalThis.__tabflipSwitcher) return; // guard against double injection
  globalThis.__tabflipSwitcher = true;

  // ---------------------------------------------------------------------------
  // Pure helpers (no DOM access). Exposed for the harness self-test below.
  // ---------------------------------------------------------------------------

  const MODIFIERS = ["Control", "Alt", "Shift", "Meta"];
  /** page:meta icons: drawn at this size, sent only if the data URL is at most ICON_MAX_CHARS. */
  const ICON_PX = 32;
  const ICON_MAX_CHARS = 8192;
  const ICON_WAIT_MS = 3000;
  const MODIFIER_ALIASES = {
    control: "Control",
    ctrl: "Control",
    macctrl: "Control",
    alt: "Alt",
    option: "Alt",
    shift: "Shift",
    meta: "Meta",
    command: "Meta",
    cmd: "Meta",
  };

  /** Normalise the `modifiers` array of `switcher:show`. Empty/unknown -> ["Control"]. */
  function normalizeModifiers(list) {
    const out = [];
    if (Array.isArray(list)) {
      for (const m of list) {
        const name = typeof m === "string" ? MODIFIER_ALIASES[m.toLowerCase()] : undefined;
        if (name && !out.includes(name)) out.push(name);
      }
    }
    return out.length ? out : ["Control"];
  }

  /** Wrap any integer into [0, n). */
  function wrapIndex(i, n) {
    if (!(n > 0)) return 0;
    i = Math.trunc(Number(i)) || 0;
    return ((i % n) + n) % n;
  }

  /** A preview may only be a data:image URL. */
  function safePreview(u) {
    return typeof u === "string" && /^data:image\//i.test(u) ? u : null;
  }

  /**
   * An icon shown in the overlay may only be a data:image URL: the overlay on one site
   * must never make a request to another site (F6). Anything else -> null (letter glyph).
   */
  function safeIcon(u) {
    return typeof u === "string" && /^data:image\//i.test(u) ? u : null;
  }

  /** A candidate icon link of this page: http(s) or data:image/. Normalised URL or null. */
  function iconSource(u) {
    if (typeof u !== "string" || !u) return null;
    if (/^data:image\//i.test(u)) return u;
    try {
      const url = new URL(u);
      return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
    } catch (e) {
      return null;
    }
  }

  /** Coerce one untrusted item into the shape the renderer uses. */
  function sanitizeItem(raw) {
    const it = raw && typeof raw === "object" ? raw : {};
    return {
      tabId: typeof it.tabId === "number" ? it.tabId : -1,
      title: typeof it.title === "string" ? it.title : "",
      host: typeof it.host === "string" ? it.host : "",
      icon: safeIcon(it.icon),
      preview: safePreview(it.preview),
    };
  }

  /** Parse a `sizes` attribute into the largest edge ("any" counts as huge). */
  function largestSize(sizes) {
    if (typeof sizes !== "string") return 0;
    let best = 0;
    for (const tok of sizes.trim().toLowerCase().split(/\s+/)) {
      if (tok === "any") return 1e6;
      const m = /^(\d+)x(\d+)$/.exec(tok);
      if (m) best = Math.max(best, Math.max(+m[1], +m[2]));
    }
    return best;
  }

  /**
   * Rank a `sizes` value for a 32 px icon: the smallest edge >= 32 wins, then vector
   * ("any"), then the largest edge below 32 (unknown sizes rank lowest).
   */
  function iconScore(sizes) {
    const s = largestSize(sizes);
    if (s >= 1e6) return 5000;
    if (s >= ICON_PX) return 10000 - Math.min(s, 4999);
    return s;
  }

  /**
   * Choose the best icon from candidate links: [{ rel, href, sizes }] where
   * href is already absolute (http(s) or data:image/). Prefer rel~=icon closest to
   * 32 px, then apple-touch-icon, else null. The result is only ever loaded by this
   * page's own content script and turned into a data URL (see iconToDataUrl).
   */
  function pickIcon(links) {
    let best = null;
    let bestScore = -1;
    for (const tier of ["icon", "apple-touch-icon"]) {
      for (const l of links) {
        const rels = String(l.rel || "").toLowerCase().split(/\s+/);
        if (!rels.includes(tier)) continue;
        const href = iconSource(l.href);
        if (!href) continue;
        const score = iconScore(l.sizes);
        if (score > bestScore) {
          best = href;
          bestScore = score;
        }
      }
      if (best) return best;
    }
    return null;
  }

  /**
   * Columns for n cards: at most 5, fewer when the viewport cannot fit 150 px cards
   * (16 px gutters + 10 px panel padding each side, 4 px gaps). Rows are then
   * balanced, so 8 tabs lay out 4 + 4 rather than 5 + 3.
   */
  function columnsFor(n, viewportWidth) {
    if (!(n > 0)) return 1;
    const fit = Math.max(1, Math.floor((viewportWidth - 52 + 4) / (150 + 4)));
    const max = Math.min(n, 5, fit);
    return Math.ceil(n / Math.ceil(n / max));
  }

  /** Card width for `cols` columns: 196 px, shrinking to fit narrow viewports. */
  function cardWidthFor(cols, viewportWidth) {
    const avail = viewportWidth - 52 - (cols - 1) * 4;
    return Math.max(100, Math.min(196, Math.floor(avail / Math.max(1, cols))));
  }

  const pure = { normalizeModifiers, wrapIndex, columnsFor, cardWidthFor, readShortcuts: (r) => readShortcuts(r), safePreview, safeIcon, iconSource, sanitizeItem, largestSize, iconScore, pickIcon };

  // ---------------------------------------------------------------------------
  // Passive modifier tracking
  // ---------------------------------------------------------------------------

  const held = new Set();
  /** Active gesture, or null. { items, index, modifiers } — independent of the DOM. */
  let session = null;
  /** Keys whose keydown we swallowed; their keyup is swallowed too. */
  const swallowed = new Set();

  function syncModifiers(e) {
    if (MODIFIERS.includes(e.key)) {
      if (e.type === "keydown") held.add(e.key);
      else held.delete(e.key);
    }
    if (typeof e.getModifierState === "function") {
      for (const m of MODIFIERS) {
        try {
          if (e.getModifierState(m)) held.add(m);
          else held.delete(m);
        } catch (err) {
          /* keep the tracked value */
        }
      }
    }
  }

  function swallow(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  // ---------------------------------------------------------------------------
  // Page shortcuts (⌃Tab / ⌃⇧Tab by default, or the user's own; see core/shortcuts.js,
  // which this mirrors: a content script cannot import). Normally the TabFlip app claims
  // them before Safari or the page sees them; when it isn’t running they are caught here,
  // on the page, and sent to the background as `switcher:key` (only while the page has
  // keyboard focus).
  // ---------------------------------------------------------------------------

  const DEFAULT_KEYS = {
    next: { ctrl: true, alt: false, shift: false, meta: false, code: "Tab" },
    prev: { ctrl: true, alt: false, shift: true, meta: false, code: "Tab" },
  };
  const SHORTCUT_FLAGS = ["ctrl", "alt", "shift", "meta"];
  let keys = DEFAULT_KEYS;

  function readShortcut(raw) {
    if (!raw || typeof raw !== "object" || typeof raw.code !== "string" || !raw.code) return null;
    if (raw.code === "Escape" || /^Arrow/.test(raw.code)) return null;
    const s = { code: raw.code };
    for (const f of SHORTCUT_FLAGS) s[f] = raw[f] === true;
    return s.ctrl || s.alt || s.meta ? s : null;
  }

  /** The stored pair, or the defaults if it is unusable (same rules as the background). */
  function readShortcuts(raw) {
    const r = raw && typeof raw === "object" ? raw : {};
    const next = readShortcut(r.next);
    const prev = readShortcut(r.prev);
    if (!next || !prev) return DEFAULT_KEYS;
    const same = next.code === prev.code && SHORTCUT_FLAGS.every((f) => next[f] === prev[f]);
    const shared = ["ctrl", "alt", "meta"].some((f) => next[f] && prev[f]);
    return same || !shared ? DEFAULT_KEYS : { next, prev };
  }

  function matches(s, e) {
    return e.code === s.code && e.ctrlKey === s.ctrl && e.altKey === s.alt && e.shiftKey === s.shift && e.metaKey === s.meta;
  }

  /** 1 for the next shortcut, -1 for previous, 0 for anything else. */
  function shortcutDir(e) {
    if (!e.ctrlKey && !e.altKey && !e.metaKey) return 0; // fast path for ordinary typing
    if (matches(keys.next, e)) return 1;
    if (matches(keys.prev, e)) return -1;
    return 0;
  }

  try {
    const area = browser.storage && browser.storage.local;
    if (area) {
      Promise.resolve(area.get("settings"))
        .then((got) => {
          keys = readShortcuts(got && got.settings && got.settings.shortcuts);
        })
        .catch(() => {});
      browser.storage.onChanged.addListener((changes, name) => {
        if (name === "local" && changes.settings) keys = readShortcuts(changes.settings.newValue && changes.settings.newValue.shortcuts);
      });
    }
  } catch (e) {
    /* no storage access: keep the defaults */
  }

  function onKeyDown(e) {
    syncModifiers(e);
    const dir = shortcutDir(e);
    if (dir) {
      // Ours: keep it from the page and from Safari, and let the background decide
      // (start a session, or move the one that is showing).
      swallow(e);
      swallowed.add(e.key);
      send({ type: "switcher:key", dir });
      return;
    }
    if (!session) return;
    switch (e.key) {
      case "Escape":
        swallow(e);
        swallowed.add(e.key);
        finish("cancel");
        return;
      case "ArrowLeft":
      case "ArrowUp":
        swallow(e);
        swallowed.add(e.key);
        select(session.index - 1);
        return;
      case "ArrowRight":
      case "ArrowDown":
        swallow(e);
        swallowed.add(e.key);
        select(session.index + 1);
        return;
      default:
        if (!allHeld(session.modifiers)) finish("commit"); // a keyup we never saw
    }
  }

  function onKeyUp(e) {
    syncModifiers(e);
    if (swallowed.delete(e.key)) swallow(e);
    if (session && !allHeld(session.modifiers)) finish("commit");
  }

  function allHeld(mods) {
    return mods.every((m) => held.has(m));
  }

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener(
    "blur",
    (e) => {
      if (e.target !== window) return; // element blurs do not bubble, but be strict
      held.clear(); // we cannot see keys while unfocused
      if (session) finish("commit");
    },
    true
  );
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.visibilityState === "hidden" && session) finish("commit");
    },
    true
  );
  window.addEventListener(
    "pagehide",
    () => {
      if (session) finish("commit");
    },
    true
  );

  // Safari unloads the extension's idle background after about 30 seconds, and a key
  // press the app sends then is dropped. While this page is the one on screen, a small
  // message every 20 seconds wakes the background (which reconnects to the app) and
  // keeps it awake. Top frame only, and only while visible, so it costs next to nothing.
  if (window.top === window) {
    const KEEPALIVE_MS = 20_000;
    let keepalive = null;
    const ping = () => send({ type: "keepalive" });
    const syncKeepalive = () => {
      if (document.visibilityState === "visible") {
        if (keepalive === null) {
          ping();
          keepalive = setInterval(ping, KEEPALIVE_MS);
        }
      } else if (keepalive !== null) {
        clearInterval(keepalive);
        keepalive = null;
      }
    };
    document.addEventListener("visibilitychange", syncKeepalive);
    syncKeepalive();
  }

  // ---------------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------------

  function send(msg) {
    try {
      const p = browser.runtime.sendMessage(msg);
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (e) {
      /* extension context gone (extension reloaded); nothing to do */
    }
  }

  /** Forget the session; modifiers we only assumed were held are no longer known to be. */
  function dropSession() {
    if (session && session.assumed) for (const m of session.modifiers) held.delete(m);
    session = null;
    removeOverlay();
  }

  function finish(kind) {
    if (!session) return;
    const item = session.items[session.index];
    dropSession();
    if (kind === "commit" && item && item.tabId >= 0) send({ type: "switcher:commit", tabId: item.tabId });
    else send({ type: "switcher:cancel" });
  }

  function onShow(msg) {
    const hasFocus = document.hasFocus();
    const modifiers = normalizeModifiers(msg.modifiers);
    // The TabFlip app saw the keys go down and reports their release itself. This page
    // may have missed the keydown (it was in a background tab, or has no focus yet), so
    // take the app's word and show the switcher regardless.
    const assumed = msg.assumeHeld === true;
    if (assumed) for (const m of modifiers) held.add(m);
    const modifiersHeld = allHeld(modifiers);
    // A new show always replaces whatever was there.
    dropSession();
    const items = Array.isArray(msg.items) ? msg.items.map(sanitizeItem) : [];
    if ((assumed || hasFocus) && modifiersHeld && items.length) {
      session = { items, index: wrapIndex(msg.selectedIndex, items.length), modifiers, assumed };
      try {
        render(); // same task as the reply: no timers, no animation
      } catch (e) {
        // Rendering failed (hostile page). Key tracking still commits on release.
        removeOverlay();
      }
    }
    return { ok: true, hasFocus, modifiersHeld, shown: !!session };
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg.type !== "string") return undefined;
    switch (msg.type) {
      case "switcher:show":
        return Promise.resolve(onShow(msg));
      case "switcher:move":
        if (session) select(msg.selectedIndex);
        return Promise.resolve({ ok: true });
      case "switcher:hide":
        dropSession();
        return Promise.resolve({ ok: true });
      default:
        return undefined; // not ours; let other listeners answer
    }
  });

  // ---------------------------------------------------------------------------
  // Overlay
  // ---------------------------------------------------------------------------

  const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; }
.wrap {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  padding: 16px;
  pointer-events: none;
  direction: ltr;
  font: 13px/1.3 -apple-system, BlinkMacSystemFont, system-ui, "Helvetica Neue", sans-serif;
  -webkit-font-smoothing: antialiased;
  --fg: #1d1d1f; --fg2: #6e6e73;
  --panel: rgba(244,244,247,0.72); --panel-solid: #f2f2f5;
  --edge: rgba(0,0,0,0.10); --rim: rgba(255,255,255,0.65);
  --plate: rgba(0,0,0,0.08);
  --thumb: #e4e4e8; --thumb-edge: rgba(0,0,0,0.08); --glyph-bg: #d2d2d8;
  --accent: #007aff;
  --shadow: 0 24px 64px rgba(0,0,0,0.22), 0 8px 20px rgba(0,0,0,0.10), 0 0 0 0.5px rgba(0,0,0,0.12);
  color: var(--fg);
}
@media (prefers-color-scheme: dark) {
  .wrap {
    --fg: #f5f5f7; --fg2: #98989f;
    --panel: rgba(36,36,40,0.70); --panel-solid: #242428;
    --edge: rgba(255,255,255,0.10); --rim: rgba(255,255,255,0.14);
    --plate: rgba(255,255,255,0.11);
    --thumb: #3a3a3f; --thumb-edge: rgba(255,255,255,0.10); --glyph-bg: #4a4a50;
    --accent: #0a84ff;
    --shadow: 0 24px 64px rgba(0,0,0,0.50), 0 8px 20px rgba(0,0,0,0.30), 0 0 0 0.5px rgba(0,0,0,0.60);
  }
}
/* Panel: one thick material layer floating over the page. Radius is concentric with
   the cards inside it (card radius 14 + panel padding 10 = 24). */
.panel {
  pointer-events: auto;
  max-width: 100%; max-height: 100%;
  display: flex;
  padding: 10px;
  border-radius: 24px;
  background: var(--panel);
  -webkit-backdrop-filter: blur(40px) saturate(180%);
  backdrop-filter: blur(40px) saturate(180%);
  box-shadow: inset 0 0.5px 0 var(--rim), var(--shadow);
  cursor: default;
  user-select: none; -webkit-user-select: none;
}
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .panel { background: var(--panel-solid); }
}
@media (prefers-reduced-transparency: reduce) {
  .panel { background: var(--panel-solid); -webkit-backdrop-filter: none; backdrop-filter: none; }
}
@media (prefers-contrast: more) {
  .wrap { --fg2: var(--fg); --edge: var(--fg); --thumb-edge: var(--fg2); }
  .card.sel { box-shadow: inset 0 0 0 1.5px var(--fg); }
  .panel {
    background: var(--panel-solid); -webkit-backdrop-filter: none; backdrop-filter: none;
    box-shadow: 0 0 0 1px var(--fg), var(--shadow);
  }
}
.list {
  /* Flex rows so a short last row (7 tabs -> 4 + 3) sits centered under the full one. */
  display: flex; flex-wrap: wrap; justify-content: center;
  width: calc(var(--cols, 1) * var(--cw, 196px) + (var(--cols, 1) - 1) * 4px);
  max-width: 100%;
  gap: 4px;
  margin: 0;
  overflow: auto;
  max-height: calc(100vh - 52px);
  overscroll-behavior: contain;
  scrollbar-width: thin;
}
/* The selection is a single soft plate behind the card. No hover state: the
   pointer moves the selection itself, so there is only ever one highlight. */
.card {
  flex: 0 0 var(--cw, 196px);
  min-width: 0;
  padding: 8px 8px 7px;
  border-radius: 14px;
}
.card.sel { background: var(--plate); }
.thumb {
  position: relative;
  aspect-ratio: 16 / 10;
  border-radius: 8px;
  overflow: hidden;
  background: var(--thumb);
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 0 0 0.5px var(--thumb-edge), 0 1px 3px rgba(0,0,0,0.08);
}
.thumb > .shot {
  position: absolute; inset: 0;
  width: 100%; height: 100%;
  object-fit: cover; object-position: top center;
  display: block;
}
.thumb > .big { width: 32px; height: 32px; display: block; border-radius: 7px; }
.glyph {
  display: flex; align-items: center; justify-content: center;
  border-radius: 50%;
  background: var(--glyph-bg); color: var(--fg);
  font-weight: 600;
  overflow: hidden;
}
.thumb > .glyph { width: 40px; height: 40px; font-size: 18px; letter-spacing: -0.01em; }
.row { display: flex; align-items: center; gap: 6px; margin: 9px 0 2px; min-width: 0; }
.row > .ico { width: 16px; height: 16px; flex: 0 0 16px; display: block; border-radius: 4px; }
.row > .glyph { width: 16px; height: 16px; flex: 0 0 16px; font-size: 9px; }
.title {
  flex: 1 1 auto; min-width: 0;
  font-weight: 500;
  letter-spacing: -0.006em;
  /* Long titles fade out at the trailing edge instead of ending in an ellipsis.
     The mask spans the whole title box, so a short title never reaches it. */
  white-space: nowrap; overflow: hidden; text-overflow: clip;
  -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 28px), transparent);
  mask-image: linear-gradient(to right, #000 calc(100% - 28px), transparent);
}
.title:dir(rtl) {
  -webkit-mask-image: linear-gradient(to left, #000 calc(100% - 28px), transparent);
  mask-image: linear-gradient(to left, #000 calc(100% - 28px), transparent);
}
`;

  let host = null; // the element in the page
  let cards = []; // card elements, by item index
  let listEl = null;
  let sheet = null; // constructed stylesheet, created once

  function setImportant(el, props) {
    for (const k in props) el.style.setProperty(k, props[k], "important");
  }

  function removeOverlay() {
    if (!host) return;
    const h = host;
    host = null;
    cards = [];
    listEl = null;
    try {
      if (typeof h.hidePopover === "function" && h.matches(":popover-open")) h.hidePopover();
    } catch (e) {
      /* ignore */
    }
    h.remove();
  }

  function el(tag, cls) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }

  function glyph(item, cls) {
    const g = el("span", "glyph " + cls);
    const src = item.host || item.title || "";
    g.textContent = src ? Array.from(src)[0].toUpperCase() : "";
    return g;
  }

  /** An <img> that swaps itself for `fallback()` if it fails to load. */
  function img(src, cls, fallback) {
    const i = el("img", cls);
    i.alt = "";
    i.draggable = false;
    i.referrerPolicy = "no-referrer";
    i.decoding = "sync";
    i.addEventListener(
      "error",
      () => {
        if (i.isConnected && fallback) i.replaceWith(fallback());
        else i.remove();
      },
      { once: true }
    );
    i.src = src;
    return i;
  }

  function untitled() {
    try {
      const m = browser.i18n && browser.i18n.getMessage && browser.i18n.getMessage("switcher_untitled");
      if (m) return m;
    } catch (e) {
      /* ignore */
    }
    return "Untitled";
  }

  function buildCard(item, index) {
    const card = el("div", "card");
    card.setAttribute("role", "option");
    card.dataset.index = String(index);

    const thumb = el("div", "thumb");
    if (item.preview) {
      thumb.appendChild(
        img(item.preview, "shot", () => (item.icon ? img(item.icon, "big", () => glyph(item, "")) : glyph(item, "")))
      );
    } else if (item.icon) {
      thumb.appendChild(img(item.icon, "big", () => glyph(item, "")));
    } else {
      thumb.appendChild(glyph(item, ""));
    }
    card.appendChild(thumb);

    const row = el("div", "row");
    row.appendChild(item.icon ? img(item.icon, "ico", () => glyph(item, "")) : glyph(item, ""));
    const title = el("span", "title");
    title.dir = "auto";
    title.textContent = item.title || item.host || untitled();
    card.title = title.textContent;
    row.appendChild(title);
    card.appendChild(row);
    return card;
  }

  function attachStyles(root) {
    // A constructed stylesheet is CSSOM, which page CSP (style-src) does not
    // govern; a <style> element is the fallback for engines without it.
    try {
      if (!sheet && typeof CSSStyleSheet === "function" && "replaceSync" in CSSStyleSheet.prototype) {
        sheet = new CSSStyleSheet();
        sheet.replaceSync(STYLE);
      }
      if (sheet && "adoptedStyleSheets" in root) {
        root.adoptedStyleSheets = [sheet];
        return;
      }
    } catch (e) {
      sheet = null;
    }
    const s = document.createElement("style");
    s.textContent = STYLE;
    root.appendChild(s);
  }

  function render() {
    const s = session;
    const h = document.createElement("tabflip-switcher");
    // Inline !important beats any page rule; set via CSSOM so a CSP that
    // forbids inline style attributes does not apply.
    setImportant(h, {
      all: "initial",
      display: "block",
      position: "fixed",
      top: "0",
      left: "0",
      right: "0",
      bottom: "0",
      width: "100%",
      height: "100%",
      "max-width": "none",
      "max-height": "none",
      margin: "0",
      padding: "0",
      border: "0",
      background: "transparent",
      overflow: "visible",
      transform: "none",
      opacity: "1",
      visibility: "visible",
      direction: "ltr",
      "z-index": "2147483647",
      "pointer-events": "none",
    });
    const root = h.attachShadow({ mode: "closed" });
    attachStyles(root);

    const wrap = el("div", "wrap");
    const panel = el("div", "panel");
    const list = el("div", "list");
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Recent tabs");
    const cols = columnsFor(s.items.length, window.innerWidth);
    list.style.setProperty("--cols", String(cols));
    list.style.setProperty("--cw", cardWidthFor(cols, window.innerWidth) + "px");
    cards = s.items.map((item, i) => {
      const c = buildCard(item, i);
      list.appendChild(c);
      return c;
    });
    panel.appendChild(list);
    wrap.appendChild(panel);
    root.appendChild(wrap);

    // Control-click on macOS is a context click: act on mousedown, never on click.
    panel.addEventListener("mousedown", onPanelMouseDown);
    panel.addEventListener("pointermove", onPanelPointerMove);
    pointerOrigin = null;
    panel.addEventListener("contextmenu", (e) => e.preventDefault());

    listEl = list;
    host = h;
    (document.documentElement || document).appendChild(h);
    // Top layer (popover) escapes page stacking contexts and `transform` on <html>.
    if (typeof h.showPopover === "function") {
      try {
        h.setAttribute("popover", "manual");
        h.showPopover();
      } catch (e) {
        h.removeAttribute("popover");
      }
    }
    paintSelection(-1, s.index);
  }

  function onPanelMouseDown(e) {
    e.preventDefault(); // keep focus where it is
    e.stopPropagation();
    if (!session) return;
    if (e.button !== 0 && !(e.button === 2 && e.ctrlKey)) return;
    const path = e.composedPath();
    for (const node of path) {
      if (node && node.classList && node.classList.contains("card")) {
        const i = Number(node.dataset.index);
        if (i >= 0 && i < session.items.length) {
          session.index = i;
          finish("commit");
        }
        return;
      }
    }
  }

  /**
   * The pointer moves the selection (one highlight, never a separate hover state).
   * The panel can appear under a resting cursor, and some engines fire a move then,
   * so the selection only follows once the pointer has really travelled a few px.
   */
  let pointerOrigin = null;
  function onPanelPointerMove(e) {
    if (!session || e.pointerType === "touch") return;
    if (!pointerOrigin) {
      pointerOrigin = { x: e.clientX, y: e.clientY, live: false };
      return;
    }
    if (!pointerOrigin.live) {
      if (Math.hypot(e.clientX - pointerOrigin.x, e.clientY - pointerOrigin.y) < 4) return;
      pointerOrigin.live = true;
    }
    for (const node of e.composedPath()) {
      if (node && node.classList && node.classList.contains("card")) {
        const i = Number(node.dataset.index);
        if (i >= 0 && i < session.items.length && i !== session.index) select(i);
        return;
      }
    }
  }

  function select(i) {
    if (!session) return;
    const prev = session.index;
    session.index = wrapIndex(i, session.items.length);
    paintSelection(prev, session.index);
  }

  function paintSelection(prev, next) {
    if (!host) return;
    if (prev !== next && cards[prev]) {
      cards[prev].classList.remove("sel");
      cards[prev].setAttribute("aria-selected", "false");
    }
    const c = cards[next];
    if (!c) return;
    c.classList.add("sel");
    c.setAttribute("aria-selected", "true");
    // Scroll inside the list only; never scroll the page.
    const list = listEl;
    if (list && list.scrollHeight > list.clientHeight) {
      const top = c.offsetTop - list.offsetTop;
      const bottom = top + c.offsetHeight;
      if (top < list.scrollTop) list.scrollTop = top - 4;
      else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight + 4;
    }
  }

  // ---------------------------------------------------------------------------
  // page:meta — once, after load (document_idle equivalent)
  // ---------------------------------------------------------------------------

  /**
   * Load this page's own icon and redraw it as a 32 px PNG data URL, so the overlay on
   * another site can show it without any request (F6). Resolves to null when the icon
   * cannot be loaded (page CSP img-src, 404), would taint the canvas (cross-origin
   * without CORS), or is too large.
   */
  function iconToDataUrl(href) {
    return new Promise((resolve) => {
      let done = false;
      let timer = 0;
      const finish = (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      };
      timer = setTimeout(() => finish(null), ICON_WAIT_MS);
      try {
        const im = new Image();
        if (!/^data:/i.test(href) && new URL(href).origin !== location.origin) {
          im.crossOrigin = "anonymous"; // without CORS the canvas would be tainted anyway
        }
        im.decoding = "async";
        im.onerror = () => finish(null);
        im.onload = () => {
          try {
            const w = im.naturalWidth || ICON_PX;
            const h = im.naturalHeight || ICON_PX;
            const scale = ICON_PX / Math.max(w, h);
            const dw = Math.max(1, Math.round(w * scale));
            const dh = Math.max(1, Math.round(h * scale));
            const c = document.createElement("canvas");
            c.width = ICON_PX;
            c.height = ICON_PX;
            const g = c.getContext("2d");
            if (!g) return finish(null);
            g.drawImage(im, (ICON_PX - dw) / 2, (ICON_PX - dh) / 2, dw, dh);
            const url = c.toDataURL("image/png"); // throws SecurityError if tainted
            finish(/^data:image\/png;base64,/.test(url) && url.length <= ICON_MAX_CHARS ? url : null);
          } catch (e) {
            finish(null);
          }
        };
        im.src = href;
      } catch (e) {
        finish(null);
      }
    });
  }

  /** This page's icon candidates; falls back to /favicon.ico, which Safari requests anyway. */
  function iconCandidates() {
    const links = Array.from(document.querySelectorAll('link[rel~="icon" i], link[rel~="apple-touch-icon" i]')).map(
      (l) => ({ rel: l.getAttribute("rel"), href: l.href, sizes: l.getAttribute("sizes") })
    );
    const best = pickIcon(links);
    if (best) return best;
    return location.protocol === "https:" || location.protocol === "http:" ? location.origin + "/favicon.ico" : null;
  }

  async function sendMeta() {
    try {
      if (browser.extension && browser.extension.inIncognitoContext) return; // private window
    } catch (e) {
      /* ignore */
    }
    let icon = null;
    try {
      const href = iconCandidates();
      icon = href ? await iconToDataUrl(href) : null;
    } catch (e) {
      icon = null;
    }
    send({ type: "page:meta", icon });
  }

  if (document.readyState === "complete") sendMeta();
  else window.addEventListener("load", sendMeta, { once: true });

  // Test hook: only the harness defines this, before loading the script.
  if (typeof globalThis.__tabflipTestHook === "function") {
    globalThis.__tabflipTestHook({
      pure,
      iconToDataUrl,
      state: () => ({
        active: !!session,
        index: session ? session.index : null,
        count: session ? session.items.length : 0,
        held: Array.from(held),
        shown: !!host,
        hostConnected: !!(host && host.isConnected),
      }),
    });
  }
})();
