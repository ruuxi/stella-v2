import { LAUNCHER_CHECKSUMS_URL, MAC_APP_ZIP, RELEASE_ASSETS, SITE_ORIGIN } from "@/lib/downloads";

/**
 * `curl -fsSL https://stella.sh/install.sh | sh`
 *
 * POSIX sh (no bashisms) so it runs under dash/busybox ash, which is `/bin/sh`
 * on plenty of Linux systems. It installs the native launcher, verified
 * against the published SHA256SUMS, and starts it; the launcher installs and
 * updates the app itself. Re-running replaces the launcher in place.
 *
 * Linux puts the launcher where it installs itself
 * (`$XDG_DATA_HOME/stella/bin/stella-launcher`, see
 * `launcher/linux/stella-launcher.c`), so its first-run self-copy is a no-op;
 * on that first run it writes the `stella.desktop` menu entry. macOS unpacks
 * the universal `Stella.app` into `/Applications` (or `$STELLA_APPS_DIR`,
 * falling back to `~/Applications` when `/Applications` is not writable) and
 * opens it.
 */
export const INSTALL_SCRIPT = `#!/bin/sh
# Stella installer. ${SITE_ORIGIN}
set -eu

MAC_APP_ZIP="${MAC_APP_ZIP}"
LINUX_X64="${RELEASE_ASSETS.linux}"
LINUX_ARM64="${RELEASE_ASSETS["linux-arm64"]}"
CHECKSUMS="${LAUNCHER_CHECKSUMS_URL}"

die() {
  echo "stella-install: $1" >&2
  exit 1
}

have() {
  command -v "$1" >/dev/null 2>&1
}

tmpdir=""
staged=""
cleanup() {
  if [ -n "$staged" ]; then
    rm -f "$staged"
  fi
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

sha256_of() {
  if have sha256sum; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif have shasum; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    die "sha256sum or shasum is required to verify the download."
  fi
}

# verify <file> <published name>: compare against the published SHA256SUMS.
verify() {
  sums="$tmpdir/SHA256SUMS"
  if ! curl -fsSL "$CHECKSUMS" -o "$sums"; then
    die "download failed: $CHECKSUMS"
  fi
  expected="$(awk -v name="$2" '{ file = $2; sub(/^\\*/, "", file); if (file == name) { print $1; exit } }' "$sums")"
  if [ -z "$expected" ]; then
    die "$2 is missing from SHA256SUMS."
  fi
  if [ "$(sha256_of "$1")" != "$expected" ]; then
    die "$2 failed its checksum; try again."
  fi
}

install_macos() {
  apps="\${STELLA_APPS_DIR:-/Applications}"
  if ! { mkdir -p "$apps" 2>/dev/null && [ -w "$apps" ]; }; then
    apps="$HOME/Applications"
    mkdir -p "$apps" || die "could not create $apps."
  fi

  make_tmpdir
  zip="$tmpdir/Stella-macos.zip"
  echo "Downloading Stella for macOS..."
  download "$MAC_APP_ZIP" "$zip"
  verify "$zip" Stella-macos.zip

  mkdir "$tmpdir/unpacked"
  ditto -x -k "$zip" "$tmpdir/unpacked" || die "could not unpack Stella-macos.zip."
  if [ ! -d "$tmpdir/unpacked/Stella.app" ]; then
    die "Stella-macos.zip does not contain Stella.app."
  fi
  rm -rf "$apps/Stella.app" || die "could not replace $apps/Stella.app. Quit Stella and try again."
  ditto "$tmpdir/unpacked/Stella.app" "$apps/Stella.app" || die "could not write $apps/Stella.app."

  echo "Installed Stella to $apps/Stella.app"
  open "$apps/Stella.app"
}

# The launcher's window is a WebKitGTK view; install it when it's missing.
ensure_linux_libraries() {
  if ! have ldd || ! ldd "$1" 2>/dev/null | grep -q "not found"; then
    return 0
  fi
  echo "Stella needs WebKitGTK 4.1. Installing it (this asks for your password)..."
  if have pacman; then
    sudo pacman -S --needed --noconfirm webkit2gtk-4.1 || die "could not install webkit2gtk-4.1."
  elif have apt-get; then
    sudo apt-get install -y libwebkit2gtk-4.1-0 || die "could not install libwebkit2gtk-4.1-0."
  elif have dnf; then
    sudo dnf install -y webkit2gtk4.1 || die "could not install webkit2gtk4.1."
  elif have zypper; then
    sudo zypper --non-interactive install libwebkit2gtk-4_1-0 || die "could not install libwebkit2gtk-4_1-0."
  else
    die "install WebKitGTK 4.1 with your package manager, then run this again."
  fi
}

install_linux() {
  arch="$(uname -m)"
  case "$arch" in
    x86_64 | amd64) url="$LINUX_X64"; name="stella-launcher-linux-x64" ;;
    aarch64 | arm64) url="$LINUX_ARM64"; name="stella-launcher-linux-arm64" ;;
    *)
      die "Stella for Linux is published for x86_64 and arm64 only (this machine is $arch). Visit ${SITE_ORIGIN} for details."
      ;;
  esac

  data_home="\${XDG_DATA_HOME:-$HOME/.local/share}"
  bin_dir="$data_home/stella/bin"
  target="$bin_dir/stella-launcher"
  if ! mkdir -p "$bin_dir"; then
    die "could not create $bin_dir."
  fi

  make_tmpdir
  # Staged next to the target so the final rename is atomic and safe even
  # while an older launcher is running.
  staged="$bin_dir/.stella-launcher.download"
  echo "Downloading the Stella launcher for Linux ($arch)..."
  download "$url" "$staged"
  verify "$staged" "$name"
  chmod +x "$staged"
  if ! mv -f "$staged" "$target"; then
    die "could not write $target."
  fi
  staged=""

  echo "Installed the Stella launcher to $target"
  ensure_linux_libraries "$target"
  echo "Starting Stella. It finishes installing and adds Stella to your application menu."
  nohup "$target" </dev/null >/dev/null 2>&1 &
}

if ! have curl; then
  die "curl is required to install Stella."
fi

os="$(uname -s)"
case "$os" in
  Darwin) install_macos ;;
  Linux) install_linux ;;
  *) die "unsupported operating system: $os. Visit ${SITE_ORIGIN} to download." ;;
esac
`;
