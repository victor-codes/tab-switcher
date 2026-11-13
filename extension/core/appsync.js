// TabFlip core/appsync.js — settings come from the TabFlip app.
//
// The app is the only place to configure TabFlip. It saves its settings in a shared App
// Group; the extension's native handler (SafariWebExtensionHandler.swift) reads them and
// answers `browser.runtime.sendNativeMessage(..., { type: "settings:get" })` with
//   { settings: { overlay, previews, maxItems, shortcuts } | null, clearToken: string | null }.
// The background copies them into storage.local ("settings"), which everything else
// already reads and watches. A new clearToken means the user pressed "Clear…" in the app.

import { normalizeSettings } from "./store.js";

export const CLEAR_TOKEN_KEY = "clearToken";

/**
 * What to do with the app's reply, given what is stored now.
 * Returns { settings: object | null (write it), clearToken: string | null (clear, then store it) }.
 */
export function planSync(reply, stored = {}) {
  const plan = { settings: null, clearToken: null };
  if (!reply || typeof reply !== "object") return plan;
  if (reply.settings && typeof reply.settings === "object") {
    const next = normalizeSettings(reply.settings);
    const current = normalizeSettings(stored.settings);
    if (stored.settings === undefined || JSON.stringify(next) !== JSON.stringify(current)) plan.settings = next;
  }
  if (typeof reply.clearToken === "string" && reply.clearToken && reply.clearToken !== stored.clearToken) {
    plan.clearToken = reply.clearToken;
  }
  return plan;
}
