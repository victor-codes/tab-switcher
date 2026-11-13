# TabFlip

A Safari extension for macOS that switches tabs in most-recently-used order.

- **Flip back:** press **⌃Tab** to go to the tab you used before this one. Press it again to come back.
- **Browse recent tabs:** hold **⌃** and keep tapping **Tab**. A switcher on the page walks down your recent tabs; **⌃⇧Tab** walks back up. Let go of Control to switch, or press Esc to stay put.
- The shortcuts work anywhere in Safari, including the address bar and the Start Page.
- Recent-tab order is kept per window. The shortcut acts on the window in front.

Requires macOS 14 or later and Safari 17 or later.

## Build and run

1. Open `TabFlip.xcodeproj` in Xcode 15 or later, or build from the command line:

   ```sh
   xcodebuild -project TabFlip.xcodeproj -scheme TabFlip -configuration Debug build
   ```

   The project is signed with a free Apple ID "Personal Team" (`DEVELOPMENT_TEAM` in the project). A team is required: the app and the extension share settings through an App Group (`$(TeamIdentifierPrefix)tabflip`), and Xcode will not build App Group entitlements without one. To use your own team, change the team in Signing & Capabilities for both targets. Shipping to other people (App Store or notarized download) needs a paid Apple Developer Program membership.
2. Run the **TabFlip** scheme from Xcode, or open the built `TabFlip.app` (Xcode shows its location under Product › Show Build Folder in Finder). The app is where TabFlip is set up and configured.

### Allowing an unsigned extension (local development)

Safari may only load locally built extensions when unsigned extensions are allowed. This setting resets when Safari quits.

1. In Safari, open Settings › Advanced and turn on **Show features for web developers**.
2. In Settings › Developer, turn on **Allow unsigned extensions** (Safari asks for your password).
3. Open the TabFlip app once so Safari registers the extension, then turn it on in Settings › Extensions.

## Setting it up

1. **Turn on TabFlip** in Safari Settings › Extensions.
2. **Allow it on all websites.** Next to TabFlip, choose Edit Websites… and set Other Websites to Allow. The switcher draws on the page and needs to see when you release Control.
3. **Try it:** press ⌃Tab in Safari.

When you're done, close the window. TabFlip keeps running so the shortcuts work: with the window closed it has no Dock or menu bar icon, and it opens at login (it registers itself as a login item; turn that off in System Settings › General › Login Items). ⌘Q closes the window too; **Quit TabFlip Completely** (⌥⌘Q) stops it. Opening TabFlip again brings the window back.

## Shortcuts

| Shortcut | Action |
|---|---|
| ⌃Tab | Flip to the previous tab. Hold ⌃ and keep tapping Tab to browse recent tabs. |
| ⌃⇧Tab | Browse the other way (starts at the oldest tab shown). |

**⌃Tab and ⌃⇧Tab can be changed** in the TabFlip app, under Keyboard Shortcuts: click a shortcut and press the new keys. Each needs Control, Option or Command, and both need to share the modifier you hold while browsing.

How they work: Safari does not let an extension take Control-Tab, and a web page only sees keys while it has focus. So the TabFlip app (`TabFlip/ShortcutAgent.swift`) claims the two shortcuts with the system hot key API (`RegisterEventHotKey`), only while Safari is the frontmost app; in every other app ⌃Tab works as usual. Each press goes to the extension with `SFSafariApplication.dispatchMessage`, which the background receives on a port opened with `browser.runtime.connectNative`. It also watches for the held modifier being let go, so the switcher commits even when the page doesn't have focus. This needs no Accessibility permission and works in the App Sandbox. It has to be the app itself: Safari refuses these messages from any other process, including a helper app embedded in it.

If TabFlip isn't running, the content script still catches the shortcuts while a page has keyboard focus.

## Settings

All settings are in the TabFlip app; the extension has no settings page of its own. The app saves each change at once to a shared App Group. The extension's native handler (`TabFlip Extension/SafariWebExtensionHandler.swift`) returns them to the extension (`extension/core/appsync.js`), which applies them whenever its background starts or a Safari window becomes active, so a change shows up as soon as you switch back to Safari.

- **Show the switcher** (on by default). When off, each tap switches straight away without drawing anything.
- **Show page previews** (on by default). When off, TabFlip stops taking previews and deletes the ones it stored.
- **Tabs shown in the switcher:** 4 to 12 (default 8).
- **Keyboard shortcuts:** the next and previous shortcuts (default ⌃Tab and ⌃⇧Tab).
- **Clear…** under Stored Data deletes previews, site icons and recent-tab history. The extension does it the next time Safari becomes active.

## Permissions and why

| Permission | Why |
|---|---|
| `tabs` | Read tab titles, addresses and the active tab to keep the recent-tab order and switch tabs. |
| `storage` | Keep the recent-tab order, previews and your settings in Safari's extension storage on this Mac. |
| `activeTab` | Take a small preview of the tab you are looking at. |
| `nativeMessaging` | Read the settings you chose in the TabFlip app, and receive shortcut presses from the app (both on this Mac). |
| Access to all websites | Draw the switcher on the page and notice when you release Control. Without it, TabFlip falls back to quick-flip mode (below). |

## Privacy

Nothing leaves your Mac. TabFlip makes no network requests and has no analytics; the container app cannot make network connections at all. Recent-tab order, site icons and previews live only in Safari's extension storage on this Mac, and nothing is captured or stored for private windows.

## Known limits

- **Quick-flip mode.** Where the switcher cannot appear, each tap switches straight away, and letting go of Control ends the sequence. This happens on the Start Page, Safari's own pages, PDFs, sites TabFlip has not been allowed on, and whenever the page itself does not have keyboard focus (for example while you are typing in the address bar).
- Tabs are switched only within the front window.
- macOS only; no iPhone or iPad version.

## Project layout

```
extension/          Web extension (manifest, background, content script, icons)
TabFlip/            The app: setup and all settings (SwiftUI)
TabFlip Extension/  Safari web extension target (handler that serves the app's settings)
tests/              node:test unit tests  (run: node --test tests/)
tools/              Developer tools, not shipped (make-icons.swift regenerates all icons)
```
