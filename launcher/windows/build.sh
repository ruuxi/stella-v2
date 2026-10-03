#!/bin/bash
# Cross-compiles build/Stella.exe (x86_64) with MinGW-w64 (GCC 13+): a static,
# GUI-subsystem binary with the icon and Common Controls 6 manifest.
#   macOS: brew install mingw-w64    Debian/Ubuntu: apt install g++-mingw-w64-x86-64
set -euo pipefail
cd "$(dirname "$0")"
triple="${MINGW_TRIPLE:-x86_64-w64-mingw32}"
cxx="${MINGW_CXX:-$triple-g++}"
# Debian's packaged compiler defaults to win32 threads; std::thread needs posix.
if command -v "$triple-g++-posix" >/dev/null 2>&1; then cxx="$triple-g++-posix"; fi
mkdir -p build
"$triple-windres" stella-launcher.rc -O coff -o build/stella-launcher.res.o
"$cxx" -std=c++17 -O2 -Wall -Wextra -Wno-unused-parameter -Wno-cast-function-type \
  -municode -mwindows -static -static-libgcc -static-libstdc++ \
  -D_WIN32_WINNT=0x0A00 -DWINVER=0x0A00 \
  -o build/Stella.exe stella-launcher.cpp build/stella-launcher.res.o \
  -lwinhttp -lbcrypt -lcrypt32 -lcomctl32 -lole32 -loleaut32 -lshell32 -luuid -ladvapi32 -lpropsys
"$triple-strip" build/Stella.exe
echo "Built $(pwd)/build/Stella.exe"
