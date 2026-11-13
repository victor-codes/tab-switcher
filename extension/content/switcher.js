// TabFlip content/switcher.js — single classic script, no imports. Owner: Agent 2.
//
// Runs at document_start in the top frame of every page. It does three things:
//   1. Passively tracks which modifier keys are held (never blocks a key unless
//      the overlay is shown).
//   2. Renders the switcher overlay on `switcher:show` (only when the page has
//      focus and the modifiers are still held), updates it on `switcher:move`,
//      removes it on `switcher:hide`, and reports `switcher:commit` /
//      `switcher:cancel` back to the background.
//   3. Sends `page:meta` (best icon URL) once the page has loaded.
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

  /** An icon may be https:, http: or data:image/. Returns a normalised URL or null. */
  function safeIcon(u) {
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
   * Choose the best icon from candidate links: [{ rel, href, sizes }] where
   * href is already absolute. Prefer rel~=icon with the largest sizes, then
   * apple-touch-icon, else null.
   */
  function pickIcon(links) {
    let best = null;
    let bestScore = -1;
    for (const tier of ["icon", "apple-touch-icon"]) {
      for (const l of links) {
        const rels = String(l.rel || "").toLowerCase().split(/\s+/);
        if (!rels.includes(tier)) continue;
        const href = safeIcon(l.href);
        if (!href || /^data:/i.test(href)) continue; // only absolute http(s) per contract
        const score = largestSize(l.sizes);
        if (score > bestScore) {
          best = href;
          bestScore = score;
        }
      }
      if (best) return best;
    }
    return null;
  }

  const pure = { normalizeModifiers, wrapIndex, safePreview, safeIcon, sanitizeItem, largestSize, pickIcon };

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

  function onKeyDown(e) {
    syncModifiers(e);
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

  function finish(kind) {
    if (!session) return;
    const item = session.items[session.index];
    session = null;
    removeOverlay();
    if (kind === "commit" && item && item.tabId >= 0) send({ type: "switcher:commit", tabId: item.tabId });
    else send({ type: "switcher:cancel" });
  }

  function onShow(msg) {
    const hasFocus = document.hasFocus();
    const modifiers = normalizeModifiers(msg.modifiers);
    const modifiersHeld = allHeld(modifiers);
    // A new show always replaces whatever was there.
    session = null;
    removeOverlay();
    const items = Array.isArray(msg.items) ? msg.items.map(sanitizeItem) : [];
    if (hasFocus && modifiersHeld && items.length) {
      session = { items, index: wrapIndex(msg.selectedIndex, items.length), modifiers };
      try {
        render(); // same task as the reply: no timers, no animation
      } catch (e) {
        // Rendering failed (hostile page). Key tracking still commits on release.
        removeOverlay();
      }
    }
    return { ok: true, hasFocus, modifiersHeld };
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
        session = null;
        removeOverlay();
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
  --fg: #1d1d1f; --fg2: #6e6e73; --panel: rgba(246,246,248,0.80); --panel-solid: #f6f6f8;
  --edge: rgba(0,0,0,0.12); --card-hover: rgba(0,0,0,0.05); --card-sel: rgba(0,0,0,0.07);
  --thumb: #e4e4e8; --glyph-bg: #d2d2d8; --accent: #007aff;
  color: var(--fg);
}
@media (prefers-color-scheme: dark) {
  .wrap {
    --fg: #f5f5f7; --fg2: #a1a1a6; --panel: rgba(38,38,42,0.78); --panel-solid: #26262a;
    --edge: rgba(255,255,255,0.14); --card-hover: rgba(255,255,255,0.06); --card-sel: rgba(255,255,255,0.10);
    --thumb: #3a3a3f; --glyph-bg: #4a4a50; --accent: #0a84ff;
  }
}
.panel {
  pointer-events: auto;
  max-width: 100%; max-height: 100%;
  display: flex;
  padding: 10px;
  border-radius: 18px;
  background: var(--panel);
  -webkit-backdrop-filter: blur(30px) saturate(180%);
  backdrop-filter: blur(30px) saturate(180%);
  border: 0.5px solid var(--edge);
  box-shadow: 0 20px 60px rgba(0,0,0,0.30), 0 2px 8px rgba(0,0,0,0.12);
  cursor: default;
  user-select: none; -webkit-user-select: none;
}
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .panel { background: var(--panel-solid); }
}
.list {
  display: grid;
  grid-template-columns: repeat(var(--cols, 1), minmax(0, 200px));
  gap: 6px;
  padding: 4px;
  margin: 0;
  overflow: auto;
  max-height: calc(100vh - 56px);
  overscroll-behavior: contain;
}
.card {
  min-width: 0;
  padding: 8px;
  border-radius: 12px;
}
.card:hover { background: var(--card-hover); }
.card.sel { background: var(--card-sel); box-shadow: 0 0 0 2.5px var(--accent); }
.thumb {
  position: relative;
  aspect-ratio: 16 / 10;
  border-radius: 7px;
  overflow: hidden;
  background: var(--thumb);
  display: flex; align-items: center; justify-content: center;
  box-shadow: inset 0 0 0 0.5px var(--edge);
}
.thumb > .shot {
  position: absolute; inset: 0;
  width: 100%; height: 100%;
  object-fit: cover; object-position: top center;
  display: block;
}
.thumb > .big { width: 32px; height: 32px; display: block; }
.glyph {
  display: flex; align-items: center; justify-content: center;
  border-radius: 50%;
  background: var(--glyph-bg); color: var(--fg);
  font-weight: 600;
  overflow: hidden;
}
.thumb > .glyph { width: 40px; height: 40px; font-size: 18px; }
.row { display: flex; align-items: center; gap: 6px; margin-top: 7px; min-width: 0; }
.row > .ico { width: 16px; height: 16px; flex: 0 0 16px; display: block; border-radius: 3px; }
.row > .glyph { width: 16px; height: 16px; flex: 0 0 16px; font-size: 9px; }
.title {
  flex: 1 1 auto; min-width: 0;
  font-weight: 500;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.host {
  margin: 1px 0 0 22px;
  min-height: 1.3em;
  font-size: 11px; color: var(--fg2);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
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

    const hostLine = el("div", "host");
    hostLine.dir = "auto";
    hostLine.textContent = item.host;
    card.appendChild(hostLine);
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
    // Up to 5 per row; fewer when the viewport cannot fit 150 px cards
    // (16 px gutters + 14 px panel padding each side, 6 px gaps).
    const fit = Math.floor((window.innerWidth - 60 + 6) / (150 + 6));
    list.style.setProperty("--cols", String(Math.max(1, Math.min(s.items.length, 5, fit))));
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

  function sendMeta() {
    try {
      if (browser.extension && browser.extension.inIncognitoContext) return; // private window
    } catch (e) {
      /* ignore */
    }
    let icon = null;
    try {
      const links = Array.from(document.querySelectorAll('link[rel~="icon" i], link[rel~="apple-touch-icon" i]')).map(
        (l) => ({ rel: l.getAttribute("rel"), href: l.href, sizes: l.getAttribute("sizes") })
      );
      icon = pickIcon(links);
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
