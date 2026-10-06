#!/bin/bash
# Builds the universal launcher binary and assembles build/Stella.app: an
# LSUIElement bundle (no Dock icon; Electron's Stella.app is the visible app)
# with an ad-hoc signature.
set -euo pipefail
cd "$(dirname "$0")"

swift build -c release --arch arm64 --arch x86_64
bin_dir="$(swift build -c release --arch arm64 --arch x86_64 --show-bin-path)"

app="build/Stella.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin_dir/StellaLauncher" "$app/Contents/MacOS/StellaLauncher"
cp Resources/Info.plist "$app/Contents/Info.plist"
# CI's run number (0 for a local build): the launcher updates itself to a
# higher one published in launcher/stable/VERSION.
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion ${STELLA_LAUNCHER_VERSION:-0}" "$app/Contents/Info.plist"
# A self-hosted build names its own deployment (Deployment in Support.swift):
# STELLA_BACKEND_URL, STELLA_RELEASES_URL and STELLA_APPLE_TEAM_ID.
if [ -n "${STELLA_BACKEND_URL:-}" ]; then
  /usr/libexec/PlistBuddy -c "Add :StellaBackendURL string $STELLA_BACKEND_URL" "$app/Contents/Info.plist"
fi
if [ -n "${STELLA_RELEASES_URL:-}" ]; then
  /usr/libexec/PlistBuddy -c "Add :StellaReleasesURL string ${STELLA_RELEASES_URL%/}" "$app/Contents/Info.plist"
fi
if [ -n "${STELLA_APPLE_TEAM_ID:-}" ]; then
  /usr/libexec/PlistBuddy -c "Add :StellaAppleTeamID string $STELLA_APPLE_TEAM_ID" "$app/Contents/Info.plist"
fi
# The launcher window's page, sealed into the bundle by codesign.
cp ../common/launcher.html "$app/Contents/Resources/launcher.html"
icon="../../packages/desktop/build/icon.icns"
if [ -f "$icon" ]; then cp "$icon" "$app/Contents/Resources/Stella.icns"; fi

codesign --force --sign - --identifier com.stella.launcher "$app"
codesign --verify --strict --verbose=1 "$app"
lipo -info "$app/Contents/MacOS/StellaLauncher"
echo "Built $(pwd)/$app (version ${STELLA_LAUNCHER_VERSION:-0})"
