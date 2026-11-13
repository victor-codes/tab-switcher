# TabFlip QA results (Phase 2)

Status: **nothing run yet.** Agents cannot drive Safari; every cell below is `not run`. Fill in the Result column with `pass`, `fail (#n)` or `n/a`, and log each failure under "Failures" with steps and severity.

Shortcuts: `⌃Q` = flip (F1/F2), `⌃W` = close and return (F3). "Overlay" = the on-page switcher; "fallback" = no overlay, each tap switches at once and the session ends 1 s after the last tap.

Feature rows (from `00-overview.md`):

- **F1** Flip back: one tap goes to the previous tab of this window; a second tap returns.
- **F2** Browse recents: hold ⌃, tap Q repeatedly, release to switch; Esc cancels.
- **F3** Close and return: ⌃W closes the tab and activates the previous MRU tab, not the neighbour.
- **F4** Recognise the page: rows show title, host, icon (or letter glyph) and a preview (or the icon/glyph).
- **F5** Multi-window: MRU per window, the shortcut acts on the focused window only.
- **F6** Private: no network requests caused by TabFlip (check Web Inspector › Network on the page and on the extension's background), nothing stored for private windows.

How to check F6 on any page: open Develop › Web Extension Background Content › TabFlip and the page's Web Inspector; the Network tabs must show no request initiated by TabFlip (the page's own icon fetch by its own content script on load is expected and goes to that page's own icon URL). Storage: in the background inspector run `await browser.storage.session.get(null)`.

## Phase 2 feature checks (previews, icons, Clear data)

| # | Check | Expected | Result |
|---|---|---|---|
| P1 | Open 3 ordinary sites, view each ≥ 1 s, hold ⌃ and tap Q | Overlay cards show a thumbnail of each visited page (top of the page, 16:10) | not run |
| P2 | Background inspector: `Object.keys(await browser.storage.session.get(null))` | `state`, `previewIndex`, one `preview:<id>` per visited tab | not run |
| P3 | Hold ⌃Q on a tab visited < 0.6 s ago or still loading | That card shows the icon/glyph instead of a preview, no error | not run |
| P4 | Browse in overlay, release; wait 2 s; flip again | No thumbnail ever contains the overlay itself | not run |
| P5 | Close a tab with a preview | Its `preview:<id>` key is gone | not run |
| P6 | Options › turn "Show page previews" off | All `preview:*` keys and `previewIndex` gone at once; overlay shows icons/glyphs; no new keys appear while browsing | not run |
| P7 | Turn previews back on, browse | Previews come back after ~0.6 s per tab | not run |
| I1 | Overlay on site A listing site B | B's card shows B's icon; Network tab of A shows **no** request to B | not run |
| I2 | Site whose icon is on another host without CORS (or strict CSP `img-src`) | Letter glyph, no error | not run |
| I3 | `(await browser.storage.session.get("state")).state.icons` | Only `data:image/png;base64,…` values, each ≤ 8 KB | not run |
| C1 | Options › Clear stored previews and history… › Clear | Status "Cleared stored previews, icons and history." (green) | not run |
| C2 | After C1, background inspector storage | No `preview:*`, `icons` is `{}`, MRU re-seeded (active tab first, then tab-strip order) | not run |
| C3 | After C1, ⌃Q | Still works (goes to the next tab in tab-strip order) | not run |
| S1 | After install/update: `await browser.storage.local.get(null)` | Only `settings` (no `spike`, `spike_hb`, `spike_notes`, `spike_cfg`) | not run |

## Matrix

Expected results per condition. "As normal" = same as the *Normal site* row.

### Normal site (e.g. a news article, fully loaded)

| | Expected | Result |
|---|---|---|
| F1 | Tap ⌃Q: previous tab; tap again: back | not run |
| F2 | Overlay appears instantly while ⌃ held; Q moves selection; release switches; Esc cancels and stays | not run |
| F3 | ⌃W closes, previous MRU tab active (not the neighbour) | not run |
| F4 | Title, host, icon, preview on each card | not run |
| F5 | n/a (single window) | not run |
| F6 | No TabFlip network requests | not run |

### Strict-CSP site (e.g. github.com)

| | Expected | Result |
|---|---|---|
| F1 | As normal | not run |
| F2 | Overlay renders and is styled (constructed stylesheet is not blocked by CSP) | not run |
| F3 | As normal | not run |
| F4 | Previews shown; this site's own icon may be a glyph if CSP blocks the content script's icon load | not run |
| F5 | n/a | not run |
| F6 | No CSP violation reports caused by TabFlip beyond a blocked own-icon load; no other requests | not run |

### Start Page and empty tab (fallback)

| | Expected | Result |
|---|---|---|
| F1 | Tap switches at once (fallback) | not run |
| F2 | No overlay; each tap moves one tab further; 1 s after the last tap the session ends and that tab is MRU front | not run |
| F3 | As normal | not run |
| F4 | n/a here; other pages show this tab with glyph and no preview (no URL → no capture) | not run |
| F5 | n/a | not run |
| F6 | No preview stored for the empty tab | not run |

### PDF tab

| | Expected | Result |
|---|---|---|
| F1 | Fallback switch | not run |
| F2 | Fallback (no content script) | not run |
| F3 | As normal | not run |
| F4 | From other tabs: PDF card has a preview, glyph icon | not run |
| F5 | n/a | not run |
| F6 | No requests | not run |

### Site with extension access denied (Safari › Settings › Websites › TabFlip: Deny)

| | Expected | Result |
|---|---|---|
| F1 | Fallback switch | not run |
| F2 | Fallback, no overlay | not run |
| F3 | As normal | not run |
| F4 | Card: title/host; preview only if Safari allows capture there; glyph icon | not run |
| F5 | n/a | not run |
| F6 | No requests, no page:meta from that site | not run |

### Text field focused inside the page

| | Expected | Result |
|---|---|---|
| F1 | Switches; no "q" typed into the field | not run |
| F2 | Overlay works; no characters typed; release switches | not run |
| F3 | As normal; no "w" typed | not run |
| F4 | As normal | not run |
| F5 | n/a | not run |
| F6 | As normal | not run |

### Video in fullscreen

| | Expected | Result |
|---|---|---|
| F1 | Leaves fullscreen or switches; no crash, no stuck session | not run |
| F2 | Overlay may not show (fallback acceptable) | not run |
| F3 | As normal | not run |
| F4 | No preview captured of the fullscreen video while a session is active | not run |
| F5 | n/a | not run |
| F6 | As normal | not run |

### Two windows

| | Expected | Result |
|---|---|---|
| F1 | Acts on the focused window only | not run |
| F2 | Overlay lists only tabs of the focused window | not run |
| F3 | Returns to previous MRU tab of the same window | not run |
| F4 | As normal | not run |
| F5 | MRU of window A unaffected by switching in window B; switching windows mid-gesture ends the session | not run |
| F6 | As normal | not run |

### Tab dragged between windows

| | Expected | Result |
|---|---|---|
| F1 | Moved tab participates in the new window's MRU, gone from the old one | not run |
| F2 | Overlay of each window lists the right tabs | not run |
| F3 | As normal | not run |
| F4 | Moved tab keeps its preview and icon | not run |
| F5 | Per-window MRU stays correct | not run |
| F6 | As normal | not run |

### Tab Group switch

| | Expected | Result |
|---|---|---|
| F1 | No error; behaviour with tabs of the other group recorded here | not run |
| F2 | Overlay does not offer tabs that are not reachable (record actual) | not run |
| F3 | As normal within the group | not run |
| F4 | As normal | not run |
| F5 | As normal | not run |
| F6 | As normal | not run |

### Second profile

| | Expected | Result |
|---|---|---|
| F1 | Works in the profile where the extension is enabled | not run |
| F2 | As normal | not run |
| F3 | As normal | not run |
| F4 | As normal | not run |
| F5 | Profiles' MRU do not mix | not run |
| F6 | As normal | not run |

### Private window

| | Expected | Result |
|---|---|---|
| F1 | Works only if the user allowed TabFlip in private browsing; otherwise nothing happens | not run |
| F2 | Same | not run |
| F3 | Same | not run |
| F4 | No preview and no icon stored for private tabs (glyph, no thumbnail) | not run |
| F5 | As normal | not run |
| F6 | `storage.session` has no `preview:<id>` and no `icons` entry for any private tab | not run |

### Pinned tabs

| | Expected | Result |
|---|---|---|
| F1 | Pinned tabs take part in MRU like others | not run |
| F2 | Listed in the overlay | not run |
| F3 | Closing a pinned tab returns to previous MRU tab | not run |
| F4 | As normal | not run |
| F5 | As normal | not run |
| F6 | As normal | not run |

### 1 tab

| | Expected | Result |
|---|---|---|
| F1 | Nothing happens (no-op), no overlay | not run |
| F2 | Nothing happens | not run |
| F3 | Closes the tab (Safari's own behaviour for the last tab) | not run |
| F4 | n/a | not run |
| F5 | n/a | not run |
| F6 | As normal | not run |

### 2 tabs

| | Expected | Result |
|---|---|---|
| F1 | Toggles between the two | not run |
| F2 | Overlay with 2 cards; taps alternate | not run |
| F3 | Closes current, the other becomes active | not run |
| F4 | As normal | not run |
| F5 | n/a | not run |
| F6 | As normal | not run |

### 50+ tabs

| | Expected | Result |
|---|---|---|
| F1 | Instant | not run |
| F2 | Overlay shows `maxItems` (default 8) cards; appears without visible delay | not run |
| F3 | As normal | not run |
| F4 | Previews for the visited ones; at most 60 `preview:*` keys in storage | not run |
| F5 | As normal | not run |
| F6 | As normal | not run |

### After Safari relaunch

| | Expected | Result |
|---|---|---|
| F1 | Works; MRU re-seeded (active tab first, then tab-strip order) | not run |
| F2 | Works; restored but not yet loaded tabs show glyphs, no preview | not run |
| F3 | As normal | not run |
| F4 | All previews gone after relaunch (storage.session), come back as tabs are viewed | not run |
| F5 | As normal | not run |
| F6 | As normal | not run |

### After the background has been idle for several minutes

| | Expected | Result |
|---|---|---|
| F1 | First tap works (cold start), no visible delay | not run |
| F2 | Overlay appears on the first tap after idle | not run |
| F3 | As normal | not run |
| F4 | Previews still present (storage.session survives worker restarts) | not run |
| F5 | MRU order preserved across the restart | not run |
| F6 | As normal | not run |

### Light and dark appearance

| | Expected | Result |
|---|---|---|
| F1 | n/a | not run |
| F2 | Overlay colours follow the system appearance, text readable in both | not run |
| F3 | n/a | not run |
| F4 | Glyphs, icons and selection ring visible in both | not run |
| F5 | n/a | not run |
| F6 | n/a | not run |

### Reduce motion (System Settings › Accessibility › Display)

| | Expected | Result |
|---|---|---|
| F1 | As normal | not run |
| F2 | Overlay appears and moves without animation (it has none) | not run |
| F3 | As normal | not run |
| F4 | As normal | not run |
| F5 | n/a | not run |
| F6 | n/a | not run |

## Failures

| # | Condition / row | Steps | Actual | Severity | Status |
|---|---|---|---|---|---|
| | | | | | |
