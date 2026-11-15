# 06 — Native switcher panel

Status: plan only. Nothing here is built. Revised 2026-11-15 after the open-tabs fix
(`aac505d`) and the rename to Tab Switcher (`e11c2f4`), both on `main`.

Items marked **(verify)** are assumptions that only the Phase 0 spike may settle. Until
`plans/SPIKE-PANEL.md` exists and answers them, Phase 1 must not start.

## Read this first (every agent)

### Start from the right place

- Branch from `main` at `e11c2f4` or later. Check with `git log --oneline -5`: you must see
  "Rename TabFlip to Tab Switcher throughout the project". If you do not, stop and say so.
- The project is `TabSwitcher.xcodeproj`, scheme `TabSwitcher`, targets `TabSwitcher` and
  `TabSwitcher Extension`, folders `TabSwitcher/` and `TabSwitcher Extension/`. If you see
  a `TabFlip/` folder or `TabFlip.xcodeproj`, you are on an old commit: stop.
- `tools/release.sh` may have uncommitted edits by the user, and `site/` is the user's
  untracked folder. Do not edit, commit, stash or delete either.

### Names that must NOT change

These still say `tabflip` on purpose. Changing any of them breaks existing installs (Safari
permission, saved settings, login item):

- bundle identifiers `com.example.tabflip` and `com.example.tabflip.Extension`
- App Group `$(TeamIdentifierPrefix)tabflip` (Info.plist key `TabSwitcherAppGroup`)
- log subsystem `com.example.tabflip`

### Commands

```
node --test tests/                     # all JS tests; must end with "# fail 0"
xcodebuild -project TabSwitcher.xcodeproj -scheme TabSwitcher -configuration Debug \
  -derivedDataPath "$DD" build -quiet  # $DD = a folder OUTSIDE the repo, see below
```

### Builds: clean up, every time

A built `Tab Switcher.app` left anywhere on disk is registered by macOS, and Safari then
loads it as a second copy of the extension next to the user's installed one. This has
already caused confusing failures. So:

1. Build only into a derived-data folder outside the repo (`-derivedDataPath`).
2. As soon as you have what you need from the build, unregister and delete it:

```
LSR=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
"$LSR" -u "$DD/Build/Products/Debug/Tab Switcher.app"
rm -rf "$DD"
```

3. Never copy a build into `/Applications`, never launch it, never `pkill` the user's
   running "Tab Switcher". Installing is done by the user or the integration agent only.

### What you cannot do

- You cannot press keys in Safari or see its window. "Done" for your task is the listed
  tests and log lines, never "it works in Safari". Say plainly which checks need the user.
- Do not decide the items under "Open decisions". If your task depends on one that is still
  open, use the stated default and write that you did so in your final report.
- Commits: no co-author line, no Claude attribution.

### Facts about the code as it is now

- **Two extension backgrounds.** Safari runs two copies of `extension/background.js` at
  once. One of them sees 0 tabs. Both receive every message the app sends. Anything the
  app receives from the extension may therefore arrive twice, once with real data and once
  empty. See "Snapshot rules" below.
- **The background is unloaded after about 30 s idle.** In-memory variables are lost;
  state lives in `browser.storage.session` (`core/store.js`).
- **Diagnostics channel.** `diag(what, data)` in `background.js` sends
  `{ type: "log", what, data }` through `browser.runtime.sendNativeMessage`; the handler
  (`TabSwitcher Extension/SafariWebExtensionHandler.swift`) writes it to the system log.
  Read it with:
  `/usr/bin/log show --last 10m --info --predicate 'subsystem == "com.example.tabflip"' --style compact`
  (call `/usr/bin/log` by full path; zsh has its own `log`). Log event names, counts and
  timings only. Never log titles, hosts or URLs.
- **In-page delivery.** `perform()` in `background.js` shows the in-page switcher with
  `sendWithTimeout`, and falls back to `execDeliver` / `injectSwitcher` for pages whose
  messaging is dead. `healOpenTabs()` runs at load. Do not change this path; the panel is
  an addition next to it.
- **App → extension.** `ShortcutAgent.send(name, userInfo)` calls
  `SFSafariApplication.dispatchMessage`; the background receives it in `onAppMessage`
  (today: `flip` with `{ dir }`, and `release`).
- **Extension → app.** Today only `settings:get` and `log`, both answered by the handler.
  There is no path yet from the handler to the running app; Phase 0 picks one.

## Goal

Draw the switcher in a window owned by the Tab Switcher app instead of inside the web
page, so it appears wherever Safari is in front, including places a page overlay cannot
reach:

- the Screen Time limit screen (Safari draws it over the page) **(verify)**
- the Start Page, empty tabs, PDFs, error pages
- sites the extension has no access to
- pages that are still loading or have no keyboard focus

It must look the same as the in-page switcher and appear on the first press with no
delay and no entry animation.

How the app runs does not change: background only, no Dock icon, starts at login, ⌘Q
closes the window only. No new permission prompt (no Accessibility, no Screen Recording).

## Non-goals

- Replacing the in-page switcher. It stays as the fallback when the app is not running
  or the panel cannot be shown.
- Cross-window switching, search, iOS.

## Design

### Who owns what

| | Today | With the panel |
|---|---|---|
| Key presses, release | app (`ShortcutAgent`, `ReleaseWatch`) | app (unchanged) |
| Recent-tab order, previews, icons | extension background | extension background (unchanged) |
| Gesture state (which card is selected) | extension (`core/session.js`) | **app**, while the panel is in use |
| Drawing | page (`content/switcher.js`) | **app** (`NSPanel` + SwiftUI) |
| Switching the tab | extension | extension, on the app's request |

### Push, don't ask

Asking the extension for the tab list at press time costs a round trip through the
extension process, and fails if the background is asleep. Instead the extension pushes a
**snapshot** to the app whenever something the switcher shows changes, and the app keeps
the latest one in memory. A press then shows the panel from memory immediately.

Snapshot, one per Safari window:

```
{ v: 1,
  instance: string,     // INSTANCE in background.js: which background copy sent it
  seq: number,          // increases by 1 per push from that instance
  windowId: number,
  focused: boolean,     // is this Safari's focused window
  private: boolean,
  items: [ { tabId: number, title: string, host: string,
             icon: string|null,       // data:image URL, at most 8192 chars
             preview: string|null } ] // data:image URL
}                                     // items in MRU order, at most settings.maxItems
```

Pushed on: tab activated / created / removed / moved between windows, title or URL
change of a listed tab (at most one push per 250 ms per window), new preview stored,
window focus change, settings change, background start.

### Snapshot rules (because there are two backgrounds)

Extension side:

1. Never push a snapshot with `items.length === 0`. A background that sees no tabs stays
   silent.
2. Never push twice in a row with identical content for a window (compare everything
   except `seq`).

App side (`SnapshotStore`):

3. Drop any snapshot with no items.
4. Keep one snapshot per `windowId`. Replace it when the new one has a different
   `instance`, or the same `instance` and a higher `seq`. Otherwise drop it.
5. The "current" snapshot is the one with `focused: true` received most recently.
6. Forget all snapshots when Safari quits, on "Clear…", and when the panel setting is
   turned off.

### Transport

- **Extension → app (snapshots):** `browser.runtime.sendNativeMessage` with
  `{ type: "snapshot:push", snapshot }` reaches `SafariWebExtensionHandler`, which forwards
  the bytes to the app over a `CFMessagePort` named with the App Group prefix. In memory
  only, nothing written to disk. **(verify: allowed in the sandbox for both targets; size
  limit comfortably above ~400 KB; latency)**
  Fallback if that fails: write the snapshot to a file in the App Group container and
  post a Darwin notification; the app reads and deletes it.
  Phase 0 chooses one and records it in `plans/SPIKE-PANEL.md`. Phase 1 uses that one only.
- **App → extension (commands):** the existing `dispatchMessage` path, with one new
  message: `activate` with `{ windowId, tabId }`. Both backgrounds receive it; rule below.

### Gesture, app side

1. Press with a usable snapshot for the focused window → show the panel, select item 1
   (or the last item for the "previous" shortcut). No message to the extension.
2. Further presses move the selection, wrapping.
3. Release (`ReleaseWatch`) → hide the panel, send `activate`. If the selection is the
   current tab (item 0), send nothing.
4. Esc → hide, send nothing. Click on a card → hide, `activate` that tab.
5. Safari stops being frontmost, or 15 s pass → hide, send nothing.

Extension on `activate`: if the tab is not known to this background, or not in that
window, ignore it silently (this is what the empty background always does). Otherwise
`tabs.update(tabId, { active: true })` and promote it in the MRU exactly as a commit does
today.

**When there is no usable snapshot** (none yet, panel setting off, no focused window
snapshot) the app sends today's `flip` / `release` messages and the in-page switcher
handles it exactly as now. One gesture uses one path from press to release: decide at the
first press and do not switch mid-gesture.

### The panel

- `NSPanel`, borderless, `.nonactivatingPanel`, never key or main, so Safari stays the
  active app and the claimed shortcuts keep arriving.
- It must not bring back the Dock icon: do not change the activation policy when showing it.
- Level above normal windows; collection behaviour `canJoinAllSpaces` +
  `fullScreenAuxiliary` so it shows over full-screen Safari. **(verify)**
- Created once at launch and kept hidden; showing it is `orderFrontRegardless()` with
  content already laid out. Decoded images are cached per `tabId`.
- Centred on the focused Safari window. Its frame comes from `CGWindowListCopyWindowInfo`
  (bounds need no permission). **(verify in the sandbox)** Fallback: centre on the screen
  that has the mouse.
- SwiftUI view matching the in-page design. Port the numbers, do not eyeball them: copy
  `columnsFor` and `cardWidthFor` from `extension/content/switcher.js` line for line into
  Swift, and take every size, radius, gap, font size and colour from the CSS in that file.
  Light and dark.
- Esc is claimed as a hot key only while the panel is visible. Arrow keys are **not**
  supported in the panel: Control-arrows belong to Mission Control by default.

### Privacy

- Snapshots live only in the app's memory.
- Private windows: titles and hosts are sent (needed to show anything), previews and icons
  never are, matching what the extension stores today.
- README wording ("everything stays on this Mac") stays true; add one line that the tab
  list is passed to the Tab Switcher app to draw the switcher.

### Setting

One new toggle in the app, on by default: **Show the switcher above Safari** (off = today's
in-page switcher only). Add it to `TabSwitcherSettings` in `TabSwitcher/Settings.swift` as
`panel: Bool`, default `true`, decoding a missing key as `true`. It must also reach the
extension through the existing `settings:get` reply so the background stops pushing
snapshots when it is off.

## Phases

| Phase | Who | Why |
|---|---|---|
| 0 Spike | strong model + the user | decides transport and whether the feature is possible |
| 1A Extension snapshots | lesser model | fully specified, unit-testable |
| 1B App panel | lesser model | fully specified against fixtures |
| 2 Integration and QA | strong model + the user | needs judgement and a real Safari |

All agents: own worktree, branch from `main`, follow "Read this first".

### Phase 0 — spike (blocks everything else)

Throwaway code on a branch that is never merged. Answer, with measurements, in
`plans/SPIKE-PANEL.md`:

1. Does the `CFMessagePort` path work from the sandboxed appex to the sandboxed app? Size
   limit? Time from `sendNativeMessage` to receipt in the app?
2. Does a non-activating panel show over Safari in a normal window, in full screen, and
   over the Screen Time limit screen, without taking focus, releasing the hot keys, or
   showing a Dock icon?
3. Does `CGWindowListCopyWindowInfo` return Safari's window bounds from the sandbox with
   no permission prompt?
4. Do clicks on the panel arrive without activating the app?
5. Time from hot key callback to panel on screen (target: ≤ 16 ms).

Needs the user for 2 (Screen Time and full screen) and 4. The spike build has to be
installed to test; restore the user's normal build afterwards and clean up as above.
If 1 fails, switch to the file transport. If 2 fails over Screen Time, stop and tell the
user: the main reason for the feature is gone, and they decide whether to continue.

After the spike, replace every **(verify)** in this file with the measured answer.

### Phase 1A — extension snapshots (lesser model)

Files you may edit: new `extension/core/snapshot.js`, new `tests/snapshot.test.js`,
`extension/background.js`, `tests/background.test.js`,
`TabSwitcher Extension/SafariWebExtensionHandler.swift`, `extension/core/appsync.js` and
`extension/core/store.js` (only to carry the `panel` setting). Nothing else.

Build:

- `buildSnapshot({ instance, seq, windowId, focused, private, order, tabsById, icons, previews, settings })`
  → snapshot object above, or `null` when there are no items. Pure, no browser calls.
  Private window → every `icon` and `preview` is `null`.
- `shouldPush(previous, next, now, lastPushAt)` → `true` / `false` implementing rules 1–2
  and the 250 ms throttle. Pure.
- Background: call them on the events listed under "Push, don't ask"; send with
  `sendNativeMessage({ type: "snapshot:push", snapshot })`; push nothing when
  `settings.panel === false`. Handle `activate` in `onAppMessage` as specified.
- Handler: forward `snapshot:push` to the app using the transport Phase 0 chose; keep
  `settings:get` and `log` working unchanged.

Done when all of these hold:

- `node --test tests/` ends with `# fail 0`, with new tests covering: empty tab list gives
  `null`; private window strips icon and preview; identical content is not pushed twice;
  throttle holds a second push inside 250 ms; `maxItems` is respected; `activate` for an
  unknown tab does nothing; `activate` for a known tab activates it and promotes it;
  `panel: false` pushes nothing.
- Existing tests are unchanged except for additions.
- The project builds (then clean up the build).
- Final report lists what was not verified in a real Safari.

### Phase 1B — app panel (lesser model)

Files you may edit: new `TabSwitcher/SwitcherPanel.swift`, `TabSwitcher/SwitcherView.swift`,
`TabSwitcher/SnapshotStore.swift`, `TabSwitcher/PanelSession.swift`; edits to
`TabSwitcher/ShortcutAgent.swift`, `TabSwitcher/Settings.swift`,
`TabSwitcher/ContentView.swift`, `TabSwitcher/TabSwitcherApp.swift`, and
`TabSwitcher.xcodeproj/project.pbxproj` only to add the new files. Nothing in `extension/`
or `TabSwitcher Extension/`.

Build:

- `SnapshotStore`: implements app-side rules 3–6. Input is decoded snapshot values, so it
  can be exercised without the transport.
- `PanelSession`: a pure value type. Inputs: `press(dir)`, `release`, `escape`,
  `click(index)`, `safariLostFocus`, `timeout`. Output: a list of effects from
  `show(items, selected)`, `select(index)`, `hide`, `activate(windowId, tabId)`,
  `forwardFlip(dir)`, `forwardRelease`. Required behaviour:

  | State | Input | Effects |
  |---|---|---|
  | idle, usable snapshot | press(+1) | show, selected = 1 (0 if only one item) |
  | idle, usable snapshot | press(−1) | show, selected = last |
  | idle, no usable snapshot or setting off | press(d) | forwardFlip(d); gesture is "forwarded" |
  | forwarded | press(d) / release | forwardFlip(d) / forwardRelease, back to idle on release |
  | shown | press(d) | select((selected + d) wrapped) |
  | shown | release, selected ≠ 0 | hide, activate(selected item) |
  | shown | release, selected = 0 | hide |
  | shown | escape, safariLostFocus, timeout | hide |
  | shown | click(i) | hide, activate(item i) |

- Panel, view and the setting as designed. Receiving real snapshots is wired in Phase 2;
  until then load a fixture (a JSON file with 1, 2, 8 and 30 items) behind a debug flag.

Done when all of these hold:

- A unit-test target or a small command-line check runs every row of the table above and
  rules 3–6, and passes. State in the report how to run it.
- With the setting off, `ShortcutAgent` sends exactly the messages it sends today
  (`flip`, `release`), in the same order.
- The project builds with no new warnings (then clean up the build).
- Final report lists what needs the user's eyes: look, position, full screen, focus.

### Phase 2 — integration and QA (strong model, after both merge)

- Wire real snapshots to the panel; verify the fallback rules and the two-background rules
  against the system log.
- Update `plans/00-overview.md`, README, and add a panel section to `plans/QA-RESULTS.md`.
- Install for the user (clean-up rules apply) and give them this checklist: normal page,
  Start Page, PDF, Screen Time screen, full screen, two windows, private window, app not
  running, panel setting off, quick tap, press immediately after a switch, Safari losing
  focus mid-gesture, a tab that was open before the update.

## Risks

| Risk | Mitigation |
|---|---|
| Sandbox blocks the message port | File + Darwin notification fallback (Phase 0 decides) |
| Empty background overwrites the real snapshot | Snapshot rules 1, 3 and 4 |
| Snapshot stale at press time | `activate` is validated by the extension; unknown tab is ignored |
| Panel and in-page switcher both react | App decides per gesture and sends either `activate` or `flip`, never both |
| An agent's build registers as a second extension | "Builds: clean up, every time" |
| Quick tap flashes the panel | See open decision 1 |
| Window bounds unavailable | Centre on the mouse's screen |
| Background asleep when `activate` arrives | Same exposure as today's `flip`; existing keep-alive covers it |

## Open decisions (the user's; agents use the default and report it)

1. Quick tap: show the panel for the instant the keys are down (consistent, may flash), or
   suppress it for taps under ~100 ms (no flash, but that is a display delay)?
   **Default until decided: show it at once.**
2. Should the panel replace the in-page switcher whenever the app runs, or only where the
   page cannot draw (two looks for one feature)?
   **Default until decided: replace it whenever the app runs and the setting is on.**
