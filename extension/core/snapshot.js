// Tab Switcher core/snapshot.js — what the extension tells the app about a window.
//
// The background pushes one snapshot per Safari window to the app (through the native
// handler) whenever something the switcher shows changes; the app draws its panel from the
// latest one. Everything here is pure: no browser calls, no clock of its own.

export const SNAPSHOT_VERSION = 1;
/** At most one push per window in this many ms (a held push goes out at the end of it). */
export const THROTTLE_MS = 250;
/** Icons are small data:image URLs; anything longer is dropped. */
export const MAX_ICON_CHARS = 8192;

function hostOf(url) {
  if (typeof url !== "string" || !url) return "";
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function validIcon(icon) {
  return (
    typeof icon === "string" &&
    icon.length <= MAX_ICON_CHARS &&
    /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/]+=*$/i.test(icon)
  );
}

/**
 * The snapshot of one window, or null when it has no items.
 *   order      tab ids, most recently used first
 *   tabsById   Map or plain object: tabId -> { title, url }
 *   icons      { [tabId]: data URL },  previews  { [tabId]: data URL }
 *   settings   { maxItems }
 * Tabs missing from `tabsById` are skipped (they are gone). A private window never carries
 * icons or previews.
 */
export function buildSnapshot({ instance, seq, windowId, focused, private: isPrivate, order, tabsById, icons, previews, settings }) {
  const get = (id) => (tabsById instanceof Map ? tabsById.get(id) : tabsById?.[id]);
  const max = Number.isInteger(settings?.maxItems) && settings.maxItems >= 1 ? settings.maxItems : 8;
  const priv = isPrivate === true;
  const items = [];
  for (const tabId of Array.isArray(order) ? order : []) {
    if (items.length >= max) break;
    const t = get(tabId);
    if (!t) continue;
    const icon = icons?.[tabId];
    const preview = previews?.[tabId];
    items.push({
      tabId,
      title: typeof t.title === "string" ? t.title : "",
      host: hostOf(t.url),
      icon: !priv && validIcon(icon) ? icon : null,
      preview: !priv && typeof preview === "string" && preview ? preview : null,
    });
  }
  if (!items.length) return null;
  return { v: SNAPSHOT_VERSION, instance, seq, windowId, focused: focused === true, private: priv, items };
}

/** Compare two snapshots ignoring `seq`. */
export function sameContent(a, b) {
  if (!a || !b) return false;
  return JSON.stringify({ ...a, seq: 0 }) === JSON.stringify({ ...b, seq: 0 });
}

/**
 * Should `next` be pushed now? `previous` is the last snapshot pushed for that window,
 * `lastPushAt` when (ms) it went out. Never an empty snapshot, never an identical repeat,
 * never within THROTTLE_MS of the last push.
 */
export function shouldPush(previous, next, now, lastPushAt) {
  if (!next || !Array.isArray(next.items) || next.items.length === 0) return false;
  if (sameContent(previous, next)) return false;
  if (typeof lastPushAt === "number" && now - lastPushAt < THROTTLE_MS) return false;
  return true;
}

/** ms to wait before a held push may go out (0 when it may go now). */
export function holdFor(now, lastPushAt) {
  if (typeof lastPushAt !== "number") return 0;
  return Math.max(0, THROTTLE_MS - (now - lastPushAt));
}
