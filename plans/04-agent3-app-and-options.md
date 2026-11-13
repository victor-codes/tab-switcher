# Agent 3 — container app, options page, icons, README (Phase 1)

Read `00-overview.md` and `SPIKE-RESULTS.md` first. You own `TabFlip/` (Swift sources and assets of the app target), `extension/options/`, `extension/images/`, `README.md`, and may add keys to `extension/_locales/en/messages.json`. Do not edit `TabFlip.xcodeproj` by hand or the generated extension handler; if a new Swift file must be added to the target and the project does not use synchronized folders, say so in your report.

## Container app (SwiftUI, single window)

Replace the converter's default WebView screen with a native onboarding window:

- Live extension status via `SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier:)` — "Enabled" / "Not enabled", refreshed when the app becomes active.
- Button "Open Safari Extension Settings" → `SFSafariApplication.showPreferencesForExtension(withIdentifier:)`.
- Three short steps: enable the extension; allow it on all websites (explain why in one sentence: the switcher draws on the page and needs to see when you release the key); try the shortcut.
- A shortcuts card showing both commands with key-cap styling.
- A privacy line: nothing leaves this Mac.
- Fixed-size window, no document model, quits when the window closes. Light and dark.

## Options page (`extension/options/`)

- Controls bound to `storage.local` `settings` (schema and defaults in the overview): show switcher overlay, show previews, number of tabs shown (4–12).
- Shortcut section: read `browser.commands.getAll()` and display the active bindings; explain how to change them according to spike result S3 (or state plainly that Safari does not offer rebinding, if so).
- "Clear stored previews and history" button → sends `{ type: "data:clear" }` to the background. (New message; the orchestrator adds it to the contract and Agent 4 implements the handler. Until then the button may fail gracefully.)
- Plain HTML/CSS/JS, system fonts, light/dark, keyboard accessible, labels wired to inputs.

## Icons and README

- App icon and extension icons (16–1024 as required by both targets) from one original vector design: simple, legible at 16 px, not derived from any existing product's mark. Toolbar icon not needed (no `action`).
- `README.md`: what it does, build and run steps, enabling unsigned extensions for local development, shortcuts, permissions and why, privacy statement, known limits (pages where the overlay cannot appear use quick-flip mode).

## Done when

The Xcode build is green, the app launches and shows correct status (verify by launching the built app and screenshotting the window), the options page works in the harness of your choice, and your report lists a manual checklist for the options page inside Safari.
