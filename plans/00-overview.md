# TabFlip — master plan

A Safari extension for macOS that switches between tabs in most-recently-used (MRU) order with a keyboard shortcut. Working name: **TabFlip** (do not use the name, icon, copy or artwork of any existing product).

Every agent reads this file first, then its own plan. This file is the contract; if a plan and this file disagree, this file wins. If reality disagrees with this file (an API behaves differently in Safari), stop, record it in `plans/SPIKE-RESULTS.md`, and tell the orchestrator rather than silently changing a contract.

## Product behaviour

| # | Feature | Behaviour |
|---|---------|-----------|
| F1 | Flip back | Press the shortcut once: go to the previously used tab in this window. Press again: return. |
| F2 | Browse recents | Hold the modifier, keep tapping the key: selection walks down the MRU list in an on-page overlay. Release the modifier: switch to the selection. Esc cancels. |
| F3 | Close and return | A second shortcut closes the current tab and activates the previous MRU tab (not the neighbour). |
| F4 | Recognise the page | Overlay rows show title, host, site icon and a thumbnail preview. |
| F5 | Multi-window | MRU order is tracked per window. The shortcut acts on the focused window only. |
| F6 | Private by construction | No network requests, no analytics. History and previews live in extension storage on the Mac only. Nothing is captured or persisted for private windows. |

Non-goals for v1: iOS/iPadOS, cross-window switching, sync, tab search, App Store submission.

## Architecture

Safari Web Extension (Manifest V3) inside a minimal macOS container app. Three runtime pieces:

1. **Background (non-persistent)** — owns MRU state, handles `commands`, runs the switch session state machine, captures previews. It can be killed at any time, so every state change is written through to `browser.storage.session` and re-hydrated on wake.
2. **Content script (all pages, top frame)** — passively tracks modifier-key state, renders the overlay in a closed shadow root, reports modifier release / Esc / click.
3. **Container app (SwiftUI)** — onboarding only: explains how to enable the extension and grant website access, shows the shortcuts. It is a delivery vehicle, not a runtime: no login item, no menu bar item, no background process. Safari loads and runs the extension itself; the app can be quit (or never opened again) once the extension is enabled.

Why a content script is required: the `commands` API only reports key *presses*. Detecting the modifier *release* (F2) is only possible from inside the page. Pages where content scripts cannot run (Start Page, Safari internal pages, sites without granted access, PDFs) use the **fallback mode** below.

### Repository layout and file ownership

```
tabflip/
  plans/                         orchestrator only (+ SPIKE-RESULTS.md by Agent 0)
  extension/                     source of truth for web-extension resources
    manifest.json                Agent 0 — frozen after Phase 0
    background.js                Agent 1 (entry: wiring only)
    core/mru.js                  Agent 1 (pure, no browser API)
    core/session.js              Agent 1 (pure state machine)
    core/store.js                Agent 1 (storage.session write-through)
    core/previews.js             Agent 4
    content/switcher.js          Agent 2 (single classic script, no imports)
    content/harness.html         Agent 2 (standalone dev page, not in manifest)
    options/options.{html,js,css} Agent 3
    images/                      Agent 3
    _locales/en/messages.json    Agent 0 creates, Agent 3 may add keys
  tests/                         Agent 1 (node:test, zero dependencies)
  TabFlip/                       Agent 3 (container app Swift sources)
  TabFlip Extension/             Agent 0 (generated handler; nobody edits later)
  TabFlip.xcodeproj              Agent 0; later agents do not edit the project file
  README.md                      Agent 3
```

Two agents never edit the same file. Phase 0 creates stub files for every path referenced by `manifest.json` so later agents only fill in bodies.

### Measured Safari behaviour (spike run 1 — see `SPIKE-RESULTS.md`)

These are facts, not assumptions; design to them.

- **Cold starts are normal.** The background is stopped ~29 s after its last event; timers do not keep it alive. `storage.session` survives. Events restart it and are delivered. Keep nothing in memory across events and keep the wake path short (one `storage.session` read before acting).
- **`tabs.onActivated` does not fire for a tab created already active.** Treat `tabs.onCreated` with `active: true` as an activation.
- **Opening an extension page fires create → create(`windowId: -1`) → `onReplaced` → `onRemoved`.** Ignore `onCreated` with `windowId: -1`; `onReplaced` moves the old id's MRU position to the new id.
- **`tab.url` is absent** for empty tabs and for restored tabs that have not loaded. `Item.host` is then `""`; never assume a URL.
- **No content script → instant empty reply.** `tabs.sendMessage` to such a tab resolves in ~1 ms with `undefined` (no rejection). Treat `undefined` or a rejection as "no content script" and go to fallback at once; the ack timer only guards a slow page.
- **`tab.favIconUrl` never exists.** Icons come only from `page:meta`.
- **`captureVisibleTab` works without a user gesture** (7–18 ms; downscale with `createImageBitmap` + `OffscreenCanvas` 3–10 ms; a 320 px JPEG is 2–10 KB). It fails when `tab.url` is absent and returns a blank image while `status` is `loading`.
- **Module service worker loads**; static imports work. No `window`/`document` in the background.
- **Safari silently drops a `MacCtrl+Tab` command**, and `commands.update` does not exist.
- The command's `tab` argument is populated and matches the active tab of the current window.

Still unverified (do not build on these without a caveat): the shortcut on a loaded website and in a text field; modifier `keyup` reaching the content script after a command (the basis of F2); message latency on a real page; attach/detach, Tab Groups, profiles, private windows.

### Shortcuts (defaults; `MacCtrl+Q` confirmed on non-web pages)

| Command id | Default (mac) | Feature |
|---|---|---|
| `flip` | `MacCtrl+Q` | F1/F2 |
| `close-and-return` | `MacCtrl+W` | F3 |

Control-Tab cannot be claimed through `commands` (measured). It stays out of v1 (see Phase 3 in `05`).

### MRU model (`core/mru.js`)

State: `{ windows: { [windowId]: number[] /* tabIds, most recent first */ } }`.

Pure functions, each returns a new state:
`seed(state, tabs)`, `activated(state, windowId, tabId)`, `removed(state, windowId, tabId)`, `attached(state, windowId, tabId)`, `detached(state, windowId, tabId)`, `replaced(state, oldId, newId)`, `windowRemoved(state, windowId)`, `list(state, windowId) -> number[]`.

Rules: `activated` moves the id to index 0. New background tabs are appended at the end. Unknown ids are tolerated everywhere (never throw). `seed` puts the currently active tab first, then the remaining tabs in tab-strip order, and keeps any existing order for ids it already knows.

### Switch session (`core/session.js`)

A session is one hold-and-tap gesture. State: `{ windowId, originTabId, order: number[] /* frozen MRU snapshot */, index, mode: "overlay" | "fallback", startedAt }`.

```
flip command, no session:
  order = list(window); if order.length < 2 -> no-op
  index = 1
  ask content script of the active tab to show (message below, 150 ms ack timeout)
    ack {ok:true, modifiersHeld:true}  -> mode = overlay (overlay is drawn instantly, no display delay)
    ack {ok:true, modifiersHeld:false} -> commit immediately (key already released; nothing to draw)
    undefined reply / rejection / timeout -> mode = fallback (undefined arrives in ~1 ms)
flip command, session active:
  index = (index + 1) % order.length
  overlay  -> send switcher:move
  fallback -> activate order[index] immediately, restart the 1000 ms idle timer
commit (overlay): activate order[index], end session
cancel: end session, stay on origin
fallback start: activate order[1] immediately, start 1000 ms idle timer;
  timer expiry ends the session (the MRU then reflects the final tab)
```

While a session is active, `tabs.onActivated` events caused by the session itself must not reorder the frozen `order`; on session end the final tab is moved to MRU front once. Intermediate tabs visited in fallback mode must **not** be promoted — otherwise repeated taps would bounce between two tabs. Any tab removal, window focus change, or activation not initiated by the session cancels the session.

`close-and-return`: read `list(window)`, remove the active tab, activate `order[1]` if it exists.

### Message contract (JSON, `browser.runtime` messaging)

Background → content (`tabs.sendMessage(tabId, msg)`), content replies with the listed response:

| `type` | Payload | Response |
|---|---|---|
| `switcher:show` | `items: Item[]`, `selectedIndex: number`, `modifiers: string[]` (e.g. `["Control"]`) | `{ ok: true, modifiersHeld: boolean }` |
| `switcher:move` | `selectedIndex: number` | `{ ok: true }` |
| `switcher:hide` | — | `{ ok: true }` |

Content → background (`runtime.sendMessage`):

| `type` | Payload | Meaning |
|---|---|---|
| `switcher:commit` | `tabId: number` | modifier released, row clicked, or page lost focus while shown |
| `switcher:cancel` | — | Esc |
| `page:meta` | `icon: string \| null` (absolute URL of best `<link rel~=icon>`) | sent once at `document_idle` |

`Item = { tabId: number, title: string, host: string, icon: string | null, preview: string | null /* data: URL */ }`. `items` is capped at the setting `maxItems` (default 8) and is in frozen MRU order; `items[0]` is the current tab.

### Settings (`browser.storage.local`, key `settings`)

`{ overlay: true, previews: true, maxItems: 8 }`. Agent 3 writes them from the options page; Agent 1 reads them (with these defaults when absent) and reacts to `storage.onChanged`. `overlay: false` forces fallback mode everywhere. `previews: false` stops capture and clears stored previews.

## Phases and dependencies

```
Phase 0  Agent 0  scaffold + spike            (blocking, needs the user at the Mac for ~5 min)
Phase 1  Agent 1  background + MRU + session  ┐
         Agent 2  overlay content script      ├ parallel, disjoint files
         Agent 3  container app + options     ┘
Phase 2  Agent 4  previews + icons, integration, QA pass   (after 1–3 merge)
Phase 3  optional: Control-Tab via native helper            (only if the spike says it is needed and feasible)
```

Orchestrator gate after Phase 0: read `plans/SPIKE-RESULTS.md`, amend this file where the spike contradicts it (shortcut defaults, background type, preview capture, icon source), then release Phase 1.

## Rules for every agent

- Stay inside your owned files. Need a change elsewhere? Report it; do not make it.
- No third-party dependencies, no bundler, no network calls in shipped code.
- Use the `browser.*` promise API. Target Safari 17+ / macOS 14+.
- Build check before reporting done: `xcodebuild -project TabFlip.xcodeproj -scheme TabFlip -configuration Debug build` must succeed, and `node --test tests/` must pass.
- Agents cannot drive Safari's UI. Anything that needs a human in Safari goes into a numbered manual checklist in your final report, with expected results.
- Report format: what was built, what was verified and how, what was not verified, deviations from this file.
