//
//  PanelSession.swift
//  Tab Switcher
//
//  The state of one switcher gesture, from the first press to the release. A pure value
//  type: inputs go in, effects come out, and ShortcutAgent carries the effects out. One
//  gesture uses one path: it is decided at the first press (plans/06-native-panel.md,
//  "Gesture, app side").
//
//    idle      nothing is going on
//    shown     the panel is up and this app tracks the selection
//    forwarded the panel is not used: presses and the release go to the extension, whose
//              in-page switcher handles them exactly as before
//

import Foundation

enum PanelInput: Equatable {
    case press(Int)
    case release
    case escape
    case click(Int)
    case safariLostFocus
    case timeout
}

enum PanelEffect: Equatable {
    case show(items: [PanelItem], selected: Int)
    case select(Int)
    case hide
    case activate(windowId: Int, tabId: Int)
    case forwardFlip(Int)
    case forwardRelease
}

struct PanelSession: Equatable {
    enum Phase: Equatable { case idle, shown, forwarded }

    private(set) var phase = Phase.idle
    private(set) var selected = 0
    private var items: [PanelItem] = []
    private var windowId = 0

    /// `snapshot` is what a press may show: pass nil when there is no usable snapshot or
    /// the setting is off. It is only read for the first press of a gesture.
    mutating func apply(_ input: PanelInput, snapshot: PanelSnapshot?) -> [PanelEffect] {
        switch phase {
        case .idle:
            guard case .press(let dir) = input else { return [] }
            guard let snapshot, !snapshot.items.isEmpty else {
                phase = .forwarded
                return [.forwardFlip(dir)]
            }
            items = snapshot.items
            windowId = snapshot.windowId
            selected = dir < 0 ? items.count - 1 : min(1, items.count - 1)
            phase = .shown
            return [.show(items: items, selected: selected)]

        case .forwarded:
            switch input {
            case .press(let dir):
                return [.forwardFlip(dir)]
            case .release:
                phase = .idle
                return [.forwardRelease]
            case .safariLostFocus, .timeout:
                // Today nothing is sent here: the page ends its own switcher.
                phase = .idle
                return []
            case .escape, .click:
                return []
            }

        case .shown:
            switch input {
            case .press(let dir):
                selected = ((selected + dir) % items.count + items.count) % items.count
                return [.select(selected)]
            case .release:
                let chosen = selected
                return finish(activating: chosen == 0 ? nil : chosen)
            case .escape, .safariLostFocus, .timeout:
                return finish(activating: nil)
            case .click(let index):
                return finish(activating: items.indices.contains(index) ? index : nil)
            }
        }
    }

    private mutating func finish(activating index: Int?) -> [PanelEffect] {
        var effects: [PanelEffect] = [.hide]
        if let index { effects.append(.activate(windowId: windowId, tabId: items[index].tabId)) }
        phase = .idle
        items = []
        selected = 0
        return effects
    }
}
