//
//  SafariWebExtensionHandler.swift
//  TabFlip Extension
//
//  Answers the extension's `browser.runtime.sendNativeMessage` calls. The only request is
//  { type: "settings:get" }: it replies with what the TabFlip app saved in the shared App
//  Group, as { settings: {...} | null, clearToken: String | null }. Read-only: the app is
//  the only writer.
//

import SafariServices

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
        } else {
            reply["error"] = "unknown request"
        }

        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: reply]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}

/// Where the app and the extension share settings. Keep in sync with TabFlip/Settings.swift.
enum SharedSettings {
    static let settingsKey = "settings"
    static let clearTokenKey = "clearToken"
    static var defaults: UserDefaults? {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "TabFlipAppGroup") as? String else { return nil }
        return UserDefaults(suiteName: group)
    }
}
