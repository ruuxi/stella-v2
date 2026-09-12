import { RELEASE_ASSETS, SITE_ORIGIN } from "@/lib/downloads";

/**
 * `curl -fsSL https://stella.sh/install.sh | sh`
 *
 * POSIX sh (no bashisms) so it runs under dash/busybox ash, which is `/bin/sh`
 * on plenty of Linux systems. Every step is idempotent: re-running replaces the
 * AppImage and its desktop entry in place, and `pacman -U` simply reinstalls.
 *
 * macOS downloads the architecture-matched DMG and opens it. Linux gets a real
 * one-click-equivalent install: on Arch (Omarchy) the native pacman package,
 * everywhere else the AppImage placed on PATH with a `.desktop` entry and icon
 * so it shows up in the application menu immediately instead of on first run
 * (see `packages/desktop/electron/linux-desktop-integration.js`, which writes
 * the same entry and is therefore a no-op after this script has run).
 */
export const INSTALL_SCRIPT = `#!/bin/sh
# Stella installer. https://stella.sh
set -eu

MAC_ARM64_DMG="${RELEASE_ASSETS["mac-arm64"]}"
MAC_X64_DMG="${RELEASE_ASSETS["mac-x64"]}"
LINUX_APPIMAGE="${RELEASE_ASSETS.linux}"
ARCH_PACKAGE="${RELEASE_ASSETS.arch}"
ICON_URL="${SITE_ORIGIN}/stella-logo.png"

DESKTOP_ID="stella-v2"

die() {
  echo "stella-install: $1" >&2
  exit 1
}

have() {
  command -v "$1" >/dev/null 2>&1
}

tmpdir=""
cleanup() {
  if [ -n "$tmpdir" ]; then
    rm -rf "$tmpdir"
  fi
}
trap cleanup EXIT INT TERM

make_tmpdir() {
  tmpdir="$(mktemp -d 2>/dev/null || mktemp -d -t stella-install)"
  if [ -z "$tmpdir" ] || [ ! -d "$tmpdir" ]; then
    die "could not create a temporary directory."
  fi
}

download() {
  if ! curl -fL --progress-bar "$1" -o "$2"; then
    die "download failed: $1"
  fi
}

run_as_root() {
  if [ "$(id -u)" = "0" ]; then
    "$@"
  elif have sudo; then
    echo "Installing with sudo; you may be prompted for your password."
    sudo "$@"
  else
    die "root privileges are required and sudo was not found. Re-run this script as root."
  fi
}

install_macos() {
  arch="$(uname -m)"
  case "$arch" in
    arm64) url="$MAC_ARM64_DMG" ;;
    x86_64) url="$MAC_X64_DMG" ;;
    *) die "unsupported macOS architecture: $arch. Visit https://stella.sh to download." ;;
  esac

  make_tmpdir
  dmg="$tmpdir/Stella.dmg"
  echo "Downloading Stella for macOS ($arch)..."
  download "$url" "$dmg"
  echo "Opening installer..."
  open "$dmg"
  # Leave the mounted image in place for Finder; skip cleanup.
  tmpdir=""
}

is_arch_linux() {
  if have pacman; then
    return 0
  fi
  if [ -f /etc/arch-release ]; then
    return 0
  fi
  return 1
}

install_arch_package() {
  if ! have pacman; then
    die "this looks like Arch Linux but pacman was not found."
  fi

  make_tmpdir
  pkg="$tmpdir/stella.pkg.tar.xz"
  echo "Downloading the Stella Arch package..."
  download "$ARCH_PACKAGE" "$pkg"
  echo "Installing Stella with pacman..."
  run_as_root pacman -U --noconfirm "$pkg"
  echo "Stella is installed. Launch it from your application menu."
}

install_appimage() {
  data_home="\${XDG_DATA_HOME:-$HOME/.local/share}"
  bin_dir="$HOME/.local/bin"
  apps_dir="$data_home/applications"
  icon_dir="$data_home/icons/hicolor/512x512/apps"
  target="$bin_dir/Stella.AppImage"
  desktop_file="$apps_dir/$DESKTOP_ID.desktop"

  if ! mkdir -p "$bin_dir" "$apps_dir" "$icon_dir"; then
    die "could not create the install directories under $HOME/.local."
  fi

  make_tmpdir
  staged="$tmpdir/Stella.AppImage"
  echo "Downloading Stella for Linux..."
  download "$LINUX_APPIMAGE" "$staged"
  chmod +x "$staged"
  if ! mv -f "$staged" "$target"; then
    die "could not write $target. Quit Stella if it is running and try again."
  fi

  # Icon and menu entry are best effort; a failure here must not fail install.
  if [ ! -f "$icon_dir/$DESKTOP_ID.png" ]; then
    curl -fsSL "$ICON_URL" -o "$icon_dir/$DESKTOP_ID.png" ||
      rm -f "$icon_dir/$DESKTOP_ID.png"
  fi

  cat > "$desktop_file" <<DESKTOP_ENTRY
[Desktop Entry]
Name=Stella
Comment=Stella desktop assistant
Exec="$target" %U
Terminal=false
Type=Application
Icon=$DESKTOP_ID
StartupWMClass=Stella
Categories=Utility;
MimeType=x-scheme-handler/stella;
X-AppImage-Integrated-By=Stella
DESKTOP_ENTRY

  if have update-desktop-database; then
    update-desktop-database "$apps_dir" >/dev/null 2>&1 || true
  fi
  if have xdg-mime; then
    xdg-mime default "$DESKTOP_ID.desktop" x-scheme-handler/stella >/dev/null 2>&1 || true
  fi

  echo "Installed Stella to $target"
  case ":$PATH:" in
    *":$bin_dir:"*)
      echo "Launch Stella from your application menu, or run: Stella.AppImage"
      ;;
    *)
      echo "Launch Stella from your application menu. ($bin_dir is not on your PATH.)"
      ;;
  esac
}

install_linux() {
  arch="$(uname -m)"
  case "$arch" in
    x86_64 | amd64) ;;
    *)
      die "Stella for Linux is published for x86_64 only (this machine is $arch). Visit https://stella.sh for details."
      ;;
  esac

  if is_arch_linux; then
    install_arch_package
  else
    install_appimage
  fi
}

if ! have curl; then
  die "curl is required to install Stella."
fi

os="$(uname -s)"
case "$os" in
  Darwin) install_macos ;;
  Linux) install_linux ;;
  *) die "unsupported operating system: $os. Visit https://stella.sh to download." ;;
esac
`;
