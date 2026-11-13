import { test } from "node:test";
import assert from "node:assert/strict";
import * as mru from "../extension/core/mru.js";
import { step, isStale, IDLE_MS, FALLBACK_STALE_MS, ACK_TIMEOUT_MS, OVERLAY_STALE_MS } from "../extension/core/session.js";

const W = 1;
const ON = { overlay: true, previews: true, maxItems: 8 };
const OFF = { overlay: false, previews: true, maxItems: 8 };

/**
 * A tiny simulator: holds MRU + session, applies promote effects, records browser effects,
 * and (like Safari) reports an onActivated for every activate effect when `echo` is on.
 */
function sim(order, { settings = ON, echo = true } = {}) {
  const s = {
    mru: { windows: { [W]: order.slice() } },
    session: null,
    active: order[0],
    now: 1000,
    log: [],
    settings,
    echo,
    dispatch(event, extra = {}) {
      const ctx = { now: s.now, settings: s.settings, order: mru.list(s.mru, W), ...extra };
      const r = step(s.session, event, ctx);
      s.session = r.session;
      const io = [];
      for (const e of r.effects) {
        if (e.type === "promote") s.mru = mru.activated(s.mru, e.windowId, e.tabId);
        else io.push(e);
      }
      s.log.push(...io);
      for (const e of io) {
        if (e.type === "activate") {
          s.active = e.tabId;
          if (s.echo) s.dispatch({ type: "activated", windowId: W, tabId: e.tabId });
        }
      }
      return io;
    },
    flip() {
      return s.dispatch({ type: "flip", windowId: W, tabId: s.active });
    },
    lastShow() {
      return s.log.filter((e) => e.type === "show").at(-1);
    },
    list() {
      return mru.list(s.mru, W);
    },
    take() {
      const out = s.log;
      s.log = [];
      return out;
    },
  };
  return s;
}

const types = (effects) => effects.map((e) => e.type);

test("single flip there and back (quick taps with overlay content script)", () => {
  const s = sim([1, 2, 3]);
  s.flip();
  const show = s.lastShow();
  assert.deepEqual(show.order, [1, 2, 3]);
  assert.equal(show.selectedIndex, 1);
  assert.equal(show.tabId, 1);
  assert.equal(show.ackTimeoutMs, ACK_TIMEOUT_MS);
  assert.equal(s.session.mode, "pending");
  s.dispatch({ type: "ack", token: show.token, reply: { ok: true, modifiersHeld: false } });
  assert.equal(s.session, null);
  assert.equal(s.active, 2);
  assert.deepEqual(s.list(), [2, 1, 3]);

  s.now += 3000;
  s.take();
  s.flip();
  s.dispatch({ type: "ack", token: s.lastShow().token, reply: { ok: true, modifiersHeld: false } });
  assert.equal(s.active, 1);
  assert.deepEqual(s.list(), [1, 2, 3]);
});

test("overlay: triple tap then release selects the 4th MRU entry", () => {
  const s = sim([1, 2, 3, 4, 5]);
  s.flip();
  s.dispatch({ type: "ack", token: s.lastShow().token, reply: { ok: true, modifiersHeld: true } });
  assert.equal(s.session.mode, "overlay");
  s.take();
  s.now += 200;
  s.flip();
  s.now += 200;
  s.flip();
  const moves = s.take();
  assert.deepEqual(moves, [
    { type: "move", tabId: 1, selectedIndex: 2 },
    { type: "move", tabId: 1, selectedIndex: 3 },
  ]);
  assert.deepEqual(s.list(), [1, 2, 3, 4, 5], "no reorder while browsing");
  s.dispatch({ type: "commit", senderTabId: 1, tabId: 4 });
  assert.equal(s.session, null);
  assert.equal(s.active, 4);
  assert.deepEqual(s.list(), [4, 1, 2, 3, 5]);
  const fx = s.take();
  assert.deepEqual(types(fx), ["hide", "activate"]);
});

test("overlay: commit by row click picks that row; unknown tabId falls back to selection", () => {
  const s = sim([1, 2, 3, 4]);
  s.flip();
  s.dispatch({ type: "ack", token: s.lastShow().token, reply: { ok: true, modifiersHeld: true } });
  s.dispatch({ type: "commit", senderTabId: 1, tabId: 3 });
  assert.equal(s.active, 3);

  const t = sim([1, 2, 3, 4]);
  t.flip();
  t.dispatch({ type: "ack", token: t.lastShow().token, reply: { ok: true, modifiersHeld: true } });
  t.dispatch({ type: "commit", senderTabId: 1, tabId: 999 });
  assert.equal(t.active, 2);
});

test("overlay: commit to the origin (wrapped back to index 0) does not activate", () => {
  const s = sim([1, 2]);
  s.flip();
  s.dispatch({ type: "ack", token: s.lastShow().token, reply: { ok: true, modifiersHeld: true } });
  s.flip(); // wraps to 0
  assert.equal(s.session.index, 0);
  s.take();
  s.dispatch({ type: "commit", senderTabId: 1, tabId: 1 });
  assert.deepEqual(types(s.take()), ["hide"]);
  assert.equal(s.active, 1);
  assert.deepEqual(s.list(), [1, 2]);
});

test("commit/cancel from a tab other than the origin are ignored", () => {
  const s = sim([1, 2, 3]);
  s.flip();
  s.dispatch({ type: "ack", token: s.lastShow().token, reply: { ok: true, modifiersHeld: true } });
  s.take();
  s.dispatch({ type: "commit", senderTabId: 2, tabId: 2 });
  s.dispatch({ type: "cancel", senderTabId: 3 });
  assert.equal(s.session.mode, "overlay");
  assert.deepEqual(s.take(), []);
});

test("Esc cancels: overlay hidden, stays on origin, MRU unchanged", () => {
  const s = sim([1, 2, 3]);
  s.flip();
  s.dispatch({ type: "ack", token: s.lastShow().token, reply: { ok: true, modifiersHeld: true } });
  s.flip();
  s.take();
  s.dispatch({ type: "cancel", senderTabId: 1 });
  assert.equal(s.session, null);
  assert.deepEqual(s.take(), [{ type: "hide", tabId: 1 }]);
  assert.equal(s.active, 1);
  assert.deepEqual(s.list(), [1, 2, 3]);
});

test("undefined ack (no content script) goes to fallback at once", () => {
  const s = sim([1, 2, 3]);
  s.flip();
  s.take();
  s.dispatch({ type: "ack", token: s.session.id, reply: undefined });
  assert.equal(s.session.mode, "fallback");
  const fx = s.take();
  assert.deepEqual(types(fx), ["activate", "startIdleTimer"]);
  assert.equal(fx[1].ms, IDLE_MS);
  assert.equal(s.active, 2);
  assert.deepEqual(s.list(), [1, 2, 3], "not promoted yet");
});

test("ack hasFocus rule: false -> fallback; true or missing -> overlay / quick commit", () => {
  const nf = sim([1, 2, 3]);
  nf.flip();
  nf.take();
  nf.dispatch({ type: "ack", token: nf.session.id, reply: { ok: true, hasFocus: false, modifiersHeld: true } });
  assert.equal(nf.session.mode, "fallback");
  assert.deepEqual(types(nf.take()), ["hide", "activate", "startIdleTimer"]);
  assert.equal(nf.active, 2);
  assert.deepEqual(nf.list(), [1, 2, 3], "fallback does not promote yet");

  const nf2 = sim([1, 2, 3]);
  nf2.flip();
  nf2.dispatch({ type: "ack", token: nf2.session.id, reply: { ok: true, hasFocus: false, modifiersHeld: false } });
  assert.equal(nf2.session.mode, "fallback");

  const held = sim([1, 2, 3]);
  held.flip();
  held.dispatch({ type: "ack", token: held.session.id, reply: { ok: true, hasFocus: true, modifiersHeld: true } });
  assert.equal(held.session.mode, "overlay");

  const quick = sim([1, 2, 3]);
  quick.flip();
  quick.dispatch({ type: "ack", token: quick.session.id, reply: { ok: true, hasFocus: true, modifiersHeld: false } });
  assert.equal(quick.session, null);
  assert.equal(quick.active, 2);
  assert.deepEqual(quick.list(), [2, 1, 3]);

  const missing = sim([1, 2, 3]);
  missing.flip();
  missing.dispatch({ type: "ack", token: missing.session.id, reply: { ok: true, modifiersHeld: true } });
  assert.equal(missing.session.mode, "overlay", "missing hasFocus is treated as true");
});

test("malformed ack replies are treated as no content script", () => {
  for (const reply of [null, {}, { ok: false }, { ok: true }, "yes", { ok: true, modifiersHeld: "true" }]) {
    const s = sim([1, 2]);
    s.flip();
    s.dispatch({ type: "ack", token: s.session.id, reply });
    assert.equal(s.session.mode, "fallback", JSON.stringify(reply));
  }
});

test("ack timeout goes to fallback and hides a late overlay", () => {
  const s = sim([1, 2, 3]);
  s.flip();
  s.take();
  s.dispatch({ type: "ackTimeout", token: s.session.id });
  assert.equal(s.session.mode, "fallback");
  assert.deepEqual(types(s.take()), ["hide", "activate", "startIdleTimer"]);
  assert.equal(s.active, 2);
});

test("stale ack tokens are ignored", () => {
  const s = sim([1, 2, 3]);
  s.flip();
  const token = s.session.id;
  s.dispatch({ type: "ack", token: token + 1, reply: { ok: true, modifiersHeld: true } });
  assert.equal(s.session.mode, "pending");
  s.dispatch({ type: "ack", token, reply: { ok: true, modifiersHeld: true } });
  s.dispatch({ type: "ackTimeout", token });
  assert.equal(s.session.mode, "overlay");
});

test("fallback: taps walk the frozen order without promoting until the idle timer", () => {
  const s = sim([1, 2, 3, 4], { settings: OFF });
  s.flip();
  assert.equal(s.active, 2);
  s.now += 300;
  s.flip();
  assert.equal(s.active, 3);
  s.now += 300;
  s.flip();
  assert.equal(s.active, 4);
  assert.deepEqual(s.list(), [1, 2, 3, 4], "intermediate tabs not promoted");
  assert.deepEqual(s.session.expect, [], "own activations were consumed");
  const timers = s.log.filter((e) => e.type === "startIdleTimer");
  assert.equal(timers.length, 3);
  // Earlier timers firing late are ignored.
  s.dispatch({ type: "idleTimeout", token: timers[0].token });
  assert.ok(s.session);
  s.now += IDLE_MS;
  s.dispatch({ type: "idleTimeout", token: timers[2].token });
  assert.equal(s.session, null);
  assert.deepEqual(s.list(), [4, 1, 2, 3]);
});

test("fallback F1: tap, wait, tap returns to the origin", () => {
  const s = sim([1, 2, 3], { settings: OFF });
  s.flip();
  s.now += IDLE_MS;
  s.dispatch({ type: "idleTimeout", token: s.log.at(-1).token });
  assert.deepEqual(s.list(), [2, 1, 3]);
  s.now += 500;
  s.flip();
  assert.equal(s.active, 1);
  s.now += IDLE_MS;
  s.dispatch({ type: "idleTimeout", token: s.log.at(-1).token });
  assert.deepEqual(s.list(), [1, 2, 3]);
});

test("fallback: idle timer never fires (worker stopped) -> lazy expiry on the next flip", () => {
  const s = sim([1, 2, 3, 4], { settings: OFF });
  s.flip(); // -> 2
  s.now += 200;
  s.flip(); // -> 3
  // No idleTimeout. Much later the user flips again from tab 3.
  s.now += FALLBACK_STALE_MS + 5000;
  s.take();
  s.flip();
  // Old session ended with 3 promoted, new session went back to 1 (the previous tab).
  assert.equal(s.active, 1);
  assert.deepEqual(s.session.order, [3, 1, 2, 4]);
  s.now += IDLE_MS;
  s.dispatch({ type: "idleTimeout", token: s.session.seq });
  assert.deepEqual(s.list(), [1, 3, 2, 4]);
});

test("fallback: lazy expiry on an unrelated activation keeps the MRU correct", () => {
  const s = sim([1, 2, 3, 4], { settings: OFF });
  s.flip(); // -> 2
  s.now += FALLBACK_STALE_MS + 1;
  s.dispatch({ type: "activated", windowId: W, tabId: 4 });
  assert.equal(s.session, null);
  assert.deepEqual(s.list(), [4, 2, 1, 3]);
});

test("isStale thresholds", () => {
  const base = { order: [1, 2], index: 1, lastFlipAt: 0, expect: [] };
  assert.equal(isStale({ ...base, mode: "fallback" }, FALLBACK_STALE_MS - 1), false);
  assert.equal(isStale({ ...base, mode: "fallback" }, FALLBACK_STALE_MS), true);
  assert.equal(isStale({ ...base, mode: "overlay" }, FALLBACK_STALE_MS), false);
  assert.equal(isStale({ ...base, mode: "overlay" }, OVERLAY_STALE_MS), true);
  assert.equal(isStale(null, 1e12), false);
});

test("overlay never committed (keyup lost) expires lazily without switching", () => {
  const s = sim([1, 2, 3]);
  s.flip();
  s.dispatch({ type: "ack", token: s.lastShow().token, reply: { ok: true, modifiersHeld: true } });
  s.take();
  s.now += OVERLAY_STALE_MS + 1;
  s.flip();
  const fx = s.take();
  assert.deepEqual(fx[0], { type: "hide", tabId: 1 });
  assert.equal(fx[1].type, "show");
  assert.equal(s.session.mode, "pending");
});

test("tab closed mid-session cancels (overlay hidden; fallback keeps the current tab)", () => {
  const o = sim([1, 2, 3]);
  o.flip();
  o.dispatch({ type: "ack", token: o.lastShow().token, reply: { ok: true, modifiersHeld: true } });
  o.take();
  o.dispatch({ type: "external", reason: "removed" });
  assert.equal(o.session, null);
  assert.deepEqual(o.take(), [{ type: "hide", tabId: 1 }]);
  assert.equal(o.active, 1);

  const f = sim([1, 2, 3, 4], { settings: OFF });
  f.flip();
  f.flip();
  f.dispatch({ type: "external", reason: "removed" });
  assert.equal(f.session, null);
  assert.deepEqual(f.list(), [3, 1, 2, 4]);
});

test("a foreign activation cancels the session and is promoted after the session's tab", () => {
  const s = sim([1, 2, 3, 4], { settings: OFF });
  s.flip(); // on 2
  s.dispatch({ type: "activated", windowId: W, tabId: 4 }); // user clicked tab 4
  assert.equal(s.session, null);
  assert.deepEqual(s.list(), [4, 2, 1, 3]);

  const o = sim([1, 2, 3]);
  o.flip();
  o.dispatch({ type: "ack", token: o.lastShow().token, reply: { ok: true, modifiersHeld: true } });
  o.take();
  o.dispatch({ type: "activated", windowId: W, tabId: 3 });
  assert.equal(o.session, null);
  assert.deepEqual(o.take(), [{ type: "hide", tabId: 1 }]);
  assert.deepEqual(o.list(), [3, 1, 2]);
});

test("focus change to another window cancels; same window is ignored", () => {
  const s = sim([1, 2, 3]);
  s.flip();
  s.dispatch({ type: "ack", token: s.lastShow().token, reply: { ok: true, modifiersHeld: true } });
  s.dispatch({ type: "focusChanged", windowId: W });
  assert.equal(s.session.mode, "overlay");
  s.dispatch({ type: "focusChanged", windowId: -1 });
  assert.equal(s.session, null);
});

test("one-tab window: the switcher still shows that one tab, and letting go stays put", () => {
  const s = sim([1]);
  s.flip();
  const show = s.lastShow();
  assert.deepEqual(show.order, [1]);
  assert.equal(show.selectedIndex, 0);
  s.dispatch({ type: "ack", token: show.token, reply: { ok: true, hasFocus: true, modifiersHeld: true } });
  s.take();
  s.flip(); // pressing again stays on the only tab
  s.dispatch({ type: "release" });
  const fx = s.take();
  assert.ok(!fx.some((e) => e.type === "activate"), "nothing to switch to");
  assert.equal(s.session, null);
});

test("one-tab window with the switcher off: flip is a no-op", () => {
  const s = sim([1], { settings: { ...ON, overlay: false } });
  assert.deepEqual(s.flip(), []);
  assert.equal(s.session, null);
});

test("the active tab always leads the frozen order even if the MRU drifted", () => {
  const s = sim([2, 1, 3]);
  s.active = 3;
  s.flip();
  assert.deepEqual(s.lastShow().order, [3, 2, 1]);
});

test("wrap-around in overlay and in fallback", () => {
  const o = sim([1, 2, 3]);
  o.flip();
  o.dispatch({ type: "ack", token: o.lastShow().token, reply: { ok: true, modifiersHeld: true } });
  o.flip();
  o.flip();
  assert.equal(o.session.index, 0);
  o.flip();
  assert.equal(o.session.index, 1);

  const f = sim([1, 2, 3], { settings: OFF });
  f.flip();
  f.flip();
  f.flip();
  assert.equal(f.active, 1, "wrapped back to the origin");
  f.flip();
  assert.equal(f.active, 2);
  assert.deepEqual(f.list(), [1, 2, 3]);
  f.now += IDLE_MS;
  f.dispatch({ type: "idleTimeout", token: f.session.seq });
  assert.deepEqual(f.list(), [2, 1, 3]);
});

test("overlay:false goes straight to fallback without show", () => {
  const s = sim([1, 2, 3], { settings: OFF });
  s.flip();
  assert.equal(s.log.some((e) => e.type === "show"), false);
  assert.equal(s.session.mode, "fallback");
  assert.equal(s.active, 2);
});

test("maxItems caps the frozen order", () => {
  const s = sim([1, 2, 3, 4, 5, 6], { settings: { overlay: true, maxItems: 3 } });
  s.flip();
  assert.deepEqual(s.lastShow().order, [1, 2, 3]);
});

test("flip in another window ends the old session and starts a new one there", () => {
  const s = sim([1, 2, 3], { settings: OFF });
  s.flip();
  s.mru = mru.activated(s.mru, 2, 20);
  s.mru = mru.created(s.mru, 2, 21);
  s.take();
  const r = step(s.session, { type: "flip", windowId: 2, tabId: 20 }, { now: s.now + 10, settings: OFF, order: [20, 21] });
  assert.deepEqual(r.effects[0], { type: "promote", windowId: W, tabId: 2 });
  assert.equal(r.session.windowId, 2);
  assert.deepEqual(r.session.order, [20, 21]);
});

test("unknown events and a missing ctx do not throw", () => {
  assert.deepEqual(step(null, { type: "bogus" }), { session: null, effects: [] });
  assert.deepEqual(step(null, null), { session: null, effects: [] });
  // A flip with no ctx still works: one tab, so the switcher shows just it.
  assert.equal(step(null, { type: "flip", windowId: W, tabId: 1 }).effects[0].type, "show");
});

test("page shortcut: backward starts on the oldest tab, carries its hold modifiers, and walks both ways", () => {
  const s = sim([1, 2, 3, 4]);
  s.dispatch({ type: "flip", windowId: W, tabId: 1, dir: -1, modifiers: ["Alt"] });
  const show = s.lastShow();
  assert.equal(show.selectedIndex, 3);
  assert.deepEqual(show.modifiers, ["Alt"]);
  s.dispatch({ type: "ack", token: show.token, reply: { ok: true, hasFocus: true, modifiersHeld: true } });
  s.take();
  s.dispatch({ type: "flip", windowId: W, tabId: 1, dir: -1 });
  assert.equal(s.session.index, 2);
  s.dispatch({ type: "flip", windowId: W, tabId: 1, dir: 1 });
  s.dispatch({ type: "flip", windowId: W, tabId: 1, dir: 1 });
  assert.equal(s.session.index, 0); // wraps forward past the end
  assert.deepEqual(types(s.take()), ["move", "move", "move"]);
});

test("forward flip without modifiers still shows with Control held", () => {
  const s = sim([1, 2, 3]);
  s.flip();
  assert.equal(s.lastShow().selectedIndex, 1);
  assert.deepEqual(s.lastShow().modifiers, ["Control"]);
});

test("fallback mode: backward flip activates the oldest tab first", () => {
  const s = sim([1, 2, 3, 4], { settings: OFF });
  s.dispatch({ type: "flip", windowId: W, tabId: 1, dir: -1 });
  assert.equal(s.active, 4);
});

test("release from the helper commits the overlay selection", () => {
  const s = sim([1, 2, 3]);
  s.flip();
  s.dispatch({ type: "ack", token: s.lastShow().token, reply: { ok: true, modifiersHeld: true } });
  s.flip(); // on 3
  s.take();
  s.dispatch({ type: "release" });
  assert.equal(s.session, null);
  assert.equal(s.active, 3);
  assert.deepEqual(s.list(), [3, 1, 2]);
});

test("release ends a fallback session at once, without the idle timer", () => {
  const s = sim([1, 2, 3], { settings: OFF });
  s.flip(); // on 2
  s.dispatch({ type: "release" });
  assert.equal(s.session, null);
  assert.deepEqual(s.list(), [2, 1, 3]);
});

test("release before the ack: no switcher stays open, the selection is used", () => {
  const held = sim([1, 2, 3]);
  held.flip();
  held.dispatch({ type: "release" });
  assert.equal(held.session.mode, "pending");
  held.dispatch({ type: "ack", token: held.lastShow().token, reply: { ok: true, modifiersHeld: true } });
  assert.equal(held.session, null, "the page still saw ⌃ down, but it was already let go");
  assert.equal(held.active, 2);

  const noFocus = sim([1, 2, 3]);
  noFocus.flip();
  noFocus.dispatch({ type: "release" });
  noFocus.dispatch({ type: "ack", token: noFocus.lastShow().token, reply: { ok: true, hasFocus: false, modifiersHeld: false } });
  assert.equal(noFocus.session, null);
  assert.equal(noFocus.active, 2);
  assert.deepEqual(noFocus.list(), [2, 1, 3]);
  assert.equal(types(noFocus.take()).includes("startIdleTimer"), false);
});
