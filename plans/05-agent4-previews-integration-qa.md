# Agent 4 — previews, integration, QA (Phase 2) and optional Phase 3

Read `00-overview.md`, `SPIKE-RESULTS.md`, and the final reports of Agents 1–3 first. Starts only after Phase 1 is merged and building. You own `extension/core/previews.js`; for integration fixes you may edit any file, but keep each fix minimal and list every cross-ownership edit in your report.

## Previews (`core/previews.js`)

Only if spike S6 says capture works; otherwise skip to integration and record previews as descoped.

- Capture the visible tab of the focused window ~600 ms after it becomes active and again when the active tab finishes loading (`tabs.onUpdated` status `complete`), debounced, at most one capture per tab per 5 s. Also capture the origin tab at session start if it has none.
- Never capture: private tabs, while a switch session is active (the overlay would be in the picture), or when `settings.previews` is false.
- Only capture when `tab.url` is present and `status` is `complete` (measured: otherwise it fails or yields a blank image).
- Downscale to 480 px wide JPEG (quality ~0.6) with `createImageBitmap` + `OffscreenCanvas` (measured to work, a few ms). Store in `browser.storage.session` under one key per tab (`preview:<tabId>`, value `{ dataUrl, at }`) — not inside the main state object, so the wake path stays small, and not on disk, so previews vanish when Safari quits. Cap at 60 entries, evict least recently captured; delete on `tabs.onRemoved` and on startup for ids that no longer exist.
- `getPreview(tabId) -> Promise<string | null>` returns a data URL; this is the hook Agent 1 left in `background.js`.
- Implement `data:clear` (wipe stored previews, stored icons and MRU, then re-seed) and react to `previews` being switched off by wiping previews.
- Budget: building the `switcher:show` payload must not push the ack past the timeout. If attaching previews is slow, send `show` without previews and follow with a `switcher:previews` message (`{ previews: { [tabId]: dataUrl } }`) — add it to the contract in `00-overview.md` and to the content script.

## Integration

- Run the full gesture end to end, fix contract mismatches between background and overlay, remove dead stubs.
- Add `tests/previews.test.js` for eviction and throttling logic (pure parts only).

## QA matrix (hand to the user as a checklist; record results in `plans/QA-RESULTS.md`)

Rows: F1–F6 from the overview. Columns/conditions: normal site; strict-CSP site; Start Page and empty tab (fallback); PDF tab; site with extension access denied; text field focused; video in fullscreen; two windows; tab dragged between windows; Tab Group switch; second profile; private window; pinned tabs; 1 tab, 2 tabs, 50+ tabs; after Safari relaunch; after the background has been idle for several minutes; light and dark; reduced motion.

For each failure: reproduce, fix if within scope, otherwise log it with severity.

## Phase 3 (optional) — Control-Tab

Run only if the orchestrator asks. Precondition from spike S2:

- If a content-script `keydown` can intercept Control-Tab: add an opt-in setting that makes the content script translate Control-Tab into the `flip` flow on pages where it runs. Document that it cannot work on pages without the content script.
- If not: write a feasibility note only (no code) on a native route — container app as a login item with a global key handler forwarding to the extension through native messaging — covering required permissions (Accessibility / Input Monitoring), sandbox and App Store implications, and whether Safari's own handling can actually be pre-empted. The orchestrator and user decide before anything is built.
