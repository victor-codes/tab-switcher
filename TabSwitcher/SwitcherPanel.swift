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

private let log = Logger(subsystem: "com.example.tabflip", category: "panel")

/// Clicks reach a window that is not key only if the view accepts the first mouse.
private final class PanelHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
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

    private let model = SwitcherModel()
    private let panel: NSPanel
    private let host: PanelHostingView<SwitcherView>
    private(set) var isShown = false

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
        let region = Self.safariFrontWindow() ?? Self.mouseScreenRegion()
        model.viewport = region.size
        model.items = items
        model.selected = selected
        let size = model.metrics.panelSize
        host.setFrameSize(size)
        panel.setContentSize(size)
        panel.setFrameOrigin(NSPoint(x: region.midX - size.width / 2, y: region.midY - size.height / 2))
        host.layoutSubtreeIfNeeded()
        panel.orderFrontRegardless()
        isShown = true
    }

    // MARK: Where to show it

    /// Front Safari window's bounds in Cocoa coordinates, or nil. No permission is needed;
    /// window titles are not returned, which is fine.
    private static func safariFrontWindow() -> NSRect? {
        guard let safari = NSWorkspace.shared.frontmostApplication,
              safari.bundleIdentifier?.hasPrefix("com.apple.Safari") == true,
              let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
                as? [[String: Any]]
        else { return nil }
        let pid = safari.processIdentifier
        for window in list {
            guard (window[kCGWindowOwnerPID as String] as? Int32) == pid,
                  (window[kCGWindowLayer as String] as? Int) == 0,
                  let dict = window[kCGWindowBounds as String] as? [String: Any],
                  let r = CGRect(dictionaryRepresentation: dict as CFDictionary),
                  r.width > 200, r.height > 200
            else { continue }
            // CG is top-left origin on the primary screen; Cocoa is bottom-left.
            let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
            return NSRect(x: r.minX, y: primaryHeight - (r.minY + r.height), width: r.width, height: r.height)
        }
        return nil
    }

    /// Fallback: the visible area of the screen that has the mouse.
    private static func mouseScreenRegion() -> NSRect {
        let screen = NSScreen.screens.first { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) } ?? NSScreen.main
        return screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1000, height: 700)
    }
}
