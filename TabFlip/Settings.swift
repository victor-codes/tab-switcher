//
//  Settings.swift
//  TabFlip
//
//  TabFlip's settings, edited in this app and read by the Safari extension and by the
//  app's shortcut agent (ShortcutAgent.swift).
//
//  They are saved as JSON in a shared App Group. The extension's native handler
//  (TabFlip Extension/SafariWebExtensionHandler.swift) returns them to the extension,
//  which applies them when Safari next becomes active. The JSON shape and the shortcut
//  rules match extension/core/store.js and extension/core/shortcuts.js.
//

import Combine
import Foundation

// MARK: - Model

/// A key combination. `code` is a KeyboardEvent.code ("Tab", "KeyQ", "Digit1", …).
struct Shortcut: Codable, Equatable {
    var ctrl = false
    var alt = false
    var shift = false
    var meta = false
    var code: String

    static let defaultNext = Shortcut(ctrl: true, code: "Tab")
    static let defaultPrev = Shortcut(ctrl: true, shift: true, code: "Tab")
}

struct ShortcutPair: Codable, Equatable {
    var next: Shortcut
    var prev: Shortcut

    static let defaults = ShortcutPair(next: .defaultNext, prev: .defaultPrev)
}

struct TabFlipSettings: Codable, Equatable {
    var overlay = true
    var previews = true
    var maxItems = 8
    var shortcuts = ShortcutPair.defaults

    static let maxItemsRange = 4...12

    init() {}

    // Tolerant decoding: anything missing or invalid falls back to its default.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        overlay = (try? c.decode(Bool.self, forKey: .overlay)) ?? true
        previews = (try? c.decode(Bool.self, forKey: .previews)) ?? true
        let items = (try? c.decode(Int.self, forKey: .maxItems)) ?? 8
        maxItems = Self.maxItemsRange.contains(items) ? items : 8
        var pair = (try? c.decode(ShortcutPair.self, forKey: .shortcuts)) ?? .defaults
        // ⌃Q stood in for ⌃Tab while Safari's own commands handled the shortcuts (they
        // can't use ⌃Tab). The app claims ⌃Tab now, so move it back.
        if pair.next == Shortcut(ctrl: true, code: "KeyQ") { pair.next = .defaultNext }
        shortcuts = ShortcutRules.pairProblem(pair.next, pair.prev) == nil ? pair : .defaults
    }
}

// MARK: - Store

/// Loads and saves the settings in the shared App Group. Every change is saved at once.
@MainActor
final class SettingsStore: ObservableObject {
    static let settingsKey = "settings"
    static let clearTokenKey = "clearToken"

    @Published var settings: TabFlipSettings {
        didSet { if settings != oldValue { save() } }
    }

    private let defaults: UserDefaults?

    init() {
        let group = Bundle.main.object(forInfoDictionaryKey: "TabFlipAppGroup") as? String
        defaults = group.flatMap { UserDefaults(suiteName: $0) }
        if let data = defaults?.data(forKey: Self.settingsKey),
           let saved = try? JSONDecoder().decode(TabFlipSettings.self, from: data) {
            settings = saved
            save() // keeps any correction made while decoding
        } else {
            settings = TabFlipSettings()
            save()
        }
    }

    /// False when the shared App Group is unavailable (a build signed without a team).
    var isShared: Bool { defaults != nil }

    private func save() {
        guard let data = try? JSONEncoder().encode(settings) else { return }
        defaults?.set(data, forKey: Self.settingsKey)
    }

    /// Ask the extension to delete previews, site icons and recent-tab history. It does so
    /// the next time Safari becomes active (a new token is the request).
    func requestClear() {
        defaults?.set(UUID().uuidString, forKey: Self.clearTokenKey)
    }
}

// MARK: - Shortcut rules (same as extension/core/shortcuts.js)

enum ShortcutRules {
    /// Keys a shortcut may end on. Escape (cancel) and the arrows (move) are reserved.
    private static let allowedCode = try! NSRegularExpression(
        pattern: "^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9])|Tab|Space|Enter|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash)$")

    static func isUsable(_ s: Shortcut) -> Bool {
        let range = NSRange(s.code.startIndex..., in: s.code)
        return allowedCode.firstMatch(in: s.code, range: range) != nil && (s.ctrl || s.alt || s.meta)
    }

    /// Why the pair can't be used, or nil when it can.
    static func pairProblem(_ next: Shortcut, _ prev: Shortcut) -> String? {
        if !isUsable(next) || !isUsable(prev) { return "Each shortcut needs Control, Option or Command, plus a key." }
        if next == prev { return "Next and previous can’t be the same shortcut." }
        let sharesHold = (next.ctrl && prev.ctrl) || (next.alt && prev.alt) || (next.meta && prev.meta)
        if !sharesHold { return "Both shortcuts need to share Control, Option or Command, so you can hold it while browsing." }
        return nil
    }

    private static let keyLabels: [String: String] = [
        "Tab": "⇥", "Space": "Space", "Enter": "↩", "Backquote": "`", "Minus": "-", "Equal": "=",
        "BracketLeft": "[", "BracketRight": "]", "Backslash": "\\", "Semicolon": ";", "Quote": "'",
        "Comma": ",", "Period": ".", "Slash": "/",
    ]

    /// As menus write it: "⌃⇧⇥".
    static func display(_ s: Shortcut) -> String {
        var out = ""
        if s.ctrl { out += "⌃" }
        if s.alt { out += "⌥" }
        if s.shift { out += "⇧" }
        if s.meta { out += "⌘" }
        return out + keyLabel(s.code)
    }

    /// For VoiceOver: "Control Shift Tab".
    static func spoken(_ s: Shortcut) -> String {
        var parts: [String] = []
        if s.ctrl { parts.append("Control") }
        if s.alt { parts.append("Option") }
        if s.shift { parts.append("Shift") }
        if s.meta { parts.append("Command") }
        parts.append(["Tab": "Tab", "Enter": "Return", "Space": "Space"][s.code] ?? keyLabel(s.code))
        return parts.joined(separator: " ")
    }

    private static func keyLabel(_ code: String) -> String {
        if let label = keyLabels[code] { return label }
        if code.hasPrefix("Key") { return String(code.dropFirst(3)) }
        if code.hasPrefix("Digit") { return String(code.dropFirst(5)) }
        return code
    }

    /// KeyboardEvent.code for a macOS virtual key code (physical key position, ANSI layout).
    static func code(forKeyCode keyCode: UInt16) -> String? {
        keyCodes[keyCode]
    }

    /// The macOS virtual key code for a KeyboardEvent.code (used to claim the shortcut).
    static func keyCode(forCode code: String) -> UInt16? {
        keyCodes.first { $0.value == code }?.key
    }

    private static let keyCodes: [UInt16: String] = {
        var map: [UInt16: String] = [
            48: "Tab", 49: "Space", 36: "Enter", 50: "Backquote", 27: "Minus", 24: "Equal",
            33: "BracketLeft", 30: "BracketRight", 42: "Backslash", 41: "Semicolon", 39: "Quote",
            43: "Comma", 47: "Period", 44: "Slash", 53: "Escape",
        ]
        let letters: [(UInt16, String)] = [
            (0, "A"), (11, "B"), (8, "C"), (2, "D"), (14, "E"), (3, "F"), (5, "G"), (4, "H"), (34, "I"),
            (38, "J"), (40, "K"), (37, "L"), (46, "M"), (45, "N"), (31, "O"), (35, "P"), (12, "Q"),
            (15, "R"), (1, "S"), (17, "T"), (32, "U"), (9, "V"), (13, "W"), (7, "X"), (16, "Y"), (6, "Z"),
        ]
        for (k, l) in letters { map[k] = "Key" + l }
        let digits: [(UInt16, String)] = [
            (29, "0"), (18, "1"), (19, "2"), (20, "3"), (21, "4"), (23, "5"), (22, "6"), (26, "7"), (28, "8"), (25, "9"),
        ]
        for (k, d) in digits { map[k] = "Digit" + d }
        let functionKeys: [UInt16] = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106, 64, 79, 80]
        for (i, k) in functionKeys.enumerated() { map[k] = "F\(i + 1)" }
        return map
    }()
}
