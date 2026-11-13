//
//  ContentView.swift
//  TabFlip
//
//  Onboarding window: live extension status, a button to Safari's extension
//  settings, three setup steps, the default shortcuts and a privacy note.
//

import AppKit
import Combine
import SafariServices
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

// MARK: - Window content

struct ContentView: View {
    @StateObject private var status = ExtensionStatus()

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            header
            statusCard
            steps
            shortcuts
            privacy
        }
        .padding(28)
        .frame(width: 540)
        .fixedSize(horizontal: false, vertical: true)
        .task { await status.refresh() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { await status.refresh() }
        }
    }

    // MARK: Sections

    private var header: some View {
        HStack(spacing: 14) {
            Image(nsImage: NSApplication.shared.applicationIconImage)
                .resizable()
                .frame(width: 64, height: 64)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text("TabFlip")
                    .font(.largeTitle.weight(.semibold))
                Text("Switch Safari tabs in most-recently-used order.")
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var statusCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Circle()
                    .fill(statusColor)
                    .frame(width: 10, height: 10)
                    .accessibilityHidden(true)
                Text(statusTitle)
                    .font(.headline)
                Spacer()
                Button("Open Safari Extension Settings") {
                    Task { await status.openSafariSettings() }
                }
                .controlSize(.large)
                .keyboardShortcut(.defaultAction)
            }

            if let detail = statusDetail {
                Text(detail)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let error = status.openError {
                Text("Could not open Safari Settings: \(error)")
                    .font(.callout)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(14)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
    }

    private var steps: some View {
        VStack(alignment: .leading, spacing: 12) {
            StepRow(number: 1, title: "Turn on TabFlip",
                    detail: "In Safari Settings › Extensions, tick the box next to TabFlip.")
            StepRow(number: 2, title: "Allow it on all websites",
                    detail: "Next to TabFlip, choose Edit Websites… and set Other Websites to Allow. The switcher draws on the page and needs to see when you release the key.")
            StepRow(number: 3, title: "Try the shortcut",
                    detail: "On any web page, tap ⌃Q to jump to your previous tab. Hold ⌃ and keep tapping Q to walk back through recent tabs, then let go to switch.")
        }
    }

    private var shortcuts: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Shortcuts")
                .font(.headline)
            ShortcutRow(keys: ["⌃", "Q"], label: "Flip to the previous tab (hold ⌃ to browse)")
            ShortcutRow(keys: ["⌃", "W"], label: "Close this tab and return to the previous one")
            Text("These are the default shortcuts. TabFlip's settings page in Safari shows the ones currently in effect.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
    }

    private var privacy: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label("Nothing leaves this Mac. No network requests, no analytics.", systemImage: "lock")
                .font(.callout)
            Text("Once the extension is on, you can quit this app. Safari runs TabFlip by itself.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: Status text

    private var statusColor: Color {
        switch status.state {
        case .enabled: return .green
        case .disabled: return .orange
        case .checking, .unavailable: return .gray
        }
    }

    private var statusTitle: String {
        switch status.state {
        case .checking: return "Checking…"
        case .enabled: return "Enabled in Safari"
        case .disabled: return "Not enabled in Safari"
        case .unavailable: return "Status unavailable"
        }
    }

    private var statusDetail: String? {
        switch status.state {
        case .checking, .enabled:
            return nil
        case .disabled:
            return "Not listed in Safari? A locally built copy is unsigned: turn on Allow unsigned extensions in Safari's Developer settings, then reopen this app."
        case .unavailable(let message):
            return message
        }
    }
}

// MARK: - Pieces

private struct StepRow: View {
    let number: Int
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text("\(number)")
                .font(.callout.weight(.semibold).monospacedDigit())
                .foregroundStyle(.white)
                .frame(width: 22, height: 22)
                .background(Circle().fill(Color.accentColor))
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 5 }
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.body.weight(.semibold))
                Text(detail)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Step \(number): \(title). \(detail)")
    }
}

private struct ShortcutRow: View {
    let keys: [String]
    let label: String

    var body: some View {
        HStack(spacing: 12) {
            HStack(spacing: 4) {
                ForEach(keys, id: \.self) { KeyCap(text: $0) }
            }
            .frame(width: 72, alignment: .leading)
            Text(label)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(keys.map { $0 == "⌃" ? "Control" : $0 }.joined(separator: " ") + ": " + label)
    }
}

private struct KeyCap: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(.body, design: .rounded).weight(.medium))
            .frame(minWidth: 26, minHeight: 26)
            .padding(.horizontal, 4)
            .background(
                RoundedRectangle(cornerRadius: 6)
                    .fill(Color(nsColor: .controlBackgroundColor))
                    .shadow(color: .black.opacity(0.18), radius: 0, y: 1)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 6)
                    .strokeBorder(Color(nsColor: .separatorColor))
            )
    }
}

#Preview {
    ContentView()
}
