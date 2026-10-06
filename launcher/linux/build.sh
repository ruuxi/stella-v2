#!/bin/bash
# Builds build/stella-launcher. Needs a C compiler, pkg-config, GTK 3,
# WebKitGTK 4.1 and OpenSSL 3 headers (Debian: libgtk-3-dev
# libwebkit2gtk-4.1-dev libssl-dev; Arch: gtk3 webkit2gtk-4.1 openssl).
# libsecret is loaded at runtime when present, so it isn't a build dependency.
# The window's page, ../common/launcher.html, is embedded in the binary.
# STELLA_LAUNCHER_VERSION (CI's run number) is the version the updater compares.
# A self-hosted build sets STELLA_BACKEND_URL (its prod backend) and
# STELLA_RELEASES_URL (its releases bucket's public base); see SELF_HOSTING.md.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build
defaults=()
if [ -n "${STELLA_BACKEND_URL:-}" ]; then defaults+=("-DDEFAULT_BACKEND_URL=\"$STELLA_BACKEND_URL\""); fi
if [ -n "${STELLA_RELEASES_URL:-}" ]; then defaults+=("-DRELEASES_URL=\"${STELLA_RELEASES_URL%/}\""); fi
cc -O2 -g0 -Wall -Wextra -Wno-unused-parameter -Wno-deprecated-declarations \
  -DLAUNCHER_HTML="\"$(cd ../common && pwd)/launcher.html\"" \
  -DLAUNCHER_VERSION="${STELLA_LAUNCHER_VERSION:-0}" \
  ${defaults[@]+"${defaults[@]}"} \
  -o build/stella-launcher stella-launcher.c \
  $(pkg-config --cflags --libs gtk+-3.0 webkit2gtk-4.1 libcrypto) -ldl -pthread
echo "Built $(pwd)/build/stella-launcher"
