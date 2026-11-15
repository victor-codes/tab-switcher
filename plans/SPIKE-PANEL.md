# Phase 0 spike results: native switcher panel

Date: 2026-11-15. Plan: `plans/06-native-panel.md`.
Spike code: branch `spike/native-panel` (worktree `.claude/worktrees/spike-panel`),
uncommitted, never to be merged. Built from `main` at `fb16c4b`, Debug, Apple Development
signing (team `4V436AF4L4`), installed over the user's 1.0.1 for the test, then 1.0.1 was
restored from a zip backup. No build is left on disk.

**Verdict: go.** Every question has a working answer. Phase 1 may start, using the
`CFMessagePort` transport.

## What the spike did

- **App:** ⌃Tab showed a borderless, non-activating `NSPanel` (8 placeholder cards, SwiftUI,
  `NSVisualEffectView` background) instead of sending `flip`. Further presses moved the
  selection, releasing ⌃ hid it, and nothing switched tabs. Esc (with the held modifiers, with
  and without Shift) was claimed as a hot key only while the panel showed. The app listened on a
  `CFMessagePort` and logged every message it received, with its size and latency.
- **Extension handler:** a new `spike:push` request was forwarded byte for byte to that port
  with `CFMessagePortCreateRemote` + `CFMessagePortSendRequest` (1 s send timeout, no reply).
- **Background:** at start, pushed test messages of 1 KB, 100 KB, 400 KB, 1 MB, 4 MB and
  8 MB, then 300 KB on each tab activation, logging the reply.

All numbers below come from the system log (`subsystem == "com.example.tabflip"`,
categories `spike` and `extension`). Visual results come from the user.

## 1. Transport: `CFMessagePort` from the sandboxed appex to the sandboxed app

**Works, no sandbox change needed.** Port name = App Group + `.panel`
(`4V436AF4L4.tabflip.panel`). Both targets already have the App Group entitlement, and the
sandbox allows a port named under it. No denial in the log.

| Payload | Delivered | App receipt latency (from `sendNativeMessage` call) | Handler time | Extension round trip |
|---|---|---|---|---|
| 1 KB | yes | 2.7 ms | 0.6 ms | 6 ms |
| 100 KB | yes | 3.5 ms | 0.7 ms | 4 ms |
| 400 KB | yes | 6.4 ms | 1.2 ms | 7 ms |
| 1 MB | yes | 14.0 ms | 1.8 ms | 15 ms |
| 4 MB | yes | 26.5 ms | 6.7 ms | 26 ms |
| 8 MB | yes | 50.0 ms | 12.5 ms | 50 ms |

- **Size limit:** none hit up to 8 MB. A full snapshot (8 items, previews ~20–40 KB each) is
  well under 1 MB.
- **App not running:** `CFMessagePortCreateRemote` returns nil and the handler replies
  `status: -1` at once (seen in the first run, before the app was listening). The extension
  can treat that as "nobody to draw" and carry on.
- **The file + Darwin notification fallback is not needed.**

Observations for Phase 1A:

- Only one background instance (`xvns`) pushed in the successful run. The second background
  (the one that sees 0 tabs) did not show up in the log at all. Keep snapshot rules 1–4
  anyway: this is one observation, not proof.
- The 300 KB push on tab activation was never logged, although the background was alive (its
  start-up pushes and focus-time `settings:get` calls ran). Either no tab switch happened in
  that background while it was awake, or the user's clicks only woke it. Not explained. Phase 1A must
  confirm in the log that a tab switch produces one snapshot push.

## 2. A non-activating panel over Safari

**Works everywhere tested** (user-confirmed by eye, focus state from the log):

| Where | Panel shown | User |
|---|---|---|
| Normal page, normal window | yes | confirmed |
| Full-screen Safari | yes | confirmed |
| Screen Time limit screen | **yes** | confirmed |
| Start Page | yes (the in-page switcher never could) | confirmed |
| Error pages (invalid URL, site down, localhost not running) | yes (the in-page switcher never could) | confirmed |

On all 10 shows logged: `appActive=false`, `panelKey=false`, `frontmost=com.apple.Safari`,
`onActiveSpace=true`. The hot keys kept arriving while the panel showed (every press after
the first logged `move`), so the panel neither takes focus nor releases the shortcuts.

**Dock icon:** showing the panel never changed the activation policy. It was `0` (regular)
while the app's window was open after a manual launch and `1` (accessory) after the window
closed, and the panel showed the same in both.

Panel settings that worked: `styleMask [.borderless, .nonactivatingPanel]`,
`isFloatingPanel = true`, `level = .popUpMenu`,
`collectionBehavior [.canJoinAllSpaces, .fullScreenAuxiliary, .transient, .ignoresCycle]`,
`hidesOnDeactivate = false`, `becomesKeyOnlyIfNeeded = true`, clear background,
`hasShadow = true`, `animationBehavior = .none`, shown with `orderFrontRegardless()`.

## 3. Safari's window bounds from the sandbox

**Works, no permission prompt.** `CGWindowListCopyWindowInfo([.optionOnScreenOnly,
.excludeDesktopElements], kCGNullWindowID)` filtered to Safari's pid and layer 0 returned the
front window's bounds on every press (`boundsFound=true`, 1291×949). Window titles are not
returned (`namesVisible=false`), which is as expected without Screen Recording and is fine:
the panel only needs bounds. CG coordinates are top-left on the primary screen; convert with
`y = primaryScreenHeight - (cgY + height)`. The first matching window larger than 200×200
in the list is the front one. In full screen the list held one Safari window instead of two.

The fallback (centre on the screen with the mouse) was never needed.

## 4. Clicks without activating the app

**Works.** Clicking card 8 logged `click card=7 appActive=false panelKey=false
frontmost=com.apple.Safari`, and the panel hid. Needed: the `NSHostingView` subclass
overrides `acceptsFirstMouse(for:) -> true`; a SwiftUI `onTapGesture` on the card then fires
on the first click.

## 5. Hot key to panel on screen

Measured from the start of the hot key handler with `mach_absolute_time`:

| | First show after launch | Next 9 shows |
|---|---|---|
| `orderFrontRegardless` returned | 11.8 ms | 2.6–5.7 ms |
| after `CATransaction.flush()` | 21.3 ms | 4.3–8.7 ms |
| first display-link frame | 25.8 ms | **6.6–14.1 ms** |
| move selection (later presses) | — | 0.11–0.24 ms |

Target ≤ 16 ms: met after the first show. The first show of the process is slower (cold
SwiftUI and window server path). Phase 1B should warm the panel once at launch, off screen
or at zero alpha, so the first real press is not the cold one. The spike's window-list call
was 1–4 ms of each show and can run on the press path as is.

## Changes to the plan

- Transport: `CFMessagePort`, port name `<App Group>.panel`. Drop the file fallback.
- Remove every **(verify)** in `06-native-panel.md`; replaced with the answers above.
- Phase 1B: warm the panel at launch (see 5), use the panel settings listed in 2 and
  `acceptsFirstMouse` from 4.
- Phase 1A: confirm a push per tab switch in the log (see 1).
