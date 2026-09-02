#!/usr/bin/env bash
set -euo pipefail

mac_host="${STELLA_IOS_SSH_HOST:-stella-mac}"
xcodebuildmcp_version="${STELLA_XCODEBUILDMCP_VERSION:-2.7.0}"
mac_path="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
ssh_options=(-T -o BatchMode=yes -o ConnectTimeout=8)

[[ "$xcodebuildmcp_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  printf 'Invalid XcodeBuildMCP version: %s\n' "$xcodebuildmcp_version" >&2
  exit 2
}

remote_command="export PATH=${mac_path}; export XCODEBUILDMCP_ENABLED_WORKFLOWS=simulator,ui-automation; export XCODEBUILDMCP_SENTRY_DISABLED=true; cd /tmp; exec npx -y xcodebuildmcp@${xcodebuildmcp_version} mcp"
printf -v quoted_remote_command '%q' "$remote_command"

exec ssh "${ssh_options[@]}" "$mac_host" "/bin/zsh -lc $quoted_remote_command"
