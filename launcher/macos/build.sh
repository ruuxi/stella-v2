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
icon="../../packages/desktop/build/icon.icns"
if [ -f "$icon" ]; then cp "$icon" "$app/Contents/Resources/Stella.icns"; fi

codesign --force --sign - --identifier com.stella.launcher "$app"
codesign --verify --strict --verbose=1 "$app"
lipo -info "$app/Contents/MacOS/StellaLauncher"
echo "Built $(pwd)/$app"
