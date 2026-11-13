# TabFlip

A Safari extension for macOS that switches tabs in most-recently-used order.

- **Flip back:** press **⌃Q** (Control-Q) to go to the tab you used before this one. Press it again to come back.
- **Browse recent tabs:** hold **⌃** and keep tapping **Q**. A switcher on the page walks down your recent tabs; let go of Control to switch, or press Esc to stay put.
- **Close and return:** **⌃W** closes the current tab and takes you to the tab you used before it, not the one next to it.
- Recent-tab order is kept per window. The shortcut acts on the window in front.

Requires macOS 14 or later and Safari 17 or later.

## Build and run

1. Open `TabFlip.xcodeproj` in Xcode 15 or later, or build from the command line:

   ```sh
   xcodebuild -project TabFlip.xcodeproj -scheme TabFlip -configuration Debug build
   ```

   The app is signed ad hoc (no developer team), so no Apple account is needed.
2. Run the **TabFlip** scheme from Xcode, or open the built `TabFlip.app` (Xcode shows its location under Product › Show Build Folder in Finder). The app shows whether the extension is on and has a button that opens Safari's extension settings.

### Allowing an unsigned extension (local development)

Safari only loads ad-hoc-signed extensions when unsigned extensions are allowed. This setting resets when Safari quits.

1. In Safari, open Settings › Advanced and turn on **Show features for web developers**.
2. In Settings › Developer, turn on **Allow unsigned extensions** (Safari asks for your password).
3. Open the TabFlip app once so Safari registers the extension, then turn it on in Settings › Extensions.

## Setting it up

1. **Turn on TabFlip** in Safari Settings › Extensions.
2. **Allow it on all websites.** Next to TabFlip, choose Edit Websites… and set Other Websites to Allow. The switcher draws on the page and needs to see when you release Control.
3. **Try it:** on any web page, tap ⌃Q.

Once the extension is on you can quit the app. Safari runs the extension by itself; the app has no login item, menu bar item or background process.

## Shortcuts

| Shortcut | Action |
|---|---|
| ⌃Q | Flip to the previous tab. Hold ⌃ and tap Q again to browse recent tabs. |
| ⌃W | Close the current tab and return to the previous one. |

These are the defaults. Extensions cannot change their own shortcuts in Safari. TabFlip's settings page (Safari Settings › Extensions › TabFlip › Settings) lists the shortcuts Safari currently reports. Control-Tab cannot be used: Safari does not let extensions claim it.

## Settings

- **Show the switcher on the page** (on by default). When off, each tap switches straight away without drawing anything.
- **Show page previews** (on by default). When off, TabFlip stops taking previews and deletes the ones it stored.
- **Tabs shown in the switcher:** 4 to 12 (default 8).
- **Clear stored previews and history** deletes previews, site icons and recent-tab history.

## Permissions and why

| Permission | Why |
|---|---|
| `tabs` | Read tab titles, addresses and the active tab to keep the recent-tab order and switch tabs. |
| `storage` | Keep the recent-tab order, previews and your settings in Safari's extension storage on this Mac. |
| `activeTab` | Take a small preview of the tab you are looking at. |
| Access to all websites | Draw the switcher on the page and notice when you release Control. Without it, TabFlip falls back to quick-flip mode (below). |

## Privacy

Nothing leaves your Mac. TabFlip makes no network requests and has no analytics; the container app cannot make network connections at all. Recent-tab order, site icons and previews live only in Safari's extension storage on this Mac, and nothing is captured or stored for private windows.

## Known limits

- **Quick-flip mode.** Where the switcher cannot appear, each tap of ⌃Q switches straight away, and a pause of about a second ends the sequence. This happens on the Start Page, Safari's own pages, PDFs, sites TabFlip has not been allowed on, and whenever the page itself does not have keyboard focus (for example while you are typing in the address bar).
- Tabs are switched only within the front window.
- macOS only; no iPhone or iPad version.

## Project layout

```
extension/          Web extension (manifest, background, content script, options page, icons)
TabFlip/            Container app (SwiftUI onboarding window)
TabFlip Extension/  Safari web extension target (generated handler)
tests/              node:test unit tests  (run: node --test tests/)
tools/              Developer tools, not shipped (make-icons.swift regenerates all icons)
```
