//  Checks for the switcher panel's pure parts. Run with tools/panel-check/run.sh.
//  Covers every row of the PanelSession table, SnapshotStore rules 3-6, and the layout
//  functions against values taken from extension/content/switcher.js (columnsFor, cardWidthFor).

import Foundation

var failures = 0
var checks = 0

func check(_ ok: Bool, _ what: String, line: Int = #line) {
    checks += 1
    if !ok { failures += 1; print("FAIL (line \(line)): \(what)") }
}

func item(_ id: Int) -> PanelItem { PanelItem(tabId: id, title: "t\(id)", host: "h\(id)", icon: nil, preview: nil) }

func snap(window: Int = 1, instance: String = "a", seq: Int = 1, focused: Bool = true, items: Int = 3) -> PanelSnapshot {
    PanelSnapshot(v: 1, instance: instance, seq: seq, windowId: window, focused: focused, isPrivate: false,
                  items: (0..<items).map { item(window * 100 + $0) })
}

// MARK: PanelSession table

do { // idle, usable snapshot, press(+1): show, selected = 1
    var s = PanelSession()
    let e = s.apply(.press(1), snapshot: snap(items: 3))
    check(e == [.show(items: snap(items: 3).items, selected: 1)], "press(+1) shows, selected 1")
    check(s.phase == .shown && s.selected == 1, "phase shown")
}
do { // only one item: selected 0
    var s = PanelSession()
    let e = s.apply(.press(1), snapshot: snap(items: 1))
    check(e == [.show(items: snap(items: 1).items, selected: 0)], "one item: selected 0")
}
do { // press(-1): last
    var s = PanelSession()
    let e = s.apply(.press(-1), snapshot: snap(items: 5))
    check(e == [.show(items: snap(items: 5).items, selected: 4)], "press(-1) selects last")
}
do { // idle, no usable snapshot: forward, gesture is forwarded
    var s = PanelSession()
    check(s.apply(.press(1), snapshot: nil) == [.forwardFlip(1)], "no snapshot forwards flip")
    check(s.phase == .forwarded, "phase forwarded")
    // forwarded: press / release
    check(s.apply(.press(-1), snapshot: snap()) == [.forwardFlip(-1)], "forwarded press forwards even with a snapshot now")
    check(s.phase == .forwarded, "still forwarded")
    check(s.apply(.release, snapshot: nil) == [.forwardRelease], "forwarded release forwards")
    check(s.phase == .idle, "back to idle on release")
    // forwarded, safari loses focus / timeout: nothing sent, idle
    _ = s.apply(.press(1), snapshot: nil)
    check(s.apply(.safariLostFocus, snapshot: nil).isEmpty && s.phase == .idle, "forwarded + lost focus: nothing")
    _ = s.apply(.press(1), snapshot: nil)
    check(s.apply(.timeout, snapshot: nil).isEmpty && s.phase == .idle, "forwarded + timeout: nothing")
}
do { // an empty snapshot is not usable
    var s = PanelSession()
    check(s.apply(.press(1), snapshot: snap(items: 0)) == [.forwardFlip(1)], "empty snapshot forwards")
}
do { // shown, press: select wrapped
    var s = PanelSession()
    _ = s.apply(.press(1), snapshot: snap(items: 3))
    check(s.apply(.press(1), snapshot: nil) == [.select(2)], "press(+1) 1 -> 2")
    check(s.apply(.press(1), snapshot: nil) == [.select(0)], "press(+1) wraps to 0")
    check(s.apply(.press(-1), snapshot: nil) == [.select(2)], "press(-1) wraps to last")
    check(s.apply(.press(-1), snapshot: nil) == [.select(1)], "press(-1) 2 -> 1")
}
do { // the snapshot is read once per gesture
    var s = PanelSession()
    _ = s.apply(.press(1), snapshot: snap(window: 7, items: 3))
    _ = s.apply(.press(1), snapshot: snap(window: 9, items: 2))
    let e = s.apply(.release, snapshot: nil)
    check(e == [.hide, .activate(windowId: 7, tabId: 702)], "uses the first snapshot: \(e)")
}
do { // shown, release, selected != 0: hide, activate
    var s = PanelSession()
    _ = s.apply(.press(1), snapshot: snap(window: 4, items: 3))
    check(s.apply(.release, snapshot: nil) == [.hide, .activate(windowId: 4, tabId: 401)], "release activates selection")
    check(s.phase == .idle, "idle after release")
}
do { // shown, release, selected = 0: hide only
    var s = PanelSession()
    _ = s.apply(.press(1), snapshot: snap(items: 3))
    _ = s.apply(.press(-1), snapshot: nil)
    check(s.selected == 0, "back on item 0")
    check(s.apply(.release, snapshot: nil) == [.hide], "release on item 0 only hides")
    var one = PanelSession()
    _ = one.apply(.press(1), snapshot: snap(items: 1))
    check(one.apply(.release, snapshot: nil) == [.hide], "single item release only hides")
}
for input in [PanelInput.escape, .safariLostFocus, .timeout] { // shown: hide
    var s = PanelSession()
    _ = s.apply(.press(1), snapshot: snap(items: 3))
    check(s.apply(input, snapshot: nil) == [.hide], "\(input) hides")
    check(s.phase == .idle, "\(input) -> idle")
    check(s.apply(.release, snapshot: nil).isEmpty, "release after \(input) does nothing")
}
do { // shown, click(i): hide, activate item i
    var s = PanelSession()
    _ = s.apply(.press(1), snapshot: snap(window: 2, items: 4))
    check(s.apply(.click(3), snapshot: nil) == [.hide, .activate(windowId: 2, tabId: 203)], "click activates item")
    check(s.phase == .idle, "idle after click")
    _ = s.apply(.press(1), snapshot: snap(window: 2, items: 4))
    check(s.apply(.click(9), snapshot: nil) == [.hide], "click out of range only hides")
}
do { // shown, hover(i): the pointer moves the selection; release then activates it
    var s = PanelSession()
    _ = s.apply(.press(1), snapshot: snap(window: 2, items: 4))
    check(s.apply(.hover(3), snapshot: nil) == [.select(3)], "hover selects the card")
    check(s.apply(.hover(3), snapshot: nil).isEmpty, "hover on the selected card does nothing")
    check(s.apply(.hover(9), snapshot: nil).isEmpty, "hover out of range does nothing")
    check(s.apply(.release, snapshot: nil) == [.hide, .activate(windowId: 2, tabId: 203)], "release activates the hovered card")
    var f = PanelSession()
    _ = f.apply(.press(1), snapshot: nil)
    check(f.apply(.hover(1), snapshot: nil).isEmpty, "hover does nothing when forwarded")
}
do { // idle ignores everything but press
    var s = PanelSession()
    for input in [PanelInput.release, .escape, .click(0), .hover(0), .safariLostFocus, .timeout] {
        check(s.apply(input, snapshot: snap()).isEmpty && s.phase == .idle, "idle ignores \(input)")
    }
}
do { // after a gesture, the next one decides again
    var s = PanelSession()
    _ = s.apply(.press(1), snapshot: nil)
    _ = s.apply(.release, snapshot: nil)
    check(s.apply(.press(1), snapshot: snap(items: 2)) == [.show(items: snap(items: 2).items, selected: 1)], "next gesture can use the panel")
}

// MARK: SnapshotStore rules 3-6

do { // rule 3: no items dropped
    let st = SnapshotStore()
    check(!st.receive(snap(items: 0)), "empty dropped")
    check(st.current == nil && st.count == 0, "nothing stored")
}
do { // rule 4
    let st = SnapshotStore()
    check(st.receive(snap(instance: "a", seq: 5)), "first kept")
    check(!st.receive(snap(instance: "a", seq: 5)), "same instance, same seq dropped")
    check(!st.receive(snap(instance: "a", seq: 4)), "same instance, lower seq dropped")
    check(st.receive(snap(instance: "a", seq: 6, items: 2)) && st.current?.items.count == 2, "same instance, higher seq replaces")
    check(st.receive(snap(instance: "b", seq: 1, items: 4)) && st.current?.items.count == 4, "different instance replaces, even with a lower seq")
    check(st.count == 1, "one snapshot per window")
    check(st.receive(snap(window: 2, instance: "a", seq: 1)) && st.count == 2, "another window is kept separately")
    check(!st.receive(snap(instance: "b", seq: 1, items: 4)) , "after the swap, old seq from b is dropped")
}
do { // the empty background cannot overwrite the real one
    let st = SnapshotStore()
    st.receive(snap(instance: "real", seq: 3, items: 4))
    st.receive(snap(instance: "empty", seq: 1, items: 0))
    check(st.current?.instance == "real" && st.current?.items.count == 4, "empty background does not overwrite")
}
do { // rule 5
    let st = SnapshotStore()
    st.receive(snap(window: 1, focused: true))
    st.receive(snap(window: 2, focused: true))
    check(st.current?.windowId == 2, "most recently received focused one is current")
    st.receive(snap(window: 1, seq: 2, focused: true))
    check(st.current?.windowId == 1, "a newer focused push moves current")
    st.receive(snap(window: 1, seq: 3, focused: false))
    check(st.current?.windowId == 2, "unfocused window is not current")
    st.receive(snap(window: 2, seq: 2, focused: false))
    check(st.current == nil, "no focused snapshot: no current")
    let other = SnapshotStore()
    other.receive(snap(window: 1, focused: false))
    check(other.current == nil, "only unfocused snapshots: no current")
}
do { // rule 6
    let st = SnapshotStore()
    st.receive(snap())
    st.clear()
    check(st.current == nil && st.count == 0, "clear forgets everything")
    check(st.receive(snap(seq: 1)), "a cleared window accepts seq 1 again")
}
do { // unknown version dropped; JSON round trip with the wire name "private"
    let st = SnapshotStore()
    var v2 = snap(); v2.v = 2
    check(!st.receive(v2), "unknown version dropped")
    let json = #"{"v":1,"instance":"x","seq":1,"windowId":3,"focused":true,"private":true,"items":[{"tabId":1,"title":"a","host":"b","icon":null,"preview":null}]}"#
    let decoded = try? JSONDecoder().decode(PanelSnapshot.self, from: Data(json.utf8))
    check(decoded?.isPrivate == true && decoded?.items.first?.icon == nil, "decodes the plan's snapshot JSON")
}

// MARK: Layout against switcher.js

let expected: [(Int, Double, Int, Double)] = [(0, 300, 1, 196), (0, 500, 1, 196), (0, 700, 1, 196), (0, 1000, 1, 196), (0, 1291, 1, 196), (0, 2000, 1, 196), (1, 300, 1, 196), (1, 500, 1, 196), (1, 700, 1, 196), (1, 1000, 1, 196), (1, 1291, 1, 196), (1, 2000, 1, 196), (2, 300, 1, 196), (2, 500, 2, 196), (2, 700, 2, 196), (2, 1000, 2, 196), (2, 1291, 2, 196), (2, 2000, 2, 196), (3, 300, 1, 196), (3, 500, 2, 196), (3, 700, 3, 196), (3, 1000, 3, 196), (3, 1291, 3, 196), (3, 2000, 3, 196), (4, 300, 1, 196), (4, 500, 2, 196), (4, 700, 4, 159), (4, 1000, 4, 196), (4, 1291, 4, 196), (4, 2000, 4, 196), (5, 300, 1, 196), (5, 500, 2, 196), (5, 700, 3, 196), (5, 1000, 5, 186), (5, 1291, 5, 196), (5, 2000, 5, 196), (7, 300, 1, 196), (7, 500, 2, 196), (7, 700, 4, 159), (7, 1000, 4, 196), (7, 1291, 4, 196), (7, 2000, 4, 196), (8, 300, 1, 196), (8, 500, 2, 196), (8, 700, 4, 159), (8, 1000, 4, 196), (8, 1291, 4, 196), (8, 2000, 4, 196), (9, 300, 1, 196), (9, 500, 2, 196), (9, 700, 3, 196), (9, 1000, 5, 186), (9, 1291, 5, 196), (9, 2000, 5, 196), (12, 300, 1, 196), (12, 500, 2, 196), (12, 700, 4, 159), (12, 1000, 4, 196), (12, 1291, 4, 196), (12, 2000, 4, 196), (30, 300, 1, 196), (30, 500, 2, 196), (30, 700, 4, 159), (30, 1000, 5, 186), (30, 1291, 5, 196), (30, 2000, 5, 196)]
for (n, width, cols, cw) in expected {
    let c = SwitcherLayout.columnsFor(n, width)
    check(c == cols, "columnsFor(\(n), \(width)) = \(c), JS says \(cols)")
    check(SwitcherLayout.cardWidthFor(c, width) == cw, "cardWidthFor(\(c), \(width)) = \(SwitcherLayout.cardWidthFor(c, width)), JS says \(cw)")
}

print("\(checks) checks, \(failures) failed")
exit(failures == 0 ? 0 : 1)
