# TabFlip spike results (Phase 0)

Status: **pending**. The probes are built and committed, but nobody has run them in Safari yet. Nothing below is an answer. Do not release Phase 1 on the basis of this file until every section is filled in or explicitly marked **unverified**.

How to fill this in: run the checklist in the Agent 0 report, press "Copy results" on the probe page, and map the pasted JSON to the sections using the "Where to look" line of each section.

Environment the probes were built on: macOS 27.2, Safari 27.2, Xcode 26.2 (17C52).

## Observations from tooling (not Safari runtime evidence)

- `xcrun safari-web-extension-converter` printed, for the scaffold manifest: "The following keys in your manifest.json are not supported by your current version of Safari ... `type`". The only `type` key in the manifest is `background.type = "module"`. This is a converter warning only; whether Safari actually loads the module service worker is S10 and is still pending.
- The converter printed the same single warning (and nothing about `commands`) with the extra `probe-ctrl-tab` command (`MacCtrl+Tab`) present. That does not show Safari accepts the shortcut; see S2.
- `xcodebuild ... -configuration Debug build` succeeds with and without the probe command. A green build does not validate the manifest against Safari.

## S1 — pending

Question: Does the `flip` command fire with `MacCtrl+Q`? Also from the Start Page and while a text field has focus?

- Answer: pending
- Evidence: pending
- Where to look: `spike.S1.fires`, `spike.optionsPage.closeAndReturnCommand`, notes S1
- Recommended change to `00-overview.md`: pending

## S2 — pending

Question: Does a command declared as `MacCtrl+Tab` fire, or does Safari keep Control-Tab? Does a content-script `keydown` for Control-Tab arrive, and can `preventDefault()` stop Safari's own switch?

- Answer: pending
- Evidence: pending
- Where to look: `spike.S2` (`commandDeclared`, `commandFires`, `keydowns[].prevented/safariSwitchedTab`), notes S2
- Recommended change to `00-overview.md`: pending

## S3 — pending

Question: Can the user rebind extension shortcuts anywhere in Safari Settings?

- Answer: pending
- Evidence: pending
- Where to look: `optionsContext.commands`, `spike.env.apis` (`commands.update`), notes S3 (human observation)
- Recommended change to `00-overview.md`: pending

## S4 — pending

Question: Does the content script receive `keyup` for Control after a command fired? Is `event.getModifierState` reliable at message time?

- Answer: pending
- Evidence: pending
- Where to look: `spike.S4.samples` (`atMessageTime`, `ctrlKeyupSeen`, `eventsAfterMessage[].getModifierStateControl`)
- Recommended change to `00-overview.md`: pending

## S5 — pending

Question: Round-trip latency of `tabs.sendMessage` + ack on a normal page (median of 20). Is the 150 ms ack timeout sane?

- Answer: pending
- Evidence: pending
- Where to look: `spike.S5.runs` (`medianMs`, `samplesMs`), `spike.S1.fires[].ack.firstMessageMs`, `spike.S5.replyStyles`
- Recommended change to `00-overview.md`: pending

## S6 — pending

Question: Does `tabs.captureVisibleTab` work from the background without a user gesture, with these permissions? Size and time of one capture. Are `OffscreenCanvas` (2D) and `createImageBitmap` available in the background?

- Answer: pending
- Evidence: pending
- Where to look: `spike.S6.captures` (trigger, `captureMs`, `approxBytes`, `downscale`), `spike.env.hasOffscreenCanvas`, `spike.env.hasCreateImageBitmap`
- Recommended change to `00-overview.md`: pending

## S7 — pending

Question: Is `tab.favIconUrl` populated?

- Answer: pending
- Evidence: pending
- Where to look: `spike.S7.latest`, `spike.S7.pageIconLinks`
- Recommended change to `00-overview.md`: pending

## S8 — pending

Question: Do `tabs.onActivated`, `onRemoved`, `onAttached`, `onDetached`, `onReplaced`, `windows.onFocusChanged` all fire, including for Tab Group and profile switches? What ids change on a Tab Group switch?

- Answer: pending
- Evidence: pending
- Where to look: `spike.counts`, `spike.events` (incl. `MARK` entries), `spike.snapshots[].diffFromPrevious`, notes S8
- Recommended change to `00-overview.md`: pending

## S9 — pending

Question: Is `storage.session` available and does state survive a background restart? How long until the idle background is stopped?

- Answer: pending
- Evidence: pending
- Where to look: `spike.S9`, `spike.boots` (`previous.livedMs`, `previous.idleBeforeStopMs`, `sessionSurvived`), notes S9
- Recommended change to `00-overview.md`: pending

## S10 — pending

Question: Do module service workers load (`type: module`)? If not, which background form works?

- Answer: pending
- Evidence: pending
- Where to look: `optionsContext.bgPing`, `spike.env` (`globalScope`, `staticImportWorked`, `manifestBackground`), notes S10
- Recommended change to `00-overview.md`: pending

## S11 — pending

Question: What do `tab.incognito` / private windows report, and does the extension run there by default?

- Answer: pending
- Evidence: pending
- Where to look: `spike.S11`, `spike.snapshots[].windows[].incognito`, `spike.S1.fires[].tab.incognito`, notes S11
- Recommended change to `00-overview.md`: pending

## If the extension does not load at all

Not yet needed; recorded here so the fallback order is fixed before anyone improvises.

1. Revert only the commit "Add temporary probe command for Control-Tab (spike S2)", rebuild, re-enable. If it loads now, S2's command half is answered: Safari rejects the manifest because of `MacCtrl+Tab`.
2. If it still does not load, change `background` in `extension/manifest.json` to `{ "scripts": ["background.js"], "type": "module", "persistent": false }`, rebuild, re-enable. Record which form worked under S10.
3. Record the exact error text Safari shows under Settings > Extensions > TabFlip.
