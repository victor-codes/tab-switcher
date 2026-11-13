// TabFlip core/session.js. Owner: Agent 1.
//
// The switch-session state machine (one hold-and-tap gesture). Pure reducer:
//   step(session, event, ctx) -> { session, effects }
// No browser API, no clock: the caller passes ctx.now. Effects are plain data that
// background.js executes in order.
//
// Session: { id, windowId, originTabId, order: number[], index,
//            mode: "pending" | "overlay" | "fallback", startedAt, lastFlipAt, seq,
//            expect: number[] /* tab ids the session activated, onActivated not seen yet */ }
// "pending" = switcher:show sent, ack not processed yet.
//
// Events:
//   { type: "flip", windowId, tabId }            ctx: { now, settings, order }  (tabId = active tab)
//   { type: "ack", token, reply }                 content-script reply to switcher:show:
//        { ok: true, hasFocus, modifiersHeld }; hasFocus false -> fallback; hasFocus missing = true
//   { type: "ackTimeout", token }                 no reply within ACK_TIMEOUT_MS
//   { type: "commit", senderTabId, tabId }        switcher:commit
//   { type: "cancel", senderTabId }               switcher:cancel (Esc)
//   { type: "idleTimeout", token }                the fallback idle timer fired
//   { type: "activated", windowId, tabId }        tabs.onActivated / onCreated(active)
//   { type: "focusChanged", windowId }            windows.onFocusChanged
//   { type: "external", reason }                  tab removed / attached / detached / replaced, window closed
//   { type: "closeAndReturn", windowId, tabId }   ctx: { order }
//
// Effects:
//   { type: "show", tabId, order, selectedIndex, token, ackTimeoutMs }  send switcher:show, then
//        feed back "ack" (reply, possibly undefined) or "ackTimeout"  — this is the ack timer
//   { type: "move", tabId, selectedIndex }
//   { type: "hide", tabId }
//   { type: "activate", tabId }
//   { type: "remove", tabId }
//   { type: "startIdleTimer", token, ms }        after ms, feed back { type: "idleTimeout", token }
//   { type: "promote", windowId, tabId }         mru.activated(windowId, tabId)

export const ACK_TIMEOUT_MS = 150;
export const IDLE_MS = 1000;
/** A fallback session older than this (since the last flip) is over, even if the idle timer never fired. */
export const FALLBACK_STALE_MS = 1500;
/** A pending session can only outlive its ack if the worker died mid-flip. */
export const PENDING_STALE_MS = 1000;
/** Guard against an overlay whose commit never arrives (e.g. modifier keyup not delivered). */
export const OVERLAY_STALE_MS = 10000;
export const DEFAULT_MAX_ITEMS = 8;

const STALE_MS = { pending: PENDING_STALE_MS, overlay: OVERLAY_STALE_MS, fallback: FALLBACK_STALE_MS };

function isId(v) {
  return Number.isInteger(v) && v >= 0;
}

/** True when `session` has outlived its mode's timeout at time `now`. */
export function isStale(session, now) {
  if (!session) return false;
  const limit = STALE_MS[session.mode] ?? 0;
  return !(now - (session.lastFlipAt ?? 0) < limit);
}

/** The tab the session currently points at. */
export function current(session) {
  return session ? session.order[session.index] : undefined;
}

/**
 * End `session` without a user commit (cancel, external event, timeout).
 * Overlay/pending: hide the overlay, stay where we are. Fallback: the user is already on
 * order[index], so promote it once (intermediate tabs were never promoted).
 */
function end(session) {
  if (!session) return [];
  if (session.mode === "fallback") {
    return [{ type: "promote", windowId: session.windowId, tabId: current(session) }];
  }
  return [{ type: "hide", tabId: session.originTabId }];
}

function maxItems(settings) {
  const n = settings && Number.isInteger(settings.maxItems) ? settings.maxItems : DEFAULT_MAX_ITEMS;
  return Math.max(2, n);
}

function startFallback(session, now) {
  const next = { ...session, mode: "fallback", lastFlipAt: now, seq: session.seq + 1 };
  const target = current(next);
  next.expect = [...next.expect, target];
  return {
    session: next,
    effects: [
      { type: "activate", tabId: target },
      { type: "startIdleTimer", token: next.seq, ms: IDLE_MS },
    ],
  };
}

function startSession(event, ctx) {
  const now = ctx.now;
  const active = event.tabId;
  if (!isId(active) || !isId(event.windowId)) return { session: null, effects: [] };
  const known = (Array.isArray(ctx.order) ? ctx.order : []).filter((id) => isId(id) && id !== active);
  const order = [active, ...known].slice(0, maxItems(ctx.settings));
  if (order.length < 2) return { session: null, effects: [] };
  const session = {
    id: now,
    windowId: event.windowId,
    originTabId: active,
    order,
    index: 1,
    mode: "pending",
    startedAt: now,
    lastFlipAt: now,
    seq: 0,
    expect: [],
  };
  if (ctx.settings && ctx.settings.overlay === false) return startFallback(session, now);
  return {
    session,
    effects: [{ type: "show", tabId: active, order: order.slice(), selectedIndex: 1, token: session.id, ackTimeoutMs: ACK_TIMEOUT_MS }],
  };
}

function flip(session, event, ctx) {
  const now = ctx.now;
  if (session) {
    if (session.mode === "pending") return { session, effects: [] }; // cannot happen while events are serialised
    const sameGesture =
      event.windowId === session.windowId &&
      (session.mode === "overlay" ? event.tabId === session.originTabId : event.tabId === current(session));
    if (sameGesture) {
      const next = { ...session, index: (session.index + 1) % session.order.length, lastFlipAt: now, seq: session.seq + 1 };
      if (next.mode === "overlay") {
        return { session: next, effects: [{ type: "move", tabId: next.originTabId, selectedIndex: next.index }] };
      }
      const target = current(next);
      next.expect = [...next.expect, target];
      return {
        session: next,
        effects: [
          { type: "activate", tabId: target },
          { type: "startIdleTimer", token: next.seq, ms: IDLE_MS },
        ],
      };
    }
    // Different window or the user moved on without us noticing: end it and start afresh.
    const ended = end(session);
    const started = startSession(event, ctx);
    return { session: started.session, effects: [...ended, ...started.effects] };
  }
  return startSession(event, ctx);
}

function commitTo(session, tabId) {
  const effects = [{ type: "hide", tabId: session.originTabId }];
  if (tabId !== session.originTabId) effects.push({ type: "activate", tabId });
  effects.push({ type: "promote", windowId: session.windowId, tabId });
  return { session: null, effects };
}

function ack(session, event, ctx) {
  if (!session || session.mode !== "pending" || event.token !== session.id) return { session, effects: [] };
  const r = event.reply;
  if (r && r.ok === true && typeof r.modifiersHeld === "boolean") {
    if (r.hasFocus === false) {
      // The page cannot see key events, so no keyup will ever arrive. Hide in case it drew.
      const f = startFallback(session, ctx.now);
      return { session: f.session, effects: [{ type: "hide", tabId: session.originTabId }, ...f.effects] };
    }
    // hasFocus true or absent (treated as true):
    if (r.modifiersHeld) return { session: { ...session, mode: "overlay" }, effects: [] };
    return commitTo(session, current(session)); // quick tap: key already released
  }
  return startFallback(session, ctx.now); // undefined / malformed reply: no content script
}

function ackTimeout(session, event, ctx) {
  if (!session || session.mode !== "pending" || event.token !== session.id) return { session, effects: [] };
  // A slow page might still draw the overlay after we gave up on it.
  const r = startFallback(session, ctx.now);
  return { session: r.session, effects: [{ type: "hide", tabId: session.originTabId }, ...r.effects] };
}

function commit(session, event) {
  if (!session || session.mode !== "overlay" || event.senderTabId !== session.originTabId) return { session, effects: [] };
  const target = session.order.includes(event.tabId) ? event.tabId : current(session);
  return commitTo(session, target);
}

function cancel(session, event) {
  if (!session || session.mode !== "overlay" || event.senderTabId !== session.originTabId) return { session, effects: [] };
  return { session: null, effects: end(session) };
}

function idleTimeout(session, event) {
  if (!session || session.mode !== "fallback" || event.token !== session.seq) return { session, effects: [] };
  return { session: null, effects: end(session) };
}

function activatedEvent(session, event) {
  const promote = { type: "promote", windowId: event.windowId, tabId: event.tabId };
  if (!session) return { session, effects: [promote] };
  const i = session.expect.indexOf(event.tabId);
  if (i !== -1) {
    // Caused by the session itself: do not reorder the frozen MRU.
    return { session: { ...session, expect: [...session.expect.slice(0, i), ...session.expect.slice(i + 1)] }, effects: [] };
  }
  return { session: null, effects: [...end(session), promote] };
}

function focusChanged(session, event) {
  if (!session || event.windowId === session.windowId) return { session, effects: [] };
  return { session: null, effects: end(session) };
}

function closeAndReturn(session, event, ctx) {
  const effects = end(session);
  const active = event.tabId;
  if (!isId(active)) return { session: null, effects };
  const order = (Array.isArray(ctx.order) ? ctx.order : []).filter((id) => isId(id) && id !== active);
  // Activate the previous MRU tab first so Safari never shows the neighbour, then close.
  if (order.length) effects.push({ type: "activate", tabId: order[0] });
  effects.push({ type: "remove", tabId: active });
  return { session: null, effects };
}

/**
 * Advance the state machine. A stale session (see isStale) is ended first, so lazy expiry
 * happens on whatever event arrives next, and its effects come before the event's own.
 */
export function step(session, event, ctx = {}) {
  const now = ctx.now ?? 0;
  let pre = [];
  if (session && isStale(session, now)) {
    pre = end(session);
    session = null;
  }
  const c = { ...ctx, now };
  let r;
  switch (event && event.type) {
    case "flip": r = flip(session, event, c); break;
    case "ack": r = ack(session, event, c); break;
    case "ackTimeout": r = ackTimeout(session, event, c); break;
    case "commit": r = commit(session, event); break;
    case "cancel": r = cancel(session, event); break;
    case "idleTimeout": r = idleTimeout(session, event); break;
    case "activated": r = activatedEvent(session, event); break;
    case "focusChanged": r = focusChanged(session, event); break;
    case "external": r = { session: null, effects: end(session) }; break;
    case "closeAndReturn": r = closeAndReturn(session, event, c); break;
    default: r = { session, effects: [] };
  }
  return { session: r.session ?? null, effects: [...pre, ...r.effects] };
}
