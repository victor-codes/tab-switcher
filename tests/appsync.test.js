import { test } from "node:test";
import assert from "node:assert/strict";
import { planSync } from "../extension/core/appsync.js";
import { DEFAULT_SETTINGS, normalizeSettings } from "../extension/core/store.js";

const appSettings = {
  overlay: false,
  previews: true,
  maxItems: 6,
  shortcuts: {
    next: { ctrl: false, alt: true, shift: false, meta: false, code: "Tab" },
    prev: { ctrl: false, alt: true, shift: true, meta: false, code: "Tab" },
  },
};

test("planSync: no reply, junk reply or no app settings changes nothing", () => {
  for (const reply of [undefined, null, "x", {}, { settings: null, clearToken: null }]) {
    assert.deepEqual(planSync(reply, {}), { settings: null, clearToken: null });
  }
});

test("planSync: writes the app's settings, normalized, when they differ or nothing is stored", () => {
  assert.deepEqual(planSync({ settings: appSettings }, {}).settings, normalizeSettings(appSettings));
  assert.deepEqual(planSync({ settings: appSettings }, { settings: DEFAULT_SETTINGS }).settings, normalizeSettings(appSettings));
  assert.equal(planSync({ settings: appSettings }, { settings: normalizeSettings(appSettings) }).settings, null);
});

test("planSync: invalid app values fall back to defaults instead of breaking the extension", () => {
  const plan = planSync({ settings: { overlay: "yes", maxItems: 999, shortcuts: { next: { code: "Tab" } } } }, {});
  assert.deepEqual(plan.settings, normalizeSettings(undefined));
});

test("planSync: a new clear token asks for a clear; the same token does not", () => {
  assert.equal(planSync({ clearToken: "a" }, {}).clearToken, "a");
  assert.equal(planSync({ clearToken: "b" }, { clearToken: "a" }).clearToken, "b");
  assert.equal(planSync({ clearToken: "a" }, { clearToken: "a" }).clearToken, null);
  assert.equal(planSync({ clearToken: "" }, {}).clearToken, null);
});
