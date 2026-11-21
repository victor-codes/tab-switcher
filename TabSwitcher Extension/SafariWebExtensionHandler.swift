//
//  SafariWebExtensionHandler.swift
//  TabSwitcher Extension
//
//  Answers the extension's `browser.runtime.sendNativeMessage` calls. The only request is
//  { type: "settings:get" }: it replies with what the Tab Switcher app saved in the shared App
//  Group, as { settings: {...} | null, clearToken: String | null }. Read-only: the app is
//  the only writer. `{ type: "snapshot:push", snapshot }` is forwarded to the running app
//  over a CFMessagePort named "<App Group>.panel" (in memory only); the reply is
//  { delivered: Bool }, false when the app is not running. `{ type: "focus:push", windowId }`
//  (null when no browser window has focus) goes the same way. `log` writes to the system log.
//

import SafariServices
import os

private let diagLog = Logger(subsystem: "xyz.ayovictor.tabswitcher", category: "extension")

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem
        let message = request?.userInfo?[SFExtensionMessageKey] as? [String: Any]

        var reply: [String: Any] = [:]
        if message?["type"] as? String == "settings:get" {
            let shared = SharedSettings.defaults
            if let data = shared?.data(forKey: SharedSettings.settingsKey),
               let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                reply["settings"] = object
            } else {
                reply["settings"] = NSNull()
            }
            reply["clearToken"] = shared?.string(forKey: SharedSettings.clearTokenKey) ?? NSNull()
        } else if message?["type"] as? String == "snapshot:push" || message?["type"] as? String == "focus:push" {
            reply["delivered"] = PanelPort.send(message ?? [:])
        } else if message?["type"] as? String == "log" {
            // Diagnostics from the background (event names, counts, timings; nothing from a page).
            let what = message?["what"] as? String ?? "?"
            let data = (message?["data"] as? [String: Any]).flatMap { try? JSONSerialization.data(withJSONObject: $0, options: [.sortedKeys]) }
                .flatMap { String(data: $0, encoding: .utf8) } ?? ""
            diagLog.notice("\(what, privacy: .public) \(data, privacy: .public)")
            reply["ok"] = true
        } else {
            reply["error"] = "unknown request"
        }

        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: reply]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}

/// Where the app and the extension share settings. Keep in sync with TabSwitcher/Settings.swift.
enum SharedSettings {
    static let settingsKey = "settings"
    static let clearTokenKey = "clearToken"
    static var defaults: UserDefaults? {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "TabSwitcherAppGroup") as? String else { return nil }
        return UserDefaults(suiteName: group)
    }
}

/// The way to the running app: a CFMessagePort named after the App Group (spike: allowed in the
/// sandbox for both targets, 8 MB delivered). Nothing is written to disk.
enum PanelPort {
    /// Message id the app's port callback expects for a snapshot.
    static let snapshotMessageID: Int32 = 1

    /// Sends `message` (the `{ type, snapshot }` object) as JSON. False when the app is not
    /// running (no port) or does not answer within a second.
    static func send(_ message: [String: Any]) -> Bool {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "TabSwitcherAppGroup") as? String,
              JSONSerialization.isValidJSONObject(message),
              let data = try? JSONSerialization.data(withJSONObject: message),
              let remote = CFMessagePortCreateRemote(nil, (group + ".panel") as CFString) else { return false }
        defer { CFMessagePortInvalidate(remote) }
        let status = CFMessagePortSendRequest(remote, snapshotMessageID, data as CFData, 1.0, 0, nil, nil)
        return status == kCFMessagePortSuccess
    }
}
