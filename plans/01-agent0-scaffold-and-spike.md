# Agent 0 — scaffold and spike (Phase 0, blocking)

Read `00-overview.md` first. Goal: a building Xcode project with the final manifest and stub files, plus measured answers to the open Safari questions. Work in `/Users/eva/Dev/ideas/multi-folder/tabflip`. Machine: macOS 27.2, Safari 27.2, Xcode 26.2; `safari-web-extension-converter` is available through `xcrun`.

## Part A — scaffold

1. `git init` in `tabflip/`; add a `.gitignore` for Xcode (`build/`, `DerivedData/`, `xcuserdata/`, `.DS_Store`).
2. Create `extension/` with:
   - `manifest.json` (MV3): `name`/`description` via `_locales`, `version` `0.1.0`, `default_locale` `en`;
     `permissions`: `tabs`, `storage`, `activeTab`; `host_permissions`: `<all_urls>`;
     `background`: `{ "service_worker": "background.js", "type": "module" }`;
     `content_scripts`: one entry, `matches` `<all_urls>`, `js` `content/switcher.js`, `run_at` `document_start`, `all_frames` false;
     `options_ui`: `options/options.html`;
     `commands`: `flip` and `close-and-return` with the defaults from the overview and descriptions;
     `icons`: 48/96/128/256/512 pointing into `images/`.
   - Stub files for every referenced path and for `core/mru.js`, `core/session.js`, `core/store.js`, `core/previews.js` (each exporting nothing yet, with a one-line header naming its owner agent). Placeholder solid-colour PNG icons are fine.
3. Generate the project **referencing** `extension/` (do not copy resources, so `extension/` stays the single source of truth):
   `xcrun safari-web-extension-converter extension --project-location . --app-name TabFlip --bundle-identifier com.example.tabflip --swift --macos-only --no-open --no-prompt`
   Check `--help` first; flag names vary by Xcode version. If the tool nests the project in a `TabFlip/` subfolder, move things so the layout matches the overview, and confirm the project still builds.
4. Build: `xcodebuild -project TabFlip.xcodeproj -scheme TabFlip -configuration Debug build`. Fix until green. Signing: "Sign to Run Locally", no team.
5. Commit.

## Part B — spike

Put temporary probe code in `background.js` and `content/switcher.js` (log to the console and to `storage.local` under `spike`, so results can be read from the options page stub). Then hand the user this checklist and wait for their answers — you cannot operate Safari yourself:

1. Run the built `TabFlip.app` once. Safari → Settings → Developer → enable "Allow unsigned extensions" (requires the Develop menu to be on). Settings → Extensions → enable TabFlip and allow it on all websites.
2. Open three ordinary sites in one window, then follow the on-page probe instructions and read back what the options page shows.

Questions to answer, each with evidence:

| # | Question | Why it matters |
|---|---|---|
| S1 | Does the `flip` command fire with `MacCtrl+Q`? Also from the Start Page and while a text field has focus? | default shortcut |
| S2 | Does a command declared as `MacCtrl+Tab` fire, or does Safari keep Control-Tab? Does a content-script `keydown` for Control-Tab arrive, and can `preventDefault()` stop Safari's own switch? | decides Phase 3 |
| S3 | Can the user rebind extension shortcuts anywhere in Safari Settings? | options-page copy |
| S4 | Does the content script receive `keyup` for Control after a command fired? Is `event.getModifierState` reliable at message time? | F2 feasibility |
| S5 | Round-trip latency of `tabs.sendMessage` + ack on a normal page (median of 20). Is the 150 ms ack timeout sane? | session timing |
| S6 | Does `tabs.captureVisibleTab` work from the background without a user gesture, with these permissions? Size and time of one capture. Is `OffscreenCanvas` (2D) and `createImageBitmap` available in the background for downscaling? | previews |
| S7 | Is `tab.favIconUrl` populated? | icon source |
| S8 | Do `tabs.onActivated`, `onRemoved`, `onAttached`, `onDetached`, `onReplaced`, `windows.onFocusChanged` all fire, including for Tab Group and profile switches? What ids change on a Tab Group switch? | MRU correctness |
| S9 | Is `storage.session` available and does state survive a background restart? How long until the idle background is stopped? | persistence |
| S10 | Do module service workers load (`type: module`)? If not, which background form works (`scripts` + `persistent: false`)? | background entry |
| S11 | What do `tab.incognito` / private windows report, and does the extension run there by default? | F6 |

## Deliverables

- Green build, committed scaffold, probes removed again (stubs restored) in a final commit.
- `plans/SPIKE-RESULTS.md`: one section per question — answer, evidence, and a recommended change to `00-overview.md` if any. Mark anything the user could not test as **unverified**; do not guess.
