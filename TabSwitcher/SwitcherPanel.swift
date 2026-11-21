//
//  SwitcherPanel.swift
//  Tab Switcher
//
//  The window the switcher is drawn in: a borderless, non-activating NSPanel that is never
//  key or main, so Safari stays the active app and the claimed shortcuts keep arriving. The
//  settings are the ones the Phase 0 spike proved over normal and full-screen Safari, the
//  Screen Time screen, the Start Page and error pages (plans/SPIKE-PANEL.md).
//
//  Showing it never touches the activation policy, so it never brings back the Dock icon.
//

import AppKit
import os
import SwiftUI

private let log = Logger(subsystem: "xyz.ayovictor.tabswitcher", category: "panel")

/// Clicks reach a window that is not key only if the view accepts the first mouse.
/// The panel is never key and Safari stays the active app, so pointer moves come from a
/// tracking area that is active always (SwiftUI's own hover tracking needs an active window).
private final class PanelHostingView<Content: View>: NSHostingView<Content> {
    /// The pointer's position, top-left origin, in this view.
    var onMouseMoved: ((CGPoint) -> Void)?
    private var area: NSTrackingArea?

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let area { removeTrackingArea(area) }
        let next = NSTrackingArea(rect: .zero, options: [.mouseMoved, .activeAlways, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(next)
        area = next
    }

    override func mouseMoved(with event: NSEvent) {
        super.mouseMoved(with: event)
        let p = convert(event.locationInWindow, from: nil)
        onMouseMoved?(CGPoint(x: p.x, y: isFlipped ? p.y : bounds.height - p.y))
    }
}

private final class NonActivatingPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class SwitcherPanel {
    /// Called with the index of the card that was clicked.
    var onClick: ((Int) -> Void)? {
        get { model.onClick }
        set { model.onClick = newValue }
    }

    /// Called with the index of the card the pointer moved onto.
    var onHover: ((Int) -> Void)?

    private let model = SwitcherModel()
    /// Where the pointer was first seen after the panel appeared; it must travel a few px
    /// before it moves the selection (a pointer resting where the panel opens does nothing),
    /// as in the page (extension/content/switcher.js, onPanelPointerMove).
    private var pointerOrigin: CGPoint?
    private var pointerLive = false
    private let panel: NSPanel
    private let host: PanelHostingView<SwitcherView>
    private(set) var isShown = false
    /// Bounds of the browser window the extension last reported as focused (CG coordinates,
    /// top-left origin), or nil. Used to pick that window over others Safari has open.
    var focusedWindowBounds: CGRect?

    init() {
        panel = NonActivatingPanel(contentRect: NSRect(x: 0, y: 0, width: 400, height: 200),
                                   styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isFloatingPanel = true
        panel.level = .popUpMenu
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient, .ignoresCycle]
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.animationBehavior = .none
        panel.isReleasedWhenClosed = false
        host = PanelHostingView(rootView: SwitcherView(model: model))
        host.sizingOptions = []
        panel.contentView = host
        panel.acceptsMouseMovedEvents = true
        host.onMouseMoved = { [weak self] point in self?.pointerMoved(to: point) }
    }

    private func pointerMoved(to point: CGPoint) {
        guard isShown else { return }
        guard let origin = pointerOrigin else { pointerOrigin = point; return }
        if !pointerLive {
            if hypot(point.x - origin.x, point.y - origin.y) < 4 { return }
            pointerLive = true
        }
        if let index = model.card(at: point) { onHover?(index) }
    }

    /// Decode images ahead of a press (call when a snapshot arrives).
    func prime(_ items: [PanelItem]) { model.prime(items) }

    func forgetImages() { model.forgetImages() }

    /// Show the panel once at zero alpha and hide it again, so the first real press is not
    /// the cold one (the spike's first show took 26 ms, later ones 7–14 ms).
    func warm() {
        let sample = (1...4).map { PanelItem(tabId: -$0, title: "Tab Switcher", host: "example.com", icon: nil, preview: nil) }
        panel.alphaValue = 0
        present(items: sample, selected: 1)
        panel.orderOut(nil)
        isShown = false
        panel.alphaValue = 1
        model.items = []
    }

    func show(items: [PanelItem], selected: Int) {
        present(items: items, selected: selected)
    }

    func select(_ index: Int) {
        guard isShown else { return }
        model.selected = index
    }

    func hide() {
        guard isShown else { return }
        panel.orderOut(nil)
        isShown = false
    }

    private func present(items: [PanelItem], selected: Int) {
        let region = Self.safariWindow(near: focusedWindowBounds) ?? Self.mouseScreenRegion()
        model.viewport = region.size
        model.items = items
        model.selected = selected
        let size = model.metrics.panelSize
        host.setFrameSize(size)
        panel.setContentSize(size)
        panel.setFrameOrigin(NSPoint(x: region.midX - size.width / 2, y: region.midY - size.height / 2))
        host.layoutSubtreeIfNeeded()
        pointerOrigin = nil
        pointerLive = false
        panel.orderFrontRegardless()
        isShown = true
    }

    // MARK: Where to show it

    /// The Safari window to centre on, in Cocoa coordinates, or nil. No permission is needed;
    /// window titles are not returned, which is fine. Safari's other windows (its Settings
    /// window, for one) can be listed ahead of the browser window that has focus, so the one
    /// matching `focused` (the extension's bounds for it) wins: same frame, else same size and
    /// x (Safari's `top` does not match CG's y on every display), else same size (the window
    /// was moved since), else the front Safari window as before.
    private static func safariWindow(near focused: CGRect?) -> NSRect? {
        guard let safari = NSWorkspace.shared.frontmostApplication,
              safari.bundleIdentifier?.hasPrefix("com.apple.Safari") == true,
              let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
                as? [[String: Any]]
        else { return nil }
        let pid = safari.processIdentifier
        let windows: [CGRect] = list.compactMap { window in
            guard (window[kCGWindowOwnerPID as String] as? Int32) == pid,
                  (window[kCGWindowLayer as String] as? Int) == 0,
                  let dict = window[kCGWindowBounds as String] as? [String: Any],
                  let r = CGRect(dictionaryRepresentation: dict as CFDictionary),
                  r.width > 200, r.height > 200
            else { return nil }
            return r
        }
        let close = { (a: CGFloat, b: CGFloat) in abs(a - b) <= 4 }
        let sameSize = { (r: CGRect, f: CGRect) in close(r.width, f.width) && close(r.height, f.height) }
        let chosen = focused.flatMap { f in
            windows.first { sameSize($0, f) && close($0.minX, f.minX) && close($0.minY, f.minY) }
                ?? windows.first { sameSize($0, f) && close($0.minX, f.minX) }
                ?? windows.first { sameSize($0, f) }
        } ?? windows.first
        guard let r = chosen else { return nil }
        // CG is top-left origin on the primary screen; Cocoa is bottom-left.
        let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
        return NSRect(x: r.minX, y: primaryHeight - (r.minY + r.height), width: r.width, height: r.height)
    }

    /// Fallback: the visible area of the screen that has the mouse.
    private static func mouseScreenRegion() -> NSRect {
        let screen = NSScreen.screens.first { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) } ?? NSScreen.main
        return screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1000, height: 700)
    }
}
