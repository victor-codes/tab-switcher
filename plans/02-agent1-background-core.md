# Agent 1 — MRU core, session machine, background wiring (Phase 1)

Read `00-overview.md` and `SPIKE-RESULTS.md` first. You own `extension/background.js`, `extension/core/mru.js`, `extension/core/session.js`, `extension/core/store.js`, and `tests/`. You do not touch the content script; code against the message contract only.

## Build order

1. **`core/mru.js`** — the pure functions listed in the overview. No `browser` references. Immutable in, immutable out.
2. **`core/session.js`** — pure reducer: `step(session, event, ctx) -> { session, effects[] }`.
   Events: `flip`, `ack`, `ackTimeout`, `commit`, `cancel`, `idleTimeout`, `external` (tab removed / foreign activation / focus change).
   Effects (plain data, executed by `background.js`): `show`, `move`, `hide`, `activate(tabId)`, `startAckTimer`, `startIdleTimer`, `promote(tabId)`.
   Implement the state diagram in the overview exactly, including: quick tap commits without overlay; fallback does not promote intermediate tabs; wrap-around; fewer than two tabs is a no-op; `settings.overlay === false` goes straight to fallback.
3. **`core/store.js`** — `load()` / `save(state)` over `browser.storage.session` (or the alternative the spike chose), plus a serial promise queue `enqueue(fn)` so events are processed one at a time in arrival order. State shape: `{ mru, session, icons: { [tabId]: url } }`.
4. **`background.js`** — wiring only, no logic:
   - Register every listener synchronously at top level (required for a non-persistent background to be woken).
   - On each event: `enqueue(async () => { state = await load(); …reduce…; await save(state); run effects })`.
   - `runtime.onStartup` / `onInstalled` and first wake with empty state: `seed` from `tabs.query({})`.
   - Tab events → `mru.*`; ignore `onActivated` for tab ids the current session itself activated.
   - `commands.onCommand`: `flip` → session `flip`; `close-and-return` → as specified.
   - `runtime.onMessage`: `switcher:commit`, `switcher:cancel`, `page:meta` (store icon by `sender.tab.id`).
   - Building `items` for `switcher:show`: `tabs.get` each id (drop ids that fail and repair the MRU), title, host from URL, icon from `state.icons`, `preview: null` for now. Leave one clearly marked hook, `getPreview(tabId)`, imported from `core/previews.js` (Agent 4 fills it; the stub returns `null`).
   - Timers: because the background can be stopped, the ack timer is a plain `setTimeout` (150 ms is short enough); for the 1000 ms fallback idle timer also store `session.startedAt`/`lastFlipAt` and treat a session older than 1500 ms as expired on the next event.
   - Private windows: follow the spike result; never store icons or titles for incognito tabs.

## Tests (`tests/*.test.js`, `node --test`, no dependencies)

- `mru`: activation ordering, background-tab append, removal, attach/detach across windows, replace, seed merge, unknown ids.
- `session`: scripted event sequences → expected effects. Minimum cases: single flip there and back; triple tap then release selects the 4th MRU entry; quick tap (ack with `modifiersHeld:false`); ack timeout → fallback; fallback taps do not reorder until idle; Esc; tab closed mid-session; one-tab window; wrap-around; `overlay:false`.
- A small fake `browser` object to test `background.js` wiring end to end for: flip A→B→A, close-and-return, wake with persisted state.

## Done when

Tests pass, the Xcode build is green, and your report includes a manual checklist covering F1, F3, F5 and fallback mode on the Start Page (the overlay may still be a stub at this point — F1 must work regardless via the fallback path).
