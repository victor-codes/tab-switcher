# Agent 2 — switcher overlay content script (Phase 1)

Read `00-overview.md` and `SPIKE-RESULTS.md` first. You own `extension/content/switcher.js` and `extension/content/harness.html`. One classic script, no imports, no external assets, styles inlined into the shadow root.

## Behaviour

1. **Passive modifier tracking** from `document_start`: capture-phase `keydown`/`keyup`/`blur` listeners on `window` maintain the set of currently held modifiers. Never call `preventDefault` or stop propagation outside an active overlay. Do nothing else until a message arrives — zero DOM changes on pages that never use the switcher.
2. **`switcher:show`**: reply `{ ok: true, hasFocus, modifiersHeld }` synchronously, where `hasFocus` is `document.hasFocus()` and `modifiersHeld` means every key in `msg.modifiers` is currently down. If either is false, do not render (the background falls back or commits). If held, render the overlay immediately, in the same task as the reply — no display delay, no timers before first paint.
3. **`switcher:move`**: update the selection, scroll it into view.
4. **`switcher:hide`**: remove the overlay.
5. **Commit** with `items[selectedIndex].tabId` when: the last required modifier is released; a row is clicked; the window blurs or the document becomes hidden while shown.
6. **Cancel** on Escape (swallow that key event while shown).
7. While shown, swallow arrow keys and use them to move the selection locally (Left/Up = previous, Right/Down = next); commit still happens on modifier release.
8. **`page:meta`**: at `document_idle`, send the best icon URL once — prefer `link[rel~="icon"]` with the largest `sizes`, then `apple-touch-icon`, else `null`. Resolve to absolute. Skip in private contexts if the spike found a way to detect them from the page; otherwise the background filters.

## Presentation

- Host element appended to `document.documentElement`, closed shadow root, `all: initial`, `position: fixed`, max `z-index`, `pointer-events` only on the panel. Remove the host entirely on hide.
- Centered panel, horizontal row of cards (wraps to a second row past 5): preview thumbnail 16:10 (neutral placeholder with the icon when `preview` is null), icon 16 px, title on one line with ellipsis, host in secondary text. Selected card has a clear ring.
- System font stack, light and dark via `prefers-color-scheme`, translucent backdrop (`backdrop-filter` with a solid fallback), respects `prefers-reduced-motion` (no transitions). No entry animation: the overlay appears fully opaque on the first frame.
- Must survive hostile pages: page CSS cannot leak in, page scripts cannot find the root, works when `document.body` does not exist yet, works on pages with `transform` on `html`, and under strict CSP (no inline event handlers, no `eval`, styles via a constructed stylesheet or a `<style>` inside the shadow root — check which one Safari permits under CSP and note it).
- Titles and hosts are untrusted: set with `textContent`, never `innerHTML`. Only use `icon`/`preview` as `img.src`, and only `https:`, `http:` or `data:image/` URLs.

## Harness

`content/harness.html` loads `switcher.js` in a normal browser tab with a tiny fake `browser.runtime` and buttons/keys to fire `show`/`move`/`hide` with sample items (1, 2, 8 items; long titles; missing previews; RTL title). Use it with the built-in browser preview to check layout in light and dark, and screenshot both for your report.

## Done when

Harness scenarios behave as specified, the Xcode build is green, and your report lists a manual Safari checklist for F2 (hold, tap three times, release; Esc; click a card; overlay appears instantly on key press; text field focused; a strict-CSP site such as github.com).
