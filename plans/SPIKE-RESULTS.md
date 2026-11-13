# TabFlip spike results (Phase 0)

Status: **run 1 analysed** (export of 2026-11-13 08:26 UTC, macOS 27.2, Safari 27.2). Seven questions are answered, four are still open because the shortcut was never pressed on a loaded website during run 1 (every `flip` fired on the probe page, an empty tab, the Start Page or a still-loading tab). The open ones are marked **unverified**.

| # | Status | Answer in one line |
|---|---|---|
| S1 | partly | `MacCtrl+Q` fires on the Start Page, empty tabs and extension pages. On a loaded website / in a text field: **unverified**. |
| S2 | partly | Safari silently drops a `MacCtrl+Tab` command. Content-script interception: no evidence it is possible; **unverified**. |
| S3 | partly | No `commands.update` API. Rebinding UI in Safari Settings: **unverified**. |
| S4 | open | **unverified** — no samples. This is the feasibility question for hold-to-browse. |
| S5 | partly | A tab without a content script answers `tabs.sendMessage` in 0–1 ms with an empty response. Latency on a real page: **unverified**. |
| S6 | answered | Capture works with no user gesture, 7–18 ms, downscale 3–10 ms. |
| S7 | answered | `tab.favIconUrl` is never present. Pages do expose icon links to the content script. |
| S8 | partly | Core events fire, with two quirks (below). Attach/detach, Tab Groups, profiles: **unverified**. |
| S9 | answered | `storage.session` survives restarts. Background is stopped after ~29 s idle. |
| S10 | answered | Module service worker loads; static imports work. Converter warning is a false alarm. |
| S11 | partly | `isAllowedIncognitoAccess` is false by default. Behaviour inside a private window: **unverified**. |

## S1 — partly answered

- `commands.onCommand` fired 9 times (8 `flip`, 1 `close-and-return`), each with a populated `tab` argument that agreed with `tabs.query` for the current window.
- It fired on: the extension's own page, an empty tab (no URL), the Start Page (`favorites:`), and a tab that was still loading. Three presses 240–340 ms apart all registered, so rapid taps are delivered.
- None of those tabs had a reachable content script, so nothing here shows the shortcut works on a loaded website or with a text field focused. **Unverified.**

## S2 — partly answered

- The manifest declared `probe-ctrl-tab` with `MacCtrl+Tab`. `commands.getAll()` returns only `flip` and `close-and-return`: Safari loaded the extension and silently discarded the Control-Tab command. Control-Tab cannot be claimed through `commands`.
- No Control-Tab `keydown` was recorded by any content script, although adjacent-tab switches happened while content scripts were live on those tabs (tabs 511↔512). That is consistent with Safari consuming the key before the page sees it, but run 1 did not label those presses, so treat it as likely, not proven. The blocking test was not run.
- The user's note describes inconsistent switching, which is Safari's own Control-Tab behaviour — no extension code acted on that key.

## S3 — partly answered

- `browser.commands.update` is undefined: the extension cannot rebind programmatically.
- Whether Safari Settings offers a rebinding UI was not noted. **Unverified.**

## S4 — unverified

No samples. Needs one hold-and-release of Control-Q on a loaded website.

## S5 — partly answered

- On tabs with no content script, `tabs.sendMessage` resolved in 0–1 ms with an empty response (it did not reject and did not hang). The background can treat an empty/undefined response as "no content script" and go to fallback immediately, without waiting for the ack timer.
- Latency on a page with a content script: **unverified**.

## S6 — answered

- `tabs.captureVisibleTab` succeeded from `tabs.onActivated` with no user gesture.
- Capture 7–18 ms for a 2071×1047 JPEG (35–240 KB). Downscale to 320 px wide with `createImageBitmap` + `OffscreenCanvas`: decode 4–14 ms, draw+encode 2–10 ms, result 1.7–9.5 KB.
- It fails with a permission error for tabs whose `tab.url` is absent (empty tab; a restored tab that has not loaded yet). Rule: capture only when `tab.url` is present.
- Captures taken while `status` was `loading` produced the same 35,292-byte image as a blank page, i.e. nothing useful. Rule: capture only at `status: complete`.

## S7 — answered

- `favIconUrl` was absent on all 11 tabs (`hasKey: false`).
- Content scripts found `<link rel="icon">` on all 5 sampled pages (1–7 candidates each, all `https:`). Icons must come from the content script (`page:meta`).

## S8 — partly answered

Fired: `tabs.onActivated` (21, with `previousTabId`), `onCreated` (5), `onRemoved` (2), `onReplaced` (2), `onUpdated`, `windows.onFocusChanged` (3, including `-1` when Safari loses focus). Tab ids were stable across background restarts.

Quirks the background must handle:

1. **A tab created already active gets no `onActivated`.** New tab 1546 was created with `active: true` and no activation event followed. Treat `onCreated` with `active: true` as an activation.
2. **Opening an extension page fires create → replace → remove.** A tab is created, a second tab is created with `windowId: -1` and `index: null`, then `onReplaced(added, removed)` and `onRemoved(removed)`. `onCreated` events with `windowId: -1` must not be filed under a window; `onReplaced` must carry the old tab's MRU position to the new id.
3. `tab.url` is absent for empty tabs and for restored tabs until they load.

Not exercised: `onAttached` / `onDetached` (no tab was dragged between windows), Tab Group switch, profiles. **Unverified.**

## S9 — answered

- `storage.session` exists, round-trips, and its contents survived both background restarts.
- The background was stopped ~29 s after its last event, twice (28.8 s and 28.6 s), even with the probe's 2 s heartbeat timer running — timers do not keep it alive. Events arriving afterwards restarted it and were delivered (first event 1–3 ms after boot).
- Consequence: assume a cold start before almost every gesture. No in-memory state, no long timers.

## S10 — answered

`ServiceWorkerGlobalScope`, `staticImportWorked: true`, `OffscreenCanvas` and `createImageBitmap` present, no `window`/`document`. Keep `{ "service_worker": "background.js", "type": "module" }`.

## S11 — partly answered

`extension.isAllowedIncognitoAccess()` returned false; no private tab appeared in any snapshot. Whether the extension can be enabled for Private Browsing and what it sees there: **unverified**.

## Still to run (about one minute)

On a fully loaded ordinary website (not the probe page, Start Page or an empty tab):

1. Tap Control-Q once.
2. Hold Control, tap Q, keep holding Control for two seconds, release.
3. Click into a text field on the page and tap Control-Q.
4. Press Control-Tab once.
5. Back on the probe page: Copy results.
