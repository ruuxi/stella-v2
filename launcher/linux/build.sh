#!/bin/bash
# Builds build/stella-launcher. Needs a C compiler, pkg-config, GTK 3 and
# OpenSSL 3 headers (Debian: libgtk-3-dev libssl-dev; Arch: gtk3 openssl).
# libsecret is loaded at runtime when present, so it isn't a build dependency.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build
cc -O2 -g0 -Wall -Wextra -Wno-unused-parameter -Wno-deprecated-declarations \
  -o build/stella-launcher stella-launcher.c \
  $(pkg-config --cflags --libs gtk+-3.0 libcrypto) -ldl -pthread
echo "Built $(pwd)/build/stella-launcher"
