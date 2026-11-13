//
//  TabFlipApp.swift
//  TabFlip
//
//  The app is where TabFlip is set up and configured, and it also claims the shortcuts
//  while Safari is in front (ShortcutAgent.swift). So it keeps running after its window
//  closes: with the window open it has a Dock icon; closed, it has no icon at all (no
//  Dock, no menu bar). It opens at login without showing the window. Opening TabFlip
//  again brings the window back.
//

import AppKit
import Carbon.HIToolbox
import SwiftUI

/// Bundle identifier of the embedded Safari Web Extension.
let extensionBundleIdentifier = "com.example.tabflip.Extension"

@main
struct TabFlipApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        Window("Tab Switcher", id: "main") {
            ContentView()
        }
        // Size the window to ContentView's frame limits (min and max), not just its minimum.
        .windowResizability(.contentSize)
        .commands {
            // Single window, no document model: drop File > New.
            CommandGroup(replacing: .newItem) {}
            // ⌘Q closes the window; TabFlip keeps running so the shortcuts keep working.
            CommandGroup(replacing: .appTermination) {
                Button("Close Window") { AppDelegate.closeWindows() }
                    .keyboardShortcut("q")
                Button("Quit Completely") { NSApp.terminate(nil) }
                    .keyboardShortcut("q", modifiers: [.command, .option])
            }
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let agent = ShortcutAgent()

    func applicationDidFinishLaunching(_ notification: Notification) {
        agent.start()
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(windowWillClose(_:)), name: NSWindow.willCloseNotification, object: nil)
        center.addObserver(self, selector: #selector(windowDidBecomeKey(_:)), name: NSWindow.didBecomeKeyNotification, object: nil)
        if launchedAtLogin {
            // Start in the background: no window, no Dock icon.
            NSApp.setActivationPolicy(.accessory)
            DispatchQueue.main.async { Self.closeWindows() }
        }
    }

    /// Opening TabFlip while it runs in the background shows the window again.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate()
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    static func closeWindows() {
        for window in NSApp.windows where window.isVisible { window.close() }
    }

    @objc private func windowWillClose(_ note: Notification) {
        guard let closing = note.object as? NSWindow, closing.canBecomeMain else { return }
        // The last real window is closing: drop the Dock icon and menu bar.
        DispatchQueue.main.async {
            if !NSApp.windows.contains(where: { $0.isVisible && $0.canBecomeMain }) {
                NSApp.setActivationPolicy(.accessory)
            }
        }
    }

    @objc private func windowDidBecomeKey(_ note: Notification) {
        guard let window = note.object as? NSWindow, window.canBecomeMain else { return }
        if NSApp.activationPolicy() != .regular {
            NSApp.setActivationPolicy(.regular)
            NSApp.activate()
        }
    }

    /// True when macOS opened TabFlip as a login item rather than the user opening it.
    private var launchedAtLogin: Bool {
        guard let event = NSAppleEventManager.shared().currentAppleEvent else { return false }
        return event.eventID == kAEOpenApplication
            && event.paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue == keyAELaunchedAsLogInItem
    }
}
