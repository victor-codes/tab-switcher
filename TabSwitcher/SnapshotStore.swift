//
//  SnapshotStore.swift
//  Tab Switcher
//
//  What the switcher panel shows: one snapshot of the recent tabs per Safari window, pushed
//  by the extension (plans/06-native-panel.md, "Push, don't ask"). They live in memory only.
//
//  Safari runs two copies of the extension's background and one of them sees no tabs, so
//  the store follows the app-side snapshot rules:
//    3. a snapshot with no items is dropped
//    4. one snapshot per window: a new one replaces it when it comes from a different
//       background instance, or from the same one with a higher `seq`; otherwise it is dropped
//    5. the current snapshot is the one with `focused: true` received most recently
//    6. everything is forgotten when Safari quits, on "Clear…", and when the panel is turned off
//

import Foundation

/// One tab in a snapshot, most recently used first.
struct PanelItem: Codable, Equatable {
    var tabId: Int
    var title: String
    var host: String
    /// A `data:image` URL, at most 8192 characters; nil in private windows.
    var icon: String?
    /// A `data:image` URL; nil in private windows.
    var preview: String?
}

struct PanelSnapshot: Codable, Equatable {
    var v: Int
    /// Which copy of the extension's background sent it.
    var instance: String
    /// Increases by 1 per push from that instance.
    var seq: Int
    var windowId: Int
    var focused: Bool
    var isPrivate: Bool
    var items: [PanelItem]

    private enum CodingKeys: String, CodingKey {
        case v, instance, seq, windowId, focused, items
        case isPrivate = "private"
    }
}

final class SnapshotStore {
    /// The snapshot format this app reads.
    static let version = 1

    private struct Entry {
        var snapshot: PanelSnapshot
        /// When it was accepted, as a counter: larger is later.
        var received: Int
    }

    private var entries: [Int: Entry] = [:]
    private var counter = 0

    /// Offers a snapshot; true when it was kept.
    @discardableResult
    func receive(_ snapshot: PanelSnapshot) -> Bool {
        guard snapshot.v == Self.version else { return false }
        guard !snapshot.items.isEmpty else { return false } // rule 3
        if let old = entries[snapshot.windowId]?.snapshot { // rule 4
            let sameInstance = old.instance == snapshot.instance
            if sameInstance && snapshot.seq <= old.seq { return false }
        }
        counter += 1
        entries[snapshot.windowId] = Entry(snapshot: snapshot, received: counter)
        return true
    }

    /// Rule 5: the focused snapshot received most recently, or nil.
    var current: PanelSnapshot? {
        entries.values.filter { $0.snapshot.focused }.max { $0.received < $1.received }?.snapshot
    }

    /// Rule 6.
    func clear() {
        entries = [:]
    }

    var count: Int { entries.count }
}
