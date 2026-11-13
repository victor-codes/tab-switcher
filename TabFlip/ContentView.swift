//
//  ContentView.swift
//  TabFlip
//
//  The app's one window, and the only place to configure Tab Switcher: extension status,
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
        case .notRegistered: state = .unavailable("Tab Switcher isn’t set to open at login.")
        case .notFound: state = .unavailable("macOS couldn’t find this copy of Tab Switcher.")
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
        // One form that fills the window, so its scroller sits at the window's edge.
        Form {
            setupSection
            switcherSection
            shortcutsSection
            dataSection
        }
        .formStyle(.grouped)
        // The grouped form's default margins are wide for a small window; match System Settings.
        .contentMargins(.horizontal, 4, for: .scrollContent)
        .contentMargins(.top, 0, for: .scrollContent)
        .frame(width: 420)
        .frame(minHeight: 420, maxHeight: 560)
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

    // MARK: Setup

    private var setupSection: some View {
        Section {
            StatusRow(symbol: extensionSymbol, color: extensionColor, title: "Safari extension",
                      detail: extensionDetail) {
                Button(status.state == .enabled ? "Safari Settings…" : "Turn On…") {
                    Task { await status.openSafariSettings() }
                }
            }
            StatusRow(symbol: helper.state == .running ? "checkmark.circle.fill" : "exclamationmark.circle.fill",
                      color: helper.state == .running ? .green : .orange,
                      title: "Keyboard shortcuts", detail: helperDetail) {
                if helper.state != .running {
                    Button("Login Items…") { helper.openLoginItems() }
                }
            }
        } header: {
            Text("Setup")
        } footer: {
            VStack(alignment: .leading, spacing: 4) {
                if let error = status.openError {
                    Text("Couldn’t open Safari Settings: \(error)").foregroundStyle(.red)
                }
                if !store.isShared {
                    Text("This copy can’t share settings with Safari. Sign it with a team in Xcode.")
                        .foregroundStyle(.red)
                }
                Text("For the switcher to appear on pages, allow Tab Switcher on all websites: in Safari Settings › Extensions, click Edit Websites… and set Other Websites to Allow.")
                    .foregroundStyle(.secondary)
            }
            .font(.callout)
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var extensionSymbol: String {
        switch status.state {
        case .enabled: return "checkmark.circle.fill"
        case .disabled: return "exclamationmark.circle.fill"
        case .checking, .unavailable: return "questionmark.circle.fill"
        }
    }

    private var extensionColor: Color {
        switch status.state {
        case .enabled: return .green
        case .disabled: return .orange
        case .checking, .unavailable: return .secondary
        }
    }

    private var extensionDetail: String {
        switch status.state {
        case .checking: return "Checking…"
        case .enabled: return "On"
        case .disabled: return "Off. Turn on Tab Switcher in Safari Settings › Extensions."
        case .unavailable(let message): return message
        }
    }

    private var helperDetail: String {
        switch helper.state {
        case .running: return "On everywhere in Safari, even in the address bar"
        case .needsApproval: return "Off after a restart. Allow Tab Switcher in System Settings › General › Login Items."
        case .unavailable(let message): return message
        }
    }

    // MARK: Switcher

    private var switcherSection: some View {
        Section("Switcher") {
            Toggle(isOn: $store.settings.overlay) {
                Text("Show the switcher")
                Text("When off, each press goes straight to the tab.")
            }
            Toggle(isOn: $store.settings.previews) {
                Text("Show page previews")
                Text("Turning this off deletes saved previews.")
            }
            Picker("Tabs shown", selection: $store.settings.maxItems) {
                ForEach(Array(TabFlipSettings.maxItemsRange), id: \.self) { n in
                    Text("\(n)").tag(n)
                }
            }
        }
    }

    // MARK: Shortcuts

    private var shortcutsSection: some View {
        Section {
            LabeledContent("Next tab") {
                ShortcutField(slot: .next, shortcut: store.settings.shortcuts.next, label: "Next tab",
                              recording: $recording, onRecord: record)
            }
            LabeledContent("Previous tab") {
                ShortcutField(slot: .prev, shortcut: store.settings.shortcuts.prev, label: "Previous tab",
                              recording: $recording, onRecord: record)
            }
        } header: {
            Text("Shortcuts")
        } footer: {
            HStack(alignment: .firstTextBaseline) {
                Group {
                    if let keyMessage {
                        Text(keyMessage).foregroundStyle(.red)
                    } else if recording != nil {
                        Text("Press the new shortcut. Esc cancels.").foregroundStyle(.secondary)
                    } else {
                        Text("Keep holding the modifier and press again to go further back.")
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
                .controlSize(.small)
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

    // MARK: Privacy

    private var dataSection: some View {
        Section {
            LabeledContent {
                Button("Clear…") { confirmClear = true }
                    .confirmationDialog("Clear recent tabs, site icons and previews?",
                                        isPresented: $confirmClear) {
                        Button("Clear", role: .destructive) {
                            store.requestClear()
                            clearRequested = true
                        }
                    } message: {
                        Text("This can’t be undone.")
                    }
            } label: {
                Text("History")
                Text(clearRequested ? "Cleared the next time you switch to Safari."
                                    : "Recent tabs, site icons and previews")
            }
            Label("Everything stays on this Mac. No network access, no analytics.", systemImage: "lock")
                .foregroundStyle(.secondary)
        } header: {
            Text("Privacy")
        } footer: {
            Text("You can close this window. Tab Switcher keeps running without an icon and opens at login, so the shortcuts always work. To stop it, choose Tab Switcher › Quit Completely.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// A setup check: a status symbol, a title with a detail line, and an optional action.
private struct StatusRow<Trailing: View>: View {
    let symbol: String
    let color: Color
    let title: String
    let detail: String
    @ViewBuilder let trailing: Trailing

    var body: some View {
        LabeledContent {
            trailing
        } label: {
            Label {
                Text(title)
                Text(detail)
            } icon: {
                Image(systemName: symbol).foregroundStyle(color)
            }
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
            Text(isRecording ? "Press keys" : ShortcutRules.display(shortcut))
                .foregroundStyle(isRecording ? .secondary : .primary)
                .frame(minWidth: 72)
                .padding(.vertical, 2)
                .padding(.horizontal, 6)
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
