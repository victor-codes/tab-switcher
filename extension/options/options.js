// TabFlip options page. Owner: Agent 3.
// Reads and writes `settings` in browser.storage.local (schema in
// plans/00-overview.md), lists the active shortcuts read-only, and asks the
// background to clear stored data, and records the switch shortcuts. No network access.
// Loaded as a module so it shares the shortcut rules with the background.
import { DEFAULT_SHORTCUTS, normalizeShortcuts, normalizeShortcut, pairProblem, shortcutParts, shortcutSpoken, fromKeyEvent } from "../core/shortcuts.js";

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
    recNext: $("rec-next"),
    recPrev: $("rec-prev"),
    keysReset: $("keys-reset"),
    keysStatus: $("keys-status"),
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

  async function save(patch) {
    try {
      // Read-merge-write so keys written by other code are kept.
      const got = await api.storage.local.get("settings");
      const current = got && got.settings && typeof got.settings === "object" ? got.settings : {};
      const next = { ...current, ...normalise({ ...current, ...patch }) };
      await api.storage.local.set({ settings: next });
      // Like macOS settings, a change applies silently; only failures are reported.
      setStatus(els.saveStatus, "", null);
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
      if (area === "local" && changes.settings) {
        render(normalise(changes.settings.newValue));
        keys = normalizeShortcuts(changes.settings.newValue && changes.settings.newValue.shortcuts);
        if (!recording) renderKeys();
      }
    });
  }

  // ---------- shortcuts ----------

  const KEY_NAMES = {
    MacCtrl: "⌃", Ctrl: "⌃", Control: "⌃", Command: "⌘", Alt: "⌥", Option: "⌥", Shift: "⇧",
    Space: "Space", Comma: ",", Period: ".", Up: "↑", Down: "↓", Left: "←", Right: "→", Tab: "⇥",
  };

  // "MacCtrl+Q" -> ["⌃", "Q"]. A string without "+" (e.g. Safari already
  // returning "⌃Q") is split into its symbol prefix and the key.
  function commandParts(shortcut) {
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

  const SPOKEN = { "⌃": "Control", "⌘": "Command", "⌥": "Option", "⇧": "Shift", "⇥": "Tab" };
  /** Short row labels; Safari's long command descriptions read as sentences. */
  const COMMAND_LABELS = { flip: "Previous tab", "close-and-return": "Close tab and go back" };

  function renderShortcuts(commands) {
    const list = els.shortcuts;
    list.textContent = "";
    const shown = (commands || []).filter((c) => c && c.name && !c.name.startsWith("_"));
    if (shown.length === 0) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = "Safari didn’t report any shortcuts for TabFlip.";
      list.append(li);
      return;
    }
    for (const cmd of shown) {
      const li = document.createElement("li");
      const keys = document.createElement("span");
      keys.className = "keys";
      const desc = document.createElement("span");
      desc.className = "label";
      desc.textContent = COMMAND_LABELS[cmd.name] || cmd.description || cmd.name;
      if (cmd.shortcut) {
        const parts = commandParts(cmd.shortcut);
        keys.setAttribute("aria-label", parts.map((p) => SPOKEN[p] || p).join(" "));
        keys.textContent = parts.join("");
      } else {
        keys.className = "unset";
        keys.textContent = "None";
      }
      li.append(desc, keys);
      list.append(li);
    }
  }

  async function loadShortcuts() {
    try {
      if (!api.commands || typeof api.commands.getAll !== "function") {
        throw new Error("commands API unavailable");
      }
      const commands = await api.commands.getAll();
      safariKeys = (commands || []).filter((c) => c && c.shortcut).map((c) => commandParts(c.shortcut).join(""));
      renderShortcuts(commands);
    } catch (err) {
      els.shortcuts.textContent = "";
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = "Could not read the shortcuts: " + describe(err);
      els.shortcuts.append(li);
    }
  }

  // ---------- switch shortcuts ----------

  let keys = normalizeShortcuts(undefined);
  /** Shortcuts Safari owns (⌃Q, ⌃W): a page shortcut must not duplicate them. */
  let safariKeys = [];
  let recording = null; // "next" | "prev" | null

  function paintKeys(button, s) {
    button.textContent = shortcutParts(s).join("");
    button.setAttribute("aria-description", shortcutSpoken(s));
  }

  function renderKeys() {
    for (const [which, btn] of [["next", els.recNext], ["prev", els.recPrev]]) {
      btn.classList.toggle("recording", recording === which);
      if (recording === which) {
        btn.textContent = "Type shortcut";
        btn.removeAttribute("aria-description");
      } else {
        paintKeys(btn, keys[which]);
      }
    }
  }

  async function readKeys() {
    const got = await api.storage.local.get("settings");
    keys = normalizeShortcuts(got && got.settings && got.settings.shortcuts);
    renderKeys();
  }

  async function saveKeys(next) {
    try {
      const got = await api.storage.local.get("settings");
      const current = got && got.settings && typeof got.settings === "object" ? got.settings : {};
      await api.storage.local.set({ settings: { ...current, shortcuts: next } });
      keys = next;
      setStatus(els.keysStatus, "", null);
    } catch (err) {
      setStatus(els.keysStatus, "Could not save: " + describe(err), "error");
    }
    renderKeys();
  }

  function startRecording(which) {
    recording = recording === which ? null : which;
    setStatus(els.keysStatus, recording ? "Press Esc to keep the current shortcut." : "", null);
    renderKeys();
  }

  function stopRecording(message, kind) {
    recording = null;
    setStatus(els.keysStatus, message || "", kind || null);
    renderKeys();
  }

  els.recNext.addEventListener("click", () => startRecording("next"));
  els.recPrev.addEventListener("click", () => startRecording("prev"));
  els.recNext.addEventListener("blur", () => recording === "next" && stopRecording());
  els.recPrev.addEventListener("blur", () => recording === "prev" && stopRecording());
  els.keysReset.addEventListener("click", () => {
    recording = null;
    saveKeys({ next: { ...DEFAULT_SHORTCUTS.next }, prev: { ...DEFAULT_SHORTCUTS.prev } });
  });

  // Capture phase on window, so Tab and friends are recorded instead of moving focus.
  window.addEventListener(
    "keydown",
    (e) => {
      if (!recording) return;
      if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        stopRecording();
        return;
      }
      const raw = fromKeyEvent(e);
      if (!raw) return; // modifiers alone: wait for the key
      e.preventDefault();
      e.stopPropagation();
      const s = normalizeShortcut(raw);
      if (!s) {
        setStatus(els.keysStatus, "Use Control, Option or Command with a letter, number, Tab or punctuation key.", "error");
        return;
      }
      const label = shortcutParts(s).join("");
      if (safariKeys.includes(label)) {
        setStatus(els.keysStatus, label + " is already a Safari shortcut for TabFlip. Choose another.", "error");
        return;
      }
      const next = { ...keys, [recording]: s };
      const problem = pairProblem(next.next, next.prev);
      if (problem) {
        setStatus(els.keysStatus, problem, "error");
        return;
      }
      recording = null;
      saveKeys(next);
    },
    true
  );

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
    try {
      await readKeys();
    } catch (err) {
      renderKeys();
      setStatus(els.keysStatus, "Could not load shortcuts: " + describe(err), "error");
    }
  }

  init();
})();
