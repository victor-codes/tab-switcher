//
//  ShortcutAgent.swift
//  TabFlip
//
//  Safari doesn't let an extension take ⌃Tab, and a web page only sees it while it has
//  focus. So while TabFlip runs (in the background, as a login item: TabFlipApp.swift),
//  it claims the user's two shortcuts system-wide, but only while Safari is the frontmost
//  app, and passes each press to the extension:
//
//    flip    { dir: 1 | -1 }   a shortcut was pressed (1 = next, -1 = previous)
//    release {}                the held modifier (⌃ for ⌃Tab) was let go
//
//  Safari only accepts these messages from the app the extension ships in (a separate
//  helper app gets SFErrorNoExtensionFound), which is why the app itself does this.
//  It uses RegisterEventHotKey, which needs no Accessibility permission and works in the
//  App Sandbox. The shortcuts are read again each time Safari comes to the front.
//

import AppKit
import Carbon.HIToolbox
import os
import SafariServices

private let log = Logger(subsystem: "com.example.tabflip", category: "hotkeys")

/// Browsers the shortcuts are claimed in.
private let safariBundleIDs: Set<String> = ["com.apple.Safari", "com.apple.SafariTechnologyPreview"]

final class ShortcutAgent: NSObject {
    private let hotKeys = HotKeys()
    private lazy var releaseWatch = ReleaseWatch { [weak self] in self?.send("release", [:]) }

    func start() {
        hotKeys.onPress = { [weak self] dir in self?.pressed(dir) }
        NSWorkspace.shared.notificationCenter.addObserver(
            self, selector: #selector(appActivated(_:)),
            name: NSWorkspace.didActivateApplicationNotification, object: nil)
        update(frontmost: NSWorkspace.shared.frontmostApplication)
    }

    @objc private func appActivated(_ note: Notification) {
        update(frontmost: note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)
    }

    private func update(frontmost: NSRunningApplication?) {
        log.info("frontmost: \(frontmost?.bundleIdentifier ?? "none", privacy: .public)")
        if let id = frontmost?.bundleIdentifier, safariBundleIDs.contains(id) {
            hotKeys.register(loadShortcuts())
        } else {
            hotKeys.unregister()
            releaseWatch.stop()
        }
    }

    private func loadShortcuts() -> ShortcutPair {
        let group = Bundle.main.object(forInfoDictionaryKey: "TabFlipAppGroup") as? String
        guard let defaults = group.flatMap({ UserDefaults(suiteName: $0) }),
              let data = defaults.data(forKey: SettingsStore.settingsKey),
              let settings = try? JSONDecoder().decode(TabFlipSettings.self, from: data)
        else { return .defaults }
        return settings.shortcuts
    }

    private func pressed(_ dir: Int) {
        log.info("pressed dir=\(dir, privacy: .public)")
        send("flip", ["dir": dir])
        releaseWatch.start(holding: hotKeys.holdFlags)
    }

    private func send(_ name: String, _ info: [String: Any]) {
        SFSafariApplication.dispatchMessage(withName: name, toExtensionWithIdentifier: extensionBundleIdentifier,
                                            userInfo: info) { error in
            if let error { log.error("dispatch \(name, privacy: .public) failed: \(error.localizedDescription, privacy: .public)") }
        }
    }
}

// MARK: - Hot keys

/// The two system-wide shortcuts, through the Carbon hot key API.
final class HotKeys {
    var onPress: ((Int) -> Void)?
    /// The modifiers both shortcuts share (Shift excepted): the ones held while browsing.
    private(set) var holdFlags: CGEventFlags = .maskControl

    private var refs: [EventHotKeyRef] = []
    private var registered: ShortcutPair?
    private var handler: EventHandlerRef?
    private static let signature: OSType = 0x5446_6C70 // "TFlp"

    init() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let me = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandler(GetApplicationEventTarget(), { _, event, context in
            guard let event, let context else { return OSStatus(eventNotHandledErr) }
            var id = EventHotKeyID()
            let status = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                                           nil, MemoryLayout<EventHotKeyID>.size, nil, &id)
            guard status == noErr, id.signature == HotKeys.signature else { return OSStatus(eventNotHandledErr) }
            let keys = Unmanaged<HotKeys>.fromOpaque(context).takeUnretainedValue()
            MainActor.assumeIsolated { keys.onPress?(id.id == 2 ? -1 : 1) }
            return noErr
        }, 1, &spec, me, &handler)
    }

    func register(_ pair: ShortcutPair) {
        if registered == pair, !refs.isEmpty { return }
        unregister()
        for (index, shortcut) in [pair.next, pair.prev].enumerated() {
            guard let keyCode = ShortcutRules.keyCode(forCode: shortcut.code) else { continue }
            var ref: EventHotKeyRef?
            let id = EventHotKeyID(signature: Self.signature, id: UInt32(index + 1))
            let status = RegisterEventHotKey(UInt32(keyCode), Self.carbonModifiers(shortcut), id,
                                             GetApplicationEventTarget(), 0, &ref)
            if status == noErr, let ref { refs.append(ref); log.info("claimed \(ShortcutRules.display(shortcut), privacy: .public)") }
            else { log.error("could not claim \(ShortcutRules.display(shortcut), privacy: .public): \(status)") }
        }
        registered = pair
        var hold: CGEventFlags = []
        if pair.next.ctrl && pair.prev.ctrl { hold.insert(.maskControl) }
        if pair.next.alt && pair.prev.alt { hold.insert(.maskAlternate) }
        if pair.next.meta && pair.prev.meta { hold.insert(.maskCommand) }
        holdFlags = hold
    }

    func unregister() {
        for ref in refs { UnregisterEventHotKey(ref) }
        refs = []
        registered = nil
    }

    private static func carbonModifiers(_ s: Shortcut) -> UInt32 {
        var m = 0
        if s.ctrl { m |= controlKey }
        if s.alt { m |= optionKey }
        if s.shift { m |= shiftKey }
        if s.meta { m |= cmdKey }
        return UInt32(m)
    }
}

// MARK: - Release

/// After a press, watches the keyboard state until the held modifiers are let go. Reading
/// the modifier state needs no permission; this only runs while a switch is in progress.
final class ReleaseWatch {
    private let onRelease: () -> Void
    private var timer: Timer?
    private var hold: CGEventFlags = []
    private var startedAt = Date()
    /// Give up if the keys somehow stay down (or the state is never read as released).
    private let limit: TimeInterval = 15

    init(onRelease: @escaping () -> Void) {
        self.onRelease = onRelease
    }

    func start(holding flags: CGEventFlags) {
        hold = flags
        startedAt = Date()
        guard timer == nil else { return }
        let t = Timer(timeInterval: 1.0 / 120, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    private func tick() {
        let now = CGEventSource.flagsState(.combinedSessionState)
        if now.intersection(hold).isEmpty {
            stop()
            onRelease()
        } else if Date().timeIntervalSince(startedAt) > limit {
            stop()
        }
    }
}
