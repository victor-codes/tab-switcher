// TabFlip content/switcher.js (single classic script, no imports). Owner: Agent 2.
//
// TEMPORARY SPIKE PROBES (Agent 0, Phase 0). Throw-away; revert the probe
// commit(s) to restore the stub. Privacy: only Control, and Q / W / Tab while
// Control is held, are ever looked at. No other key is recorded or sent.

(() => {
  "use strict";
  if (typeof browser === "undefined" || !browser.runtime || window.__tabflipSpike) return;
  window.__tabflipSpike = true;

  const LOADED_AT = Date.now();
  let ctrlHeld = false; // passively tracked from key events
  let lastCtrlDown = 0;
  let lastCtrlUp = 0;
  let preventCtrlTab = false;
  const recent = []; // last few whitelisted key events
  let watch = null; // active S4 watch after a flip command

  function send(type, data) {
    try {
      const p = browser.runtime.sendMessage({ type, data });
      if (p && p.catch) p.catch(() => {});
    } catch (e) {
      /* extension context gone */
    }
  }

  function interesting(e) {
    if (e.key === "Control") return true;
    if (!e.ctrlKey) return false;
    const k = (e.key || "").toLowerCase();
    return k === "q" || k === "w" || k === "tab";
  }

  function brief(e) {
    let mod = null;
    try {
      mod = e.getModifierState("Control");
    } catch (err) {
      mod = "error";
    }
    return {
      type: e.type,
      key: e.key,
      code: e.code,
      ctrlKey: e.ctrlKey,
      getModifierStateControl: mod,
      repeat: e.repeat,
      t: Date.now(),
    };
  }

  function onKey(e) {
    if (e.key === "Control") {
      ctrlHeld = e.type === "keydown";
      if (ctrlHeld) lastCtrlDown = Date.now();
      else lastCtrlUp = Date.now();
    }
    if (!interesting(e)) return;

    const b = brief(e);
    recent.push(b);
    while (recent.length > 8) recent.shift();

    if (watch) {
      watch.events.push({ ...b, msAfterCommandMessage: b.t - watch.messageAt });
      if (e.key === "Control" && e.type === "keyup") {
        watch.ctrlKeyupSeen = true;
        watch.ctrlKeyupMsAfterMessage = b.t - watch.messageAt;
        finishWatch("Control keyup");
      }
    }

    // S2: Control-Tab as seen by the page.
    if (e.type === "keydown" && e.ctrlKey && e.key === "Tab" && !e.repeat) {
      let prevented = false;
      if (preventCtrlTab) {
        e.preventDefault();
        e.stopImmediatePropagation();
        prevented = true;
      }
      send("spike:ctrlTab", {
        prevented,
        defaultPreventedAfter: e.defaultPrevented,
        cancelable: e.cancelable,
        shiftKey: e.shiftKey,
      });
    }
  }

  window.addEventListener("keydown", onKey, true);
  window.addEventListener("keyup", onKey, true);
  window.addEventListener(
    "blur",
    () => {
      if (watch) {
        watch.windowBlurMsAfterMessage = Date.now() - watch.messageAt;
      }
    },
    true
  );

  function finishWatch(reason) {
    if (!watch) return;
    const w = watch;
    watch = null;
    clearTimeout(w.timer);
    send("spike:afterFlip", {
      endedBy: reason,
      firedAt: w.firedAt,
      messageDelayMs: w.messageAt - w.firedAt,
      atMessageTime: w.atMessage,
      ctrlKeyupSeen: !!w.ctrlKeyupSeen,
      ctrlKeyupMsAfterMessage: w.ctrlKeyupMsAfterMessage == null ? null : w.ctrlKeyupMsAfterMessage,
      windowBlurMsAfterMessage: w.windowBlurMsAfterMessage == null ? null : w.windowBlurMsAfterMessage,
      eventsAfterMessage: w.events.slice(0, 12),
    });
  }

  function focusedEditable() {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
  }

  function stateNow() {
    const now = Date.now();
    return {
      ok: true,
      // The contract field: is the modifier still held, as far as the page knows?
      modifiersHeld: ctrlHeld,
      trackedCtrlHeld: ctrlHeld,
      msSinceCtrlKeydown: lastCtrlDown ? now - lastCtrlDown : null,
      msSinceCtrlKeyup: lastCtrlUp ? now - lastCtrlUp : null,
      sawAnyCtrlKeydown: lastCtrlDown > 0,
      recentKeyEvents: recent.map((r) => ({ ...r, msAgo: now - r.t })),
      focusedEditable: focusedEditable(),
      documentHasFocus: document.hasFocus(),
      visibilityState: document.visibilityState,
      readyState: document.readyState,
      scriptAgeMs: now - LOADED_AT,
      inIncognitoContext: !!(browser.extension && browser.extension.inIncognitoContext),
    };
  }

  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== "string") return undefined;
    switch (msg.type) {
      case "spike:ping":
        // Reply style A: returned Promise.
        return Promise.resolve({ ok: true, t: Date.now() });
      case "spike:pingCallback":
        // Reply style B: sendResponse callback.
        sendResponse({ ok: true, t: Date.now() });
        return true;
      case "spike:flipFired": {
        const state = stateNow();
        if (watch) finishWatch("superseded by next command");
        watch = {
          firedAt: msg.firedAt,
          messageAt: Date.now(),
          atMessage: {
            trackedCtrlHeld: state.trackedCtrlHeld,
            msSinceCtrlKeydown: state.msSinceCtrlKeydown,
            sawQKeydownBeforeMessage: state.recentKeyEvents.some(
              (r) => r.type === "keydown" && (r.key || "").toLowerCase() === "q" && r.msAgo < 1500
            ),
          },
          events: [],
          timer: setTimeout(() => finishWatch("3 s timeout (no Control keyup seen)"), 3000),
        };
        return Promise.resolve(state);
      }
      default:
        return undefined;
    }
  });

  // S2 toggle, set from the options page.
  function readCfg() {
    try {
      browser.storage.local.get("spike_cfg").then(
        (got) => {
          preventCtrlTab = !!(got.spike_cfg && got.spike_cfg.preventCtrlTab);
        },
        () => {}
      );
    } catch (e) {
      /* ignore */
    }
  }
  readCfg();
  try {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.spike_cfg) {
        preventCtrlTab = !!(changes.spike_cfg.newValue && changes.spike_cfg.newValue.preventCtrlTab);
      }
    });
  } catch (e) {
    /* ignore */
  }

  // S7 / S11: one report per page load.
  function pageMeta() {
    const links = document.querySelectorAll('link[rel~="icon"]');
    let scheme = null;
    if (links.length) {
      try {
        scheme = new URL(links[0].href, document.baseURI).protocol;
      } catch (e) {
        scheme = "(unparsable)";
      }
    }
    send("spike:pageMeta", {
      hasIconLink: links.length > 0,
      iconCount: links.length,
      iconScheme: scheme,
      incognito: !!(browser.extension && browser.extension.inIncognitoContext),
    });
  }
  if (document.readyState === "complete") pageMeta();
  else window.addEventListener("load", pageMeta, { once: true });
})();
