//
//  ContentView.swift
//  TabFlip
//
//  The app's one window, and the only place to configure TabFlip: extension status,
//  switcher options, switch shortcuts and stored data. Changes are saved at once
//  (Settings.swift) and reach the extension the next time Safari becomes active. The
//  shortcuts themselves are claimed by the app while it runs in the background
//  (ShortcutAgent.swift, HelperStatus below), so this window can be closed.
//

import AppKit
import Combine
import SafariServices
import ServiceManagement
import SwiftUI

// MARK: - Extension status

@MainActor
final class ExtensionStatus: ObservableObject {
    enum State: Equatable {
        case checking
        case enabled
        case disabled
        case unavailable(String)
    }

    @Published private(set) var state: State = .checking
    @Published private(set) var openError: String?

    func refresh() async {
        do {
            let result = try await SFSafariExtensionManager.stateOfSafariExtension(
                withIdentifier: extensionBundleIdentifier)
            state = result.isEnabled ? .enabled : .disabled
        } catch {
            state = .unavailable(error.localizedDescription)
        }
    }

    func openSafariSettings() async {
        openError = nil
        do {
            try await SFSafariApplication.showPreferencesForExtension(
                withIdentifier: extensionBundleIdentifier)
        } catch {
            openError = error.localizedDescription
        }
    }
}

// MARK: - Background (login item)

/// TabFlip itself stays running in the background (no icon) to claim the shortcuts while
/// Safari is in front, and opens at login (SMAppService.mainApp).
@MainActor
final class HelperStatus: ObservableObject {
    enum State: Equatable {
        case running
        case needsApproval
        case unavailable(String)
    }

    @Published private(set) var state: State = .running

    private var service: SMAppService { .mainApp }

    /// Register as a login item (once).
    func start() {
        if service.status == .notRegistered || service.status == .notFound {
            do {
                try service.register()
            } catch {
                state = .unavailable(error.localizedDescription)
                return
            }
        }
        refresh()
    }

    func refresh() {
        switch service.status {
        case .enabled: state = .running
        case .requiresApproval: state = .needsApproval
        case .notRegistered: state = .unavailable("TabFlip isn’t set to open at login.")
        case .notFound: state = .unavailable("macOS couldn’t find this copy of TabFlip.")
        @unknown default: state = .unavailable("Unknown login item state.")
        }
    }

    func openLoginItems() {
        SMAppService.openSystemSettingsLoginItems()
    }
}

// MARK: - Window content

struct ContentView: View {
    @StateObject private var status = ExtensionStatus()
    @StateObject private var helper = HelperStatus()
    @StateObject private var store = SettingsStore()
    @State private var recording: ShortcutSlot?
    @State private var keyMessage: String?
    @State private var confirmClear = false
    @State private var clearRequested = false

    var body: some View {
        VStack(spacing: 0) {
            header
                .padding(.horizontal, 28)
                .padding(.top, 36)
                .padding(.bottom, 4)
            Form {
                statusSection
                switcherSection
                shortcutsSection
                dataSection
                privacySection
            }
            .formStyle(.grouped)
        }
        .frame(width: 520)
        .frame(minHeight: 520, idealHeight: 820)
        .task {
            await status.refresh()
            helper.start()
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { await status.refresh() }
            helper.refresh()
        }
        .onChange(of: recording) { _, now in
            if now != nil { keyMessage = nil }
        }
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 14) {
            Image(nsImage: NSApplication.shared.applicationIconImage)
                .resizable()
                .frame(width: 56, height: 56)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text("TabFlip")
                    .font(.largeTitle.weight(.bold))
                Text("Switch Safari tabs in the order you last used them.")
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
    }

    // MARK: Status

    private var statusSection: some View {
        Section {
            HStack(spacing: 10) {
                Image(systemName: statusSymbol)
                    .font(.title3)
                    .foregroundStyle(statusColor)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(statusTitle)
                    if let detail = statusDetail {
                        Text(detail)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer()
                Button(status.state == .enabled ? "Open Safari Settings" : "Turn On in Safari…") {
                    Task { await status.openSafariSettings() }
                }
            }
            .accessibilityElement(children: .contain)
            helperRow
        } footer: {
            VStack(alignment: .leading, spacing: 4) {
                if let error = status.openError {
                    Text("Couldn’t open Safari Settings: \(error)").foregroundStyle(.red)
                }
                if !store.isShared {
                    Text("This copy of TabFlip can’t share settings with Safari. It needs to be signed with a team in Xcode.")
                        .foregroundStyle(.red)
                }
                Text("TabFlip needs access to all websites: next to TabFlip in Safari Settings, click Edit Websites… and set Other Websites to Allow.")
                    .foregroundStyle(.secondary)
            }
            .font(.callout)
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var helperRow: some View {
        HStack(spacing: 10) {
            Image(systemName: helper.state == .running ? "keyboard.fill" : "exclamationmark.circle.fill")
                .font(.title3)
                .foregroundStyle(helper.state == .running ? Color.green : Color.orange)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                switch helper.state {
                case .running:
                    Text("Shortcuts on")
                    Text("They work anywhere in Safari, even in the address bar.")
                        .font(.callout).foregroundStyle(.secondary)
                case .needsApproval:
                    Text("Shortcuts off after restart")
                    Text("Turn on TabFlip in System Settings › General › Login Items so it opens at login.")
                        .font(.callout).foregroundStyle(.secondary)
                case .unavailable(let message):
                    Text("Shortcuts unavailable")
                    Text(message).font(.callout).foregroundStyle(.secondary)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            Spacer()
            if helper.state != .running {
                Button("Open Login Items…") { helper.openLoginItems() }
            }
        }
        .accessibilityElement(children: .contain)
    }

    // MARK: Switcher

    private var switcherSection: some View {
        Section("Switcher") {
            Toggle(isOn: $store.settings.overlay) {
                Text("Show the switcher")
                Text("When off, each press switches straight away.")
            }
            Toggle(isOn: $store.settings.previews) {
                Text("Show page previews")
                Text("Turning this off deletes the stored pictures.")
            }
            Picker("Tabs in the switcher", selection: $store.settings.maxItems) {
                ForEach(Array(TabFlipSettings.maxItemsRange), id: \.self) { n in
                    Text("\(n)").tag(n)
                }
            }
        }
    }

    // MARK: Switch shortcuts

    private var shortcutsSection: some View {
        Section {
            LabeledContent("Next recent tab") {
                ShortcutField(slot: .next, shortcut: store.settings.shortcuts.next, label: "Next recent tab",
                              recording: $recording, onRecord: record)
            }
            LabeledContent("Previous recent tab") {
                ShortcutField(slot: .prev, shortcut: store.settings.shortcuts.prev, label: "Previous recent tab",
                              recording: $recording, onRecord: record)
            }
        } header: {
            Text("Keyboard Shortcuts")
        } footer: {
            HStack(alignment: .top) {
                Group {
                    if let keyMessage {
                        Text(keyMessage).foregroundStyle(.red)
                    } else if recording != nil {
                        Text("Press the new shortcut, or Esc to cancel.").foregroundStyle(.secondary)
                    } else {
                        Text("Hold the modifier and keep tapping to go further back.")
                            .foregroundStyle(.secondary)
                    }
                }
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
                Spacer()
                Button("Restore Defaults") {
                    recording = nil
                    keyMessage = nil
                    store.settings.shortcuts = .defaults
                }
                .disabled(store.settings.shortcuts == .defaults)
            }
        }
    }

    /// Validate and save a recorded shortcut. Returns why it was refused (also shown under
    /// the section), or nil once it is saved.
    private func record(_ shortcut: Shortcut, into slot: ShortcutSlot) -> String? {
        let problem = refusal(for: shortcut, in: slot)
        keyMessage = problem
        return problem
    }

    private func refusal(for shortcut: Shortcut, in slot: ShortcutSlot) -> String? {
        guard ShortcutRules.isUsable(shortcut) else {
            return "Use Control, Option or Command with a letter, number, Tab or Space."
        }
        var pair = store.settings.shortcuts
        switch slot {
        case .next: pair.next = shortcut
        case .prev: pair.prev = shortcut
        }
        if let problem = ShortcutRules.pairProblem(pair.next, pair.prev) { return problem }
        store.settings.shortcuts = pair
        return nil
    }

    // MARK: Stored data

    private var dataSection: some View {
        Section {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Previews and history")
                    Text("Recent-tab order, site icons and page previews.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Clear…") { confirmClear = true }
                    .confirmationDialog("Clear all previews, site icons and recent-tab history?",
                                        isPresented: $confirmClear) {
                        Button("Clear", role: .destructive) {
                            store.requestClear()
                            clearRequested = true
                        }
                    } message: {
                        Text("This can’t be undone.")
                    }
            }
        } header: {
            Text("Stored Data")
        } footer: {
            if clearRequested {
                Text("TabFlip clears it as soon as you switch to Safari.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var privacySection: some View {
        Section {
            Label("Nothing leaves this Mac. No network requests, no analytics.", systemImage: "lock")
        } footer: {
            Text("Close this window when you’re done. TabFlip keeps running without an icon so the shortcuts work, and opens at login. To stop it, choose Quit TabFlip Completely from the TabFlip menu.")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: Status text

    private var statusSymbol: String {
        switch status.state {
        case .enabled: return "checkmark.circle.fill"
        case .disabled: return "exclamationmark.circle.fill"
        case .checking, .unavailable: return "questionmark.circle.fill"
        }
    }

    private var statusColor: Color {
        switch status.state {
        case .enabled: return .green
        case .disabled: return .orange
        case .checking, .unavailable: return .secondary
        }
    }

    private var statusTitle: String {
        switch status.state {
        case .checking: return "Checking…"
        case .enabled: return "Extension enabled"
        case .disabled: return "Extension turned off"
        case .unavailable: return "Status unavailable"
        }
    }

    private var statusDetail: String? {
        switch status.state {
        case .checking, .enabled:
            return nil
        case .disabled:
            return "In Safari Settings › Extensions, tick the box next to TabFlip."
        case .unavailable(let message):
            return message
        }
    }
}

// MARK: - Pieces

enum ShortcutSlot: Equatable {
    case next, prev
}

/// Click, then press keys: records a shortcut. Esc cancels; clicking again cancels.
private struct ShortcutField: View {
    let slot: ShortcutSlot
    let shortcut: Shortcut
    let label: String
    @Binding var recording: ShortcutSlot?
    /// Returns why the shortcut was refused, or nil once it is saved.
    let onRecord: (Shortcut, ShortcutSlot) -> String?

    @State private var monitor: Any?

    private var isRecording: Bool { recording == slot }

    var body: some View {
        Button {
            recording = isRecording ? nil : slot
        } label: {
            Text(isRecording ? "Type Shortcut" : ShortcutRules.display(shortcut))
                .foregroundStyle(isRecording ? .secondary : .primary)
                .frame(minWidth: 110)
                .padding(.vertical, 3)
                .padding(.horizontal, 8)
                .background(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(Color(nsColor: .controlBackgroundColor))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .strokeBorder(isRecording ? Color.accentColor : Color(nsColor: .separatorColor),
                                      lineWidth: isRecording ? 2 : 1)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityValue(isRecording ? "Recording. Press the new shortcut." : ShortcutRules.spoken(shortcut))
        .accessibilityHint("Click, then press a new shortcut.")
        .onChange(of: isRecording) { _, now in
            now ? startMonitor() : stopMonitor()
        }
        .onDisappear(perform: stopMonitor)
    }

    private func startMonitor() {
        stopMonitor()
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            if event.keyCode == 53 { // Esc
                recording = nil
                return nil
            }
            guard let code = ShortcutRules.code(forKeyCode: event.keyCode) else {
                NSSound.beep()
                return nil
            }
            let flags = event.modifierFlags
            let candidate = Shortcut(ctrl: flags.contains(.control), alt: flags.contains(.option),
                                     shift: flags.contains(.shift), meta: flags.contains(.command), code: code)
            if onRecord(candidate, slot) == nil {
                recording = nil
            } else {
                NSSound.beep()
            }
            return nil
        }
    }

    private func stopMonitor() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
    }
}

#Preview {
    ContentView()
}
