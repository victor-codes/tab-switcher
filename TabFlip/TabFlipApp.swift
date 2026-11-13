//
//  TabFlipApp.swift
//  TabFlip
//
//  The container app is a delivery vehicle for the Safari extension: one
//  onboarding window, no login item, no menu bar item, no background work.
//  Closing the window quits the app.
//

import AppKit
import SwiftUI

/// Bundle identifier of the embedded Safari Web Extension.
let extensionBundleIdentifier = "com.example.tabflip.Extension"

@main
struct TabFlipApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        Window("TabFlip", id: "main") {
            ContentView()
        }
        .windowResizability(.contentSize)
        .commands {
            // Single window, no document model: drop File > New.
            CommandGroup(replacing: .newItem) {}
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}
