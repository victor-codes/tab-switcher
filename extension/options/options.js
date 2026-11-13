// TabFlip options page. Owner: Agent 3.
// Reads and writes `settings` in browser.storage.local (schema in
// plans/00-overview.md), lists the active shortcuts read-only, and asks the
// background to clear stored data. No network access.
"use strict";

(() => {
  const DEFAULTS = Object.freeze({ overlay: true, previews: true, maxItems: 8 });
  const MIN_ITEMS = 4;
  const MAX_ITEMS = 12;

  const $ = (id) => document.getElementById(id);
  const api = globalThis.browser;

  const els = {
    overlay: $("overlay"),
    previews: $("previews"),
    maxItems: $("maxItems"),
    maxItemsOut: $("maxItems-out"),
    saveStatus: $("save-status"),
    shortcuts: $("shortcuts"),
    clear: $("clear"),
    clearStart: $("clear-start"),
    clearConfirm: $("clear-confirm"),
    clearYes: $("clear-yes"),
    clearNo: $("clear-no"),
    clearStatus: $("clear-status"),
  };

  // ---------- settings ----------

  function clampItems(value) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return DEFAULTS.maxItems;
    return Math.min(MAX_ITEMS, Math.max(MIN_ITEMS, n));
  }

  function normalise(raw) {
    const s = raw && typeof raw === "object" ? raw : {};
    return {
      overlay: typeof s.overlay === "boolean" ? s.overlay : DEFAULTS.overlay,
      previews: typeof s.previews === "boolean" ? s.previews : DEFAULTS.previews,
      maxItems: s.maxItems === undefined ? DEFAULTS.maxItems : clampItems(s.maxItems),
    };
  }

  function render(settings) {
    els.overlay.checked = settings.overlay;
    els.previews.checked = settings.previews;
    els.maxItems.value = String(settings.maxItems);
    els.maxItemsOut.value = String(settings.maxItems);
    els.maxItemsOut.textContent = String(settings.maxItems);
  }

  function setStatus(el, text, kind) {
    el.textContent = text;
    el.classList.toggle("ok", kind === "ok");
    el.classList.toggle("error", kind === "error");
  }

  async function readSettings() {
    const got = await api.storage.local.get("settings");
    return normalise(got && got.settings);
  }

  let statusTimer = null;
  async function save(patch) {
    try {
      // Read-merge-write so keys written by other code are kept.
      const got = await api.storage.local.get("settings");
      const current = got && got.settings && typeof got.settings === "object" ? got.settings : {};
      const next = { ...current, ...normalise({ ...current, ...patch }) };
      await api.storage.local.set({ settings: next });
      setStatus(els.saveStatus, "Saved.", "ok");
      clearTimeout(statusTimer);
      statusTimer = setTimeout(() => setStatus(els.saveStatus, "", null), 1500);
    } catch (err) {
      setStatus(els.saveStatus, "Could not save: " + describe(err), "error");
    }
  }

  function describe(err) {
    return (err && err.message) || String(err);
  }

  els.overlay.addEventListener("change", () => save({ overlay: els.overlay.checked }));
  els.previews.addEventListener("change", () => save({ previews: els.previews.checked }));
  els.maxItems.addEventListener("input", () => {
    els.maxItemsOut.value = els.maxItems.value;
    els.maxItemsOut.textContent = els.maxItems.value;
  });
  els.maxItems.addEventListener("change", () => save({ maxItems: clampItems(els.maxItems.value) }));

  // Reflect changes made elsewhere (another options tab, the background).
  if (api && api.storage && api.storage.onChanged) {
    api.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.settings) render(normalise(changes.settings.newValue));
    });
  }

  // ---------- shortcuts ----------

  const KEY_NAMES = {
    MacCtrl: "⌃", Ctrl: "⌃", Control: "⌃", Command: "⌘", Alt: "⌥", Option: "⌥", Shift: "⇧",
    Space: "Space", Comma: ",", Period: ".", Up: "↑", Down: "↓", Left: "←", Right: "→",
  };

  // "MacCtrl+Q" -> ["⌃", "Q"]. A string without "+" (e.g. Safari already
  // returning "⌃Q") is split into its symbol prefix and the key.
  function shortcutParts(shortcut) {
    if (shortcut.includes("+")) {
      return shortcut.split("+").filter(Boolean).map((p) => KEY_NAMES[p] || p);
    }
    const parts = [];
    let rest = shortcut;
    while (rest && "⌃⌘⌥⇧".includes(rest[0])) {
      parts.push(rest[0]);
      rest = rest.slice(1);
    }
    if (rest) parts.push(rest);
    return parts;
  }

  const SPOKEN = { "⌃": "Control", "⌘": "Command", "⌥": "Option", "⇧": "Shift" };

  function renderShortcuts(commands) {
    const list = els.shortcuts;
    list.textContent = "";
    const shown = (commands || []).filter((c) => c && c.name && !c.name.startsWith("_"));
    if (shown.length === 0) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = "Safari did not report any shortcuts for TabFlip.";
      list.append(li);
      return;
    }
    for (const cmd of shown) {
      const li = document.createElement("li");
      const keys = document.createElement("span");
      keys.className = "keys";
      const desc = document.createElement("span");
      desc.textContent = cmd.description || cmd.name;
      if (cmd.shortcut) {
        const parts = shortcutParts(cmd.shortcut);
        keys.setAttribute("aria-label", parts.map((p) => SPOKEN[p] || p).join(" "));
        for (const p of parts) {
          const k = document.createElement("kbd");
          k.textContent = p;
          k.setAttribute("aria-hidden", "true");
          keys.append(k);
        }
      } else {
        keys.className = "keys unset";
        keys.textContent = "Not set";
      }
      li.append(keys, desc);
      list.append(li);
    }
  }

  async function loadShortcuts() {
    try {
      if (!api.commands || typeof api.commands.getAll !== "function") {
        throw new Error("commands API unavailable");
      }
      renderShortcuts(await api.commands.getAll());
    } catch (err) {
      els.shortcuts.textContent = "";
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = "Could not read the shortcuts: " + describe(err);
      els.shortcuts.append(li);
    }
  }

  // ---------- clear data ----------

  function showConfirm(show) {
    els.clearStart.hidden = show;
    els.clearConfirm.hidden = !show;
    (show ? els.clearNo : els.clear).focus();
  }

  els.clear.addEventListener("click", () => {
    setStatus(els.clearStatus, "", null);
    showConfirm(true);
  });
  els.clearNo.addEventListener("click", () => showConfirm(false));
  els.clearConfirm.addEventListener("keydown", (e) => {
    if (e.key === "Escape") showConfirm(false);
  });

  els.clearYes.addEventListener("click", async () => {
    els.clearYes.disabled = true;
    els.clearNo.disabled = true;
    setStatus(els.clearStatus, "Clearing…", null);
    try {
      const reply = await api.runtime.sendMessage({ type: "data:clear" });
      if (reply && reply.ok === false) {
        setStatus(els.clearStatus, "TabFlip could not clear its data" + (reply.error ? ": " + reply.error : "."), "error");
      } else if (reply && reply.ok === true) {
        setStatus(els.clearStatus, "Cleared stored previews, icons and history.", "ok");
      } else {
        // No handler answered (e.g. an older background). Say so plainly.
        setStatus(els.clearStatus, "TabFlip did not confirm that the data was cleared.", "error");
      }
    } catch (err) {
      setStatus(els.clearStatus, "Could not reach TabFlip: " + describe(err), "error");
    } finally {
      els.clearYes.disabled = false;
      els.clearNo.disabled = false;
      showConfirm(false);
    }
  });

  // ---------- start ----------

  async function init() {
    if (!api || !api.storage) {
      setStatus(els.saveStatus, "This page only works inside Safari as TabFlip's settings.", "error");
      return;
    }
    render(DEFAULTS);
    try {
      render(await readSettings());
    } catch (err) {
      setStatus(els.saveStatus, "Could not load settings: " + describe(err), "error");
    }
    loadShortcuts();
  }

  init();
})();
