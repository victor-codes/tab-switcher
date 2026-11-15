#!/bin/sh
# Runs the PanelSession table and the SnapshotStore rules 3-6 (plans/06-native-panel.md).
# Compiles the two pure files with the checks into a temp folder; needs no Xcode project.
set -e
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
swiftc -suppress-warnings -swift-version 5 -default-isolation MainActor -o "$out/panel-check" \
  "$root/TabSwitcher/PanelSession.swift" "$root/TabSwitcher/SnapshotStore.swift" \
  "$root/TabSwitcher/SwitcherView.swift" "$here/main.swift" 2>&1 || exit 1
"$out/panel-check"
