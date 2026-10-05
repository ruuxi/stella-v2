#!/bin/bash
# Builds build/stella-launcher. Needs a C compiler, pkg-config, GTK 3,
# WebKitGTK 4.1 and OpenSSL 3 headers (Debian: libgtk-3-dev
# libwebkit2gtk-4.1-dev libssl-dev; Arch: gtk3 webkit2gtk-4.1 openssl).
# libsecret is loaded at runtime when present, so it isn't a build dependency.
# The window's page, ../common/launcher.html, is embedded in the binary.
# STELLA_LAUNCHER_VERSION (CI's run number) is the version the updater compares.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build
cc -O2 -g0 -Wall -Wextra -Wno-unused-parameter -Wno-deprecated-declarations \
  -DLAUNCHER_HTML="\"$(cd ../common && pwd)/launcher.html\"" \
  -DLAUNCHER_VERSION="${STELLA_LAUNCHER_VERSION:-0}" \
  -o build/stella-launcher stella-launcher.c \
  $(pkg-config --cflags --libs gtk+-3.0 webkit2gtk-4.1 libcrypto) -ldl -pthread
echo "Built $(pwd)/build/stella-launcher"
