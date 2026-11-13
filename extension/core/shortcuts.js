// TabFlip core/shortcuts.js — the user-chosen switch shortcuts.
//
// Safari's `commands` cannot be rebound by an extension and silently drops Control-Tab
// (SPIKE-RESULTS S2/S3). So the TabFlip app claims these shortcuts while
// Safari is in front; the content script also matches them on the page, as a fallback
// for when the helper isn't running.
//
// A shortcut: { ctrl, alt, shift, meta: boolean, code: KeyboardEvent.code }.
// Matching uses `code` (the physical key) so Option combinations, which change `key`,
// still match. Stored in settings.shortcuts = { next, prev }.

/** Keys a shortcut may end on. Escape (cancel) and the arrows (move) are reserved. */
const CODE_RE =
  /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9])|Tab|Space|Enter|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash)$/;

export const DEFAULT_SHORTCUTS = Object.freeze({
  next: Object.freeze({ ctrl: true, alt: false, shift: false, meta: false, code: "Tab" }),
  prev: Object.freeze({ ctrl: true, alt: false, shift: true, meta: false, code: "Tab" }),
});

const MOD_NAMES = [
  ["ctrl", "Control", "⌃"],
  ["alt", "Alt", "⌥"],
  ["shift", "Shift", "⇧"],
  ["meta", "Meta", "⌘"],
];

const CODE_LABELS = {
  Tab: "⇥", Space: "Space", Enter: "↩", Backquote: "`", Minus: "-", Equal: "=",
  BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";", Quote: "'",
  Comma: ",", Period: ".", Slash: "/",
};

/** One shortcut, or null when it is not usable (no ⌃/⌥/⌘, or a reserved key). */
export function normalizeShortcut(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.code !== "string" || !CODE_RE.test(raw.code)) return null;
  const s = { ctrl: raw.ctrl === true, alt: raw.alt === true, shift: raw.shift === true, meta: raw.meta === true, code: raw.code };
  return s.ctrl || s.alt || s.meta ? s : null;
}

/**
 * Modifiers that must stay held while browsing: those both shortcuts share (so ⌃Tab and
 * ⌃⇧Tab hold Control; Shift may come and go). Names as in KeyboardEvent.key.
 */
export function holdModifiers(next, prev) {
  return MOD_NAMES.filter(([k]) => next[k] && prev[k]).map(([, name]) => name);
}

function same(a, b) {
  return a.code === b.code && MOD_NAMES.every(([k]) => a[k] === b[k]);
}

/**
 * Why a pair cannot be used, or "" when it can. Each needs ⌃, ⌥ or ⌘; they must differ;
 * and they must share a modifier other than Shift, which is what the user holds to browse.
 */
export function pairProblem(next, prev) {
  if (!next || !prev) return "Each shortcut needs Control, Option or Command, plus a key.";
  if (same(next, prev)) return "Next and previous can’t be the same shortcut.";
  if (!holdModifiers(next, prev).some((m) => m !== "Shift")) {
    return "Both shortcuts need to share Control, Option or Command, so you can hold it while browsing.";
  }
  return "";
}

/** The stored pair, or the defaults when anything about it is unusable. */
export function normalizeShortcuts(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const next = normalizeShortcut(r.next);
  const prev = normalizeShortcut(r.prev);
  if (pairProblem(next, prev)) return { next: { ...DEFAULT_SHORTCUTS.next }, prev: { ...DEFAULT_SHORTCUTS.prev } };
  return { next, prev };
}

/** Display parts in macOS order, e.g. ["⌃", "⇧", "Tab"]. */
export function shortcutParts(s) {
  const parts = MOD_NAMES.filter(([k]) => s[k]).map(([, , sym]) => sym);
  const code = s.code;
  let key = CODE_LABELS[code];
  if (!key) key = /^Key[A-Z]$/.test(code) ? code.slice(3) : /^Digit\d$/.test(code) ? code.slice(5) : code;
  parts.push(key);
  return parts;
}

const SPOKEN_KEYS = { Tab: "Tab", Enter: "Return", Space: "Space" };

/** Spoken form for screen readers, e.g. "Control Shift Tab". */
export function shortcutSpoken(s) {
  const parts = MOD_NAMES.filter(([k]) => s[k]).map(([, name]) => (name === "Alt" ? "Option" : name === "Meta" ? "Command" : name));
  parts.push(SPOKEN_KEYS[s.code] || shortcutParts(s).at(-1));
  return parts.join(" ");
}

/** A shortcut from a keydown, or null if the event is only modifiers. */
export function fromKeyEvent(e) {
  if (!e || typeof e.code !== "string" || /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/.test(e.code)) return null;
  return { ctrl: !!e.ctrlKey, alt: !!e.altKey, shift: !!e.shiftKey, meta: !!e.metaKey, code: e.code };
}
