#!/bin/bash
# Packs a built Stella.app into the drag-to-Applications disk image:
#   launcher/macos/make-dmg.sh <Stella.app> <output.dmg>
# A 640x400 window with Resources/dmg-background.tiff, Stella on the left and
# Applications on the right, the app icon as the volume icon, volume "Stella".
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
app="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
out="$2"
volname="Stella"
icon="$here/../../packages/desktop/build/icon.icns"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
staging="$work/staging"
mkdir -p "$staging/.background"
ditto "$app" "$staging/Stella.app"
ln -s /Applications "$staging/Applications"
cp "$here/Resources/dmg-background.tiff" "$staging/.background/background.tiff"
rw="$work/rw.dmg"
hdiutil create -volname "$volname" -srcfolder "$staging" -fs HFS+ -format UDRW -ov "$rw" >/dev/null
attach="$(hdiutil attach -readwrite -noverify -noautoopen "$rw")"
device="$(echo "$attach" | awk '/Apple_HFS/ {print $1; exit}')"
mount="$(echo "$attach" | awk -F '\t' '/Apple_HFS/ {print $NF; exit}')"
disk="$(basename "$mount")"
detach() { hdiutil detach "$device" -quiet || hdiutil detach "$device" -force -quiet || true; }
trap 'detach; rm -rf "$work"' EXIT

osascript - "$disk" <<'APPLESCRIPT'
on run argv
  set diskName to item 1 of argv
  tell application "Finder"
    tell disk diskName
      open
      set current view of container window to icon view
      set toolbar visible of container window to false
      set statusbar visible of container window to false
      set the bounds of container window to {200, 120, 840, 548}
      set opts to the icon view options of container window
      set arrangement of opts to not arranged
      set icon size of opts to 112
      set text size of opts to 13
      set label position of opts to bottom
      set shows item info of opts to false
      set shows icon preview of opts to false
      set background picture of opts to file ".background:background.tiff"
      set position of item "Stella.app" of container window to {170, 226}
      set position of item "Applications" of container window to {470, 226}
      close
      open
      update without registering applications
      delay 2
      close
    end tell
  end tell
end run
APPLESCRIPT

if [ -f "$icon" ]; then
  cp "$icon" "$mount/.VolumeIcon.icns"
  SetFile -a C "$mount"
fi
chmod -Rf go-w "$mount" || true
rm -rf "$mount/.fseventsd"
sync
detach
trap 'rm -rf "$work"' EXIT
rm -f "$out"
hdiutil convert "$rw" -format UDZO -imagekey zlib-level=9 -o "$out" >/dev/null
echo "Built $out"
