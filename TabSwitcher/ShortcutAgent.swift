//
//  ShortcutAgent.swift
//  Tab Switcher
//
//  Safari doesn't let an extension take ⌃Tab, and a web page only sees it while it has
//  focus. So while Tab Switcher runs (in the background, as a login item: TabSwitcherApp.swift),
//  it claims the user's two shortcuts system-wide, but only while Safari is the frontmost
//  app, and passes each press to the extension:
//
//    flip    { dir: 1 | -1 }   a shortcut was pressed (1 = next, -1 = previous)
//    release {}                the held modifier (⌃ for ⌃Tab) was let go
//
//  With the panel on (Settings.panel) and a snapshot of the tabs in memory, the press is
//  drawn by SwitcherPanel instead and the app tells the extension only the result:
//
//    activate { windowId, tabId }   the tab the user chose
//
//  PanelSession decides, at the first press of a gesture, which of the two paths it uses.
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
    private let snapshots = SnapshotStore()
    private var session = PanelSession()
    private lazy var panel = SwitcherPanel()
    private lazy var releaseWatch = ReleaseWatch(
        onRelease: { [weak self] in self?.run(.release) },
        onTimeout: { [weak self] in self?.run(.timeout) })

    func start() {
        hotKeys.onPress = { [weak self] dir in self?.pressed(dir) }
        hotKeys.onEscape = { [weak self] in self?.run(.escape) }
        panel.onClick = { [weak self] index in self?.run(.click(index)) }
        let center = NSWorkspace.shared.notificationCenter
        center.addObserver(self, selector: #selector(appActivated(_:)),
                           name: NSWorkspace.didActivateApplicationNotification, object: nil)
        center.addObserver(self, selector: #selector(appTerminated(_:)),
                           name: NSWorkspace.didTerminateApplicationNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(forgetSnapshots),
                                               name: .panelSnapshotsForget, object: nil)
        update(frontmost: NSWorkspace.shared.frontmostApplication)
        #if DEBUG
        loadFixture()
        #endif
        // Warm the panel once, after launch has settled, so the first press is not the cold one.
        DispatchQueue.main.async { [weak self] in self?.panel.warm() }
    }

    /// Hand the app a snapshot of one Safari window's tabs (rules 3–5 decide what is kept).
    /// Phase 2 calls this for each snapshot that arrives from the extension.
    func receive(_ snapshot: PanelSnapshot) {
        guard snapshots.receive(snapshot) else { return }
        panel.prime(snapshot.items)
    }

    @objc private func appActivated(_ note: Notification) {
        update(frontmost: note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)
    }

    @objc private func appTerminated(_ note: Notification) {
        let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
        if let id = app?.bundleIdentifier, safariBundleIDs.contains(id) { forgetSnapshots() }
    }

    /// Safari quit, "Clear…" was used, or the panel was turned off (rule 6).
    @objc private func forgetSnapshots() {
        snapshots.clear()
        panel.forgetImages()
        if session.phase == .shown { run(.escape) }
    }

    private func update(frontmost: NSRunningApplication?) {
        log.info("frontmost: \(frontmost?.bundleIdentifier ?? "none", privacy: .public)")
        if let id = frontmost?.bundleIdentifier, safariBundleIDs.contains(id) {
            hotKeys.register(loadSettings().shortcuts)
        } else {
            hotKeys.unregister()
            releaseWatch.stop()
            run(.safariLostFocus)
        }
    }

    private func loadSettings() -> TabSwitcherSettings {
        let group = Bundle.main.object(forInfoDictionaryKey: "TabSwitcherAppGroup") as? String
        guard let defaults = group.flatMap({ UserDefaults(suiteName: $0) }),
              let data = defaults.data(forKey: SettingsStore.settingsKey),
              let settings = try? JSONDecoder().decode(TabSwitcherSettings.self, from: data)
        else { return TabSwitcherSettings() }
        return settings
    }

    private func pressed(_ dir: Int) {
        log.info("pressed dir=\(dir, privacy: .public)")
        // The path is decided at the first press; only then is the setting and the store read.
        var usable: PanelSnapshot?
        if session.phase == .idle, loadSettings().panel { usable = snapshots.current }
        perform(session.apply(.press(dir), snapshot: usable))
        releaseWatch.start(holding: hotKeys.holdFlags)
    }

    private func run(_ input: PanelInput) {
        let before = session.phase
        perform(session.apply(input, snapshot: nil))
        if before != .idle, session.phase == .idle, input != .release { releaseWatch.stop() }
    }

    private func perform(_ effects: [PanelEffect]) {
        for effect in effects {
            switch effect {
            case .show(let items, let selected):
                panel.show(items: items, selected: selected)
                hotKeys.registerEscape()
            case .select(let index):
                panel.select(index)
            case .hide:
                panel.hide()
                hotKeys.unregisterEscape()
            case .activate(let windowId, let tabId):
                send("activate", ["windowId": windowId, "tabId": tabId])
            case .forwardFlip(let dir):
                send("flip", ["dir": dir])
            case .forwardRelease:
                send("release", [:])
            }
        }
    }

    private func send(_ name: String, _ info: [String: Any]) {
        SFSafariApplication.dispatchMessage(withName: name, toExtensionWithIdentifier: extensionBundleIdentifier,
                                            userInfo: info) { error in
            if let error { log.error("dispatch \(name, privacy: .public) failed: \(error.localizedDescription, privacy: .public)") }
        }
    }

    #if DEBUG
    /// Debug flag `-panelFixture 1|2|8|30` (a launch argument): load that many fake tabs from
    /// PanelFixture.json, until real snapshots are wired in.
    private func loadFixture() {
        let count = UserDefaults.standard.integer(forKey: "panelFixture")
        guard count > 0, let url = Bundle.main.url(forResource: "PanelFixture", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let all = try? JSONDecoder().decode([String: PanelSnapshot].self, from: data),
              let snapshot = all[String(count)] else { return }
        receive(snapshot)
        log.notice("panel fixture loaded: \(count, privacy: .public) items")
    }
    #endif
}

// MARK: - Hot keys

/// The two system-wide shortcuts, through the Carbon hot key API.
final class HotKeys {
    var onPress: ((Int) -> Void)?
    var onEscape: (() -> Void)?
    private var escapeRefs: [EventHotKeyRef] = []
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
            MainActor.assumeIsolated {
                if id.id >= 3 { keys.onEscape?() } else { keys.onPress?(id.id == 2 ? -1 : 1) }
            }
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
            if status == noErr, let ref { refs.append(ref); log.notice("claimed \(ShortcutRules.display(shortcut), privacy: .public)") }
            else { log.error("could not claim \(ShortcutRules.display(shortcut), privacy: .public): \(status)") }
        }
        registered = pair
        var hold: CGEventFlags = []
        if pair.next.ctrl && pair.prev.ctrl { hold.insert(.maskControl) }
        if pair.next.alt && pair.prev.alt { hold.insert(.maskAlternate) }
        if pair.next.meta && pair.prev.meta { hold.insert(.maskCommand) }
        holdFlags = hold
    }

    /// Esc with the held modifiers (with and without Shift), claimed only while the panel shows.
    func registerEscape() {
        unregisterEscape()
        guard let pair = registered else { return }
        var base = 0
        if pair.next.ctrl && pair.prev.ctrl { base |= controlKey }
        if pair.next.alt && pair.prev.alt { base |= optionKey }
        if pair.next.meta && pair.prev.meta { base |= cmdKey }
        for (i, mods) in [base, base | shiftKey].enumerated() {
            var ref: EventHotKeyRef?
            let id = EventHotKeyID(signature: Self.signature, id: UInt32(3 + i))
            let status = RegisterEventHotKey(UInt32(kVK_Escape), UInt32(mods), id, GetApplicationEventTarget(), 0, &ref)
            if status == noErr, let ref { escapeRefs.append(ref) }
            else { log.error("could not claim escape: \(status)") }
        }
    }

    func unregisterEscape() {
        for ref in escapeRefs { UnregisterEventHotKey(ref) }
        escapeRefs = []
    }

    func unregister() {
        unregisterEscape()
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
    private let onTimeout: () -> Void
    private var timer: Timer?
    private var hold: CGEventFlags = []
    private var startedAt = Date()
    /// Give up if the keys somehow stay down (or the state is never read as released).
    private let limit: TimeInterval = 15

    init(onRelease: @escaping () -> Void, onTimeout: @escaping () -> Void = {}) {
        self.onRelease = onRelease
        self.onTimeout = onTimeout
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
            onTimeout()
        }
    }
}
