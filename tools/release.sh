#!/usr/bin/env bash
# Build Tab Switcher, package it as a zip (for Homebrew) and a DMG (for the website), and
# update the Homebrew cask.
#
#   tools/release.sh 1.0.1             build + zip + update cask locally (nothing pushed)
#   tools/release.sh 1.0.1 --publish   also tag, create the GitHub release, and push the tap
#
# Environment:
#   TAP_DIR          path to the homebrew-tap checkout (default: ../../homebrew-tap next to this repo)
#   NOTARY_PROFILE   notarytool keychain profile. When set, the app is exported with
#                    Developer ID signing and notarized (needs a paid Apple Developer account).
#                    When unset, the Release build keeps its Apple Development signature.
set -euo pipefail

VERSION="${1:-}"
PUBLISH=0
[[ "${2:-}" == "--publish" ]] && PUBLISH=1
if [[ ! "$VERSION" =~ ^[0-9]+(\.[0-9]+){1,2}$ ]]; then
  echo "usage: $0 <version, e.g. 1.0.1> [--publish]" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAP_DIR="${TAP_DIR:-$ROOT/../homebrew-tap}"
CASK="$TAP_DIR/Casks/tab-switcher.rb"
REPO="victor-codes/tab-switcher"
APP_NAME="Tab Switcher.app"
OUT="$ROOT/build/release"
ZIP="$OUT/TabSwitcher-$VERSION.zip"
DMG="$OUT/TabSwitcher-$VERSION.dmg"
TAG="v$VERSION"

cd "$ROOT"
[[ -f "$CASK" ]] || { echo "cask not found: $CASK (set TAP_DIR)" >&2; exit 1; }

if (( PUBLISH )); then
  [[ -z "$(git status --porcelain)" ]] || { echo "working tree not clean; commit first" >&2; exit 1; }
  git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "tag $TAG already exists" >&2; exit 1; }
fi

rm -rf "$OUT"
mkdir -p "$OUT"

# Build number: commit count, so every release increases it.
BUILD_NUMBER="$(git rev-list --count HEAD)"

if [[ -n "${NOTARY_PROFILE:-}" ]]; then
  echo "==> Archiving (Developer ID)"
  xcodebuild -project TabSwitcher.xcodeproj -scheme TabSwitcher -configuration Release -destination "generic/platform=macOS" \
    -archivePath "$OUT/Tab Switcher.xcarchive" \
    MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
    archive -quiet
  cat > "$OUT/ExportOptions.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyLists-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>developer-id</string>
  <key>signingStyle</key><string>automatic</string>
</dict>
</plist>
PLIST
  xcodebuild -exportArchive -archivePath "$OUT/Tab Switcher.xcarchive" \
    -exportOptionsPlist "$OUT/ExportOptions.plist" -exportPath "$OUT/export" -quiet
  APP="$OUT/export/$APP_NAME"

  echo "==> Notarizing"
  ditto -c -k --keepParent "$APP" "$OUT/notarize.zip"
  xcrun notarytool submit "$OUT/notarize.zip" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$APP"
  rm "$OUT/notarize.zip"
else
  echo "==> Building Release (Apple Development signing, not notarized)"
  xcodebuild -project TabSwitcher.xcodeproj -scheme TabSwitcher -configuration Release -destination "generic/platform=macOS" \
    -derivedDataPath "$OUT/DerivedData" \
    MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
    build -quiet
  APP="$OUT/DerivedData/Build/Products/Release/$APP_NAME"
fi

codesign --verify --deep --strict "$APP"

LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

echo "==> Zipping"
ditto -c -k --keepParent "$APP" "$ZIP"
SHA="$(shasum -a 256 "$ZIP" | awk '{print $1}')"

echo "==> Making DMG"
# The usual drag-to-install window: the app next to a link to /Applications.
STAGE="$OUT/dmg"
mkdir -p "$STAGE"
ditto "$APP" "$STAGE/$APP_NAME"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Tab Switcher" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$DMG" -quiet
"$LSREGISTER" -u "$STAGE/$APP_NAME" >/dev/null 2>&1 || true
rm -rf "$STAGE"
if [[ -n "${NOTARY_PROFILE:-}" ]]; then
  echo "==> Notarizing DMG"
  codesign --sign "Developer ID Application" --timestamp "$DMG"
  xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$DMG"
fi

# The built app must not stay on disk: macOS registers it, and Safari then lists a second
# Tab Switcher extension next to the installed one.
"$LSREGISTER" -u "$APP" >/dev/null 2>&1 || true
rm -rf "$OUT/DerivedData" "$OUT/export" "$OUT/Tab Switcher.xcarchive"

echo "==> Updating cask"
sed -i '' -E \
  -e "s/^  version \".*\"/  version \"$VERSION\"/" \
  -e "s/^  sha256 \".*\"/  sha256 \"$SHA\"/" \
  "$CASK"

echo
echo "zip:    $ZIP"
echo "dmg:    $DMG"
echo "sha256: $SHA"

if (( PUBLISH )); then
  echo "==> Publishing $TAG"
  git tag -a "$TAG" -m "Tab Switcher $VERSION"
  git push origin "$TAG"
  gh release create "$TAG" "$ZIP" "$DMG" --repo "$REPO" --title "Tab Switcher $VERSION" --generate-notes
  git -C "$TAP_DIR" add Casks/tab-switcher.rb
  git -C "$TAP_DIR" commit -m "tab-switcher $VERSION"
  git -C "$TAP_DIR" push
  echo
  echo "Done. Install with: brew tap victor-codes/tap && brew trust victor-codes/tap && brew install --cask tab-switcher"
else
  echo
  echo "Local only. Run again with --publish to tag, release and push the tap."
fi
