# Plan 07: replace the placeholder identifiers

Status: in progress, 2026-11-16. Ships as 1.1.1.

## Why

`com.example.tabflip` is a placeholder. It came from the `--bundle-identifier` argument passed to
`safari-web-extension-converter` when the project was first set up (plan 01), and it still
carries the project's old name. The rename to Tab Switcher deliberately left it alone, to avoid
breaking existing installs. The only install is the maintainer's own, so that reason no longer
applies, and it gets more expensive with every user. `com.example` is reserved for examples and is
not unique to this project. The App Store does not accept it, and it shows in Homebrew's output
(`Quitting application 'com.example.tabflip'`).

## New identifiers

Prefix: **`xyz.ayovictor`**, the reversed form of the maintainer's domain `ayovictor.xyz`.
It must not change after this release, so keep the domain registered.

| What | Old | New |
|---|---|---|
| App bundle id | `com.example.tabflip` | `xyz.ayovictor.tabswitcher` |
| Extension bundle id | `com.example.tabflip.Extension` | `xyz.ayovictor.tabswitcher.Extension` |
| App Group | `$(TeamIdentifierPrefix)tabflip` | `$(TeamIdentifierPrefix)tabswitcher` |
| Log subsystem | `com.example.tabflip` | `xyz.ayovictor.tabswitcher` |
| Message port | `4V436AF4L4.tabflip.panel` | `4V436AF4L4.tabswitcher.panel` (derived from the App Group, no code change) |

Extension bundle ids must start with the app's id followed by a dot, and the table keeps that.

## Changes

One commit in `tabflip`, one in `homebrew-tap`.

**Xcode project and targets**
- `TabSwitcher.xcodeproj/project.pbxproj`: the 4 `PRODUCT_BUNDLE_IDENTIFIER` lines (Debug and
  Release, for each target).
- `TabSwitcher/TabSwitcher.entitlements`, `TabSwitcher Extension/TabSwitcher Extension.entitlements`:
  App Group string.
- `TabSwitcher/Info.plist`, `TabSwitcher Extension/Info.plist`: `TabSwitcherAppGroup` value.

**Swift**
- `TabSwitcher/TabSwitcherApp.swift:17`: `extensionBundleIdentifier`.
- Logger subsystem in `ShortcutAgent.swift:31`, `SwitcherPanel.swift:17`,
  `SafariWebExtensionHandler.swift:16`. Better: one shared constant per target, so the
  subsystem is written once in each.

**Extension JS**
- `extension/background.js:69`: the `log show` example in the comment.

**Docs**
- `README.md`, `plans/06-native-panel.md` (drop the "still say `tabflip` on purpose" block),
  and the `log show` lines in `plans/QA-RESULTS.md` and `plans/06-native-panel.md`.
- Older plans and spike reports (`01`, `SPIKE-PANEL.md`) are historical records: leave them alone.

**Homebrew cask** (`homebrew-tap/Casks/tab-switcher.rb`)
- `uninstall quit:` and the 3 `zap trash:` paths change to the new ids.
- Homebrew upgrades an installed cask using the uninstall steps saved from the version
  that was installed, so going from 1.1.0 to 1.1.1 still quits the old app correctly. No
  dual-id stanza is needed.

**Not changing**
- `DEVELOPMENT_TEAM 4V436AF4L4`, the product name "Tab Switcher", the repo and tap names.
- The folder name `tabflip/` on disk. That's a separate, optional clean-up and has no effect on
  users.

## Signing

New bundle ids and a new App Group mean new provisioning profiles. `tools/release.sh` runs
`xcodebuild` without `-allowProvisioningUpdates`, so the first build after the change must be done
once in Xcode (Product > Build, automatic signing) to register the new App IDs and App Group under
the team. After that the script builds as before.

## Steps

1. Make the edits; `grep -rn "com.example\|tabflip"` across the source (outside `plans/` history
   and the folder name) returns nothing.
2. Build once in Xcode to register signing; then `node --test tests/` and `tools/panel-check/run.sh`.
3. Remove the old copy from this Mac, so Safari does not list two extensions:
   `brew uninstall --zap --cask tab-switcher` (removes the app and the old containers, including
   saved settings and tab history), then confirm Safari > Settings > Extensions no longer lists
   Tab Switcher.
4. Install a local Release build, enable the extension in Safari, and smoke-test: in-page switcher,
   native panel (P1, P2, P14), settings window saves, and the log shows lines under the new
   subsystem.
5. Commit and push `main`; `tools/release.sh 1.1.1`, tag, GitHub release; update the cask with the
   new ids plus version and checksum, push the tap.
6. `brew install --cask tab-switcher` from the tap and confirm the installed app's id:
   `defaults read "/Applications/Tab Switcher.app/Contents/Info" CFBundleIdentifier`.

## Risks

- The maintainer's settings and tab history are lost on the switch (step 3). Accepted:
  nothing to migrate for one user.
- If the new App Group isn't registered, the app and extension can't share settings and
  the panel port fails silently. Step 2 covers this. Step 4 confirms by checking that a setting
  saved in the app takes effect in Safari.
