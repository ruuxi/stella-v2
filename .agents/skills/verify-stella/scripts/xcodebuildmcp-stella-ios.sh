#!/usr/bin/env bash
set -euo pipefail

xcodebuildmcp_version="${STELLA_XCODEBUILDMCP_VERSION:-2.7.0}"
mac_path="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

[[ "$xcodebuildmcp_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  printf 'Invalid XcodeBuildMCP version: %s\n' "$xcodebuildmcp_version" >&2
  exit 2
}

[[ "$(uname -s)" == Darwin ]] || {
  printf 'XcodeBuildMCP runs on the Mac. Move this agent to the Mac and run it there.\n' >&2
  exit 2
}

exec /bin/zsh -lc "export PATH=${mac_path}; export XCODEBUILDMCP_ENABLED_WORKFLOWS=simulator,ui-automation; export XCODEBUILDMCP_SENTRY_DISABLED=true; cd /tmp; exec npx -y xcodebuildmcp@${xcodebuildmcp_version} mcp"
