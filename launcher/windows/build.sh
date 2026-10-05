#!/bin/bash
# Cross-compiles build/Stella.exe (x86_64) with MinGW-w64 (GCC 13+): a static,
# GUI-subsystem binary with the icon, the Common Controls 6 manifest and the
# launcher page (launcher/common/launcher.html) embedded.
#   macOS: brew install mingw-w64    Debian/Ubuntu: apt install g++-mingw-w64-x86-64 curl unzip
set -euo pipefail
cd "$(dirname "$0")"
triple="${MINGW_TRIPLE:-x86_64-w64-mingw32}"
cxx="${MINGW_CXX:-$triple-g++}"
# Debian's packaged compiler defaults to win32 threads; std::thread needs posix.
if command -v "$triple-g++-posix" >/dev/null 2>&1; then cxx="$triple-g++-posix"; fi
mkdir -p build/include

# WebView2's COM interfaces: only WebView2.h, from the pinned NuGet package.
# Stella.exe finds the installed runtime itself, so no WebView2Loader.dll.
webview2_version=1.0.4258.31
webview2_sha256=56f7f4b8bf9aee4b8efefbbdd4f67d5f74ebd1b100ed0806da71bf76af481aa9
if [ "$(cat build/include/WebView2.version 2>/dev/null)" != "$webview2_version" ]; then
  curl -fsSL -o build/webview2.nupkg "https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/$webview2_version"
  actual="$( (sha256sum 2>/dev/null || shasum -a 256) < build/webview2.nupkg | cut -d' ' -f1)"
  if [ "$actual" != "$webview2_sha256" ]; then
    echo "Microsoft.Web.WebView2 $webview2_version: sha256 $actual, expected $webview2_sha256" >&2
    exit 1
  fi
  unzip -o -j -q build/webview2.nupkg build/native/include/WebView2.h -d build/include
  rm build/webview2.nupkg
  echo "$webview2_version" > build/include/WebView2.version
fi
# WebView2.h includes the Windows SDK's EventToken.h, which MinGW-w64 lacks.
printf '%s\n' '#pragma once' 'typedef struct EventRegistrationToken { __int64 value; } EventRegistrationToken;' \
  > build/include/EventToken.h

"$triple-windres" stella-launcher.rc -O coff -o build/stella-launcher.res.o
"$cxx" -std=c++17 -O2 -Wall -Wextra -Wno-unused-parameter -Wno-cast-function-type -isystem build/include \
  -municode -mwindows -static -static-libgcc -static-libstdc++ \
  -D_WIN32_WINNT=0x0A00 -DWINVER=0x0A00 \
  -o build/Stella.exe stella-launcher.cpp build/stella-launcher.res.o \
  -lwinhttp -lbcrypt -lcrypt32 -lcomctl32 -lole32 -loleaut32 -lshell32 -lshlwapi -luuid -ladvapi32 -lpropsys -ldwmapi
"$triple-strip" build/Stella.exe
echo "Built $(pwd)/build/Stella.exe"
