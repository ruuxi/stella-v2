#!/usr/bin/env bash
set -euo pipefail

skill_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
run_dir="$skill_dir/.run"
sim_state="$run_dir/ios-simulator"
source_state="$run_dir/ios-source"
mac_host="${STELLA_IOS_SSH_HOST:-stella-mac}"
mac_repo="${STELLA_IOS_MAC_REPO:-/Users/rahulnanda/projects/stella-v2}"
mac_path="/Users/rahulnanda/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
xcodebuildmcp_version="${STELLA_XCODEBUILDMCP_VERSION:-2.7.0}"
ssh_options=(-o BatchMode=yes -o ConnectTimeout=8)

usage() {
  cat <<'EOF'
Usage: .agents/skills/verify-stella/scripts/control-stella-ios.sh <command> [options]

Commands:
  doctor
  mcp-doctor
  devices
  stage
  source
  clean-source
  boot [udid]
  info
  frame --path <local-png>
  screen --path <local-png>
  click <screen-x> <screen-y>
  type <text>
  key <key-name>
  open-url <url>
  launch [bundle-id]
  logs
  shutdown
EOF
}

remote_zsh() {
  local remote_command="/bin/zsh -s --"
  local argument
  local quoted
  for argument in "$@"; do
    printf -v quoted '%q' "$argument"
    remote_command+=" $quoted"
  done
  {
    printf 'export PATH=%q\n' "$mac_path"
    /bin/cat
  } | ssh "${ssh_options[@]}" "$mac_host" "$remote_command"
}

require_repo_root() {
  git rev-parse --show-toplevel 2>/dev/null
}

read_state_value() {
  local file="$1"
  local key="$2"
  sed -n "s/^${key}=//p" "$file" | head -n 1
}

validate_udid() {
  [[ "$1" =~ ^[0-9A-Fa-f-]{36}$ ]] || {
    printf 'Invalid simulator UDID: %s\n' "$1" >&2
    exit 2
  }
}

validate_scratch_path() {
  [[ "$1" =~ ^/tmp/stella-ios-verify\.[A-Za-z0-9]+$ ]] || {
    printf 'Refusing unexpected staged path: %s\n' "$1" >&2
    exit 2
  }
}

require_screen_input() {
  if ! remote_zsh <<'REMOTE'
set -eu
test "$(/usr/bin/osascript -e 'tell application "System Events" to get UI elements enabled')" = true
/usr/bin/osascript -e 'tell application "System Events" to get name of first process whose frontmost is true' >/dev/null
test -x /opt/homebrew/bin/cliclick
REMOTE
  then
    printf 'Simulator screen input is unavailable. Grant macOS Accessibility permission before using click, type, or key.\n' >&2
    exit 3
  fi
}

command="${1:-}"
if [[ -z "$command" ]]; then
  usage
  exit 0
fi
shift

case "$command" in
  doctor)
    remote_zsh "$mac_repo" "$mac_path" "$xcodebuildmcp_version" <<'REMOTE'
set -eu
repo="$1"
export PATH="$2"
xcodebuildmcp_version="$3"
test -d "$repo/.git"
test -x /usr/bin/xcodebuild
test -x /usr/bin/xcrun
test -x /Users/rahulnanda/.bun/bin/bun
command -v node >/dev/null
command -v npx >/dev/null
device_count="$(xcrun simctl list devices available | awk '/iPhone/ { count += 1 } END { print count + 0 }')"
test "$device_count" -gt 0
mcp_version="$(cd /tmp && npx -y "xcodebuildmcp@$xcodebuildmcp_version" --version)"
test "$mcp_version" = "$xcodebuildmcp_version"
mcp_tools="$(cd /tmp && npx -y "xcodebuildmcp@$xcodebuildmcp_version" tools --json --workflow ui-automation)"
printf '%s' "$mcp_tools" | grep -Fq '"name": "snapshot-ui"'
printf '%s' "$mcp_tools" | grep -Fq '"name": "tap"'
printf '%s' "$mcp_tools" | grep -Fq '"name": "type-text"'
printf 'ssh=ok\n'
printf 'macos=%s\n' "$(sw_vers -productVersion)"
printf 'xcode=%s\n' "$(xcodebuild -version | tr '\n' ' ' | sed 's/ $//')"
printf 'bun=%s\n' "$(bun --version)"
printf 'node=%s\n' "$(node --version)"
printf 'xcodebuildmcp=%s\n' "$mcp_version"
printf 'semantic_input=yes\n'
printf 'repo=%s\n' "$repo"
printf 'repo_head=%s\n' "$(git -C "$repo" rev-parse --short HEAD)"
if test -n "$(git -C "$repo" status --porcelain)"; then
  printf 'repo_clean=no\n'
else
  printf 'repo_clean=yes\n'
fi
printf 'available_iphones=%s\n' "$device_count"
if test "$(/usr/bin/osascript -e 'tell application "System Events" to get UI elements enabled' 2>/dev/null || true)" = true \
  && test -x /opt/homebrew/bin/cliclick; then
  printf 'screen_input=yes\n'
else
  printf 'screen_input=no\n'
fi
REMOTE
    ;;
  mcp-doctor)
    remote_zsh "$xcodebuildmcp_version" <<'REMOTE'
set -eu
version="$1"
command -v node >/dev/null
command -v npx >/dev/null
actual="$(cd /tmp && npx -y "xcodebuildmcp@$version" --version)"
test "$actual" = "$version"
tools="$(cd /tmp && npx -y "xcodebuildmcp@$version" tools --json --workflow ui-automation)"
printf '%s' "$tools" | grep -Fq '"name": "snapshot-ui"'
printf '%s' "$tools" | grep -Fq '"name": "tap"'
printf '%s' "$tools" | grep -Fq '"name": "type-text"'
printf 'xcodebuildmcp=%s\n' "$actual"
printf 'mcp_transport=ssh-stdio\n'
printf 'workflows=simulator,ui-automation\n'
printf 'semantic_input=yes\n'
REMOTE
    ;;
  devices)
    remote_zsh <<'REMOTE'
set -eu
/usr/bin/xcrun simctl list devices available
REMOTE
    ;;
  stage)
    local_root="$(require_repo_root)"
    mkdir -p "$run_dir"
    if [[ -f "$source_state" ]]; then
      printf 'A staged source already exists. Run clean-source first.\n' >&2
      exit 2
    fi
    remote_source="$(remote_zsh <<'REMOTE'
set -eu
mktemp -d /tmp/stella-ios-verify.XXXXXX
REMOTE
)"
    validate_scratch_path "$remote_source"
    if ! while IFS= read -r -d '' tracked_path; do
      if [[ -e "$local_root/$tracked_path" || -L "$local_root/$tracked_path" ]]; then
        printf '%s\0' "$tracked_path"
      fi
    done < <(git -C "$local_root" ls-files -co --exclude-standard -z) \
      | tar -C "$local_root" --null -T - -czf - \
      | ssh "${ssh_options[@]}" "$mac_host" /usr/bin/tar -xzf - -C "$remote_source"; then
      remote_zsh "$remote_source" <<'REMOTE' || true
path="$1"
case "$path" in
  /tmp/stella-ios-verify.*) /bin/rm -rf -- "$path" ;;
esac
REMOTE
      exit 1
    fi
    printf 'PATH=%s\n' "$remote_source" >"$source_state"
    printf '%s\n' "$remote_source"
    ;;
  source)
    test -f "$source_state" || {
      printf 'No staged source. Run stage first.\n' >&2
      exit 2
    }
    remote_source="$(read_state_value "$source_state" PATH)"
    validate_scratch_path "$remote_source"
    printf '%s\n' "$remote_source"
    ;;
  clean-source)
    if [[ ! -f "$source_state" ]]; then
      printf 'No staged source recorded.\n'
      exit 0
    fi
    remote_source="$(read_state_value "$source_state" PATH)"
    validate_scratch_path "$remote_source"
    remote_zsh "$remote_source" <<'REMOTE'
set -eu
path="$1"
case "$path" in
  /tmp/stella-ios-verify.*) /bin/rm -rf -- "$path" ;;
  *) printf 'Refusing unexpected path: %s\n' "$path" >&2; exit 2 ;;
esac
REMOTE
    rm -f -- "$source_state"
    printf 'Removed staged source %s\n' "$remote_source"
    ;;
  boot)
    requested_udid="${1:-}"
    if [[ -n "$requested_udid" ]]; then
      validate_udid "$requested_udid"
    fi
    mkdir -p "$run_dir"
    boot_result="$(remote_zsh "$requested_udid" <<'REMOTE'
set -eu
udid="$1"
if test -z "$udid"; then
  udid="$(/usr/bin/xcrun simctl list devices available | /usr/bin/awk -F '[()]' '/iPhone/ { print $2; exit }')"
fi
test -n "$udid"
if /usr/bin/xcrun simctl list devices booted | /usr/bin/grep -Fq "$udid"; then
  started=0
else
  /usr/bin/xcrun simctl boot "$udid"
  started=1
fi
/usr/bin/xcrun simctl bootstatus "$udid" -b >&2
/usr/bin/open -a Simulator --args -CurrentDeviceUDID "$udid"
printf '%s|%s\n' "$udid" "$started"
REMOTE
)"
    boot_udid="${boot_result%%|*}"
    boot_started="${boot_result##*|}"
    validate_udid "$boot_udid"
    printf 'UDID=%s\nSTARTED=%s\n' "$boot_udid" "$boot_started" >"$sim_state"
    printf 'udid=%s\nstarted_by_helper=%s\n' "$boot_udid" "$boot_started"
    ;;
  info)
    if [[ -f "$sim_state" ]]; then
      cat "$sim_state"
    else
      printf 'simulator=not-recorded\n'
    fi
    if [[ -f "$source_state" ]]; then
      cat "$source_state"
    else
      printf 'source=not-staged\n'
    fi
    ;;
  frame|screen)
    [[ "${1:-}" == "--path" && -n "${2:-}" ]] || {
      printf '%s requires --path <local-png>\n' "$command" >&2
      exit 2
    }
    local_path="$2"
    mkdir -p "$(dirname "$local_path")"
    if [[ "$command" == "frame" ]]; then
      remote_file="$(remote_zsh <<'REMOTE'
set -eu
path="/tmp/stella-ios-frame-$$.png"
/usr/bin/xcrun simctl io booted screenshot "$path" >&2
printf '%s\n' "$path"
REMOTE
)"
    else
      remote_file="$(remote_zsh <<'REMOTE'
set -eu
path="/tmp/stella-ios-screen-$$.png"
/usr/sbin/screencapture -x "$path"
printf '%s\n' "$path"
REMOTE
)"
    fi
    [[ "$remote_file" =~ ^/tmp/stella-ios-(frame|screen)-[0-9]+\.png$ ]] || {
      printf 'Unexpected remote screenshot path: %s\n' "$remote_file" >&2
      exit 2
    }
    scp "${ssh_options[@]}" "$mac_host:$remote_file" "$local_path" >/dev/null
    remote_zsh "$remote_file" <<'REMOTE'
set -eu
path="$1"
case "$path" in
  /tmp/stella-ios-frame-*.png|/tmp/stella-ios-screen-*.png) /bin/rm -f -- "$path" ;;
  *) exit 2 ;;
esac
REMOTE
    printf '%s\n' "$local_path"
    ;;
  click)
    x="${1:-}"
    y="${2:-}"
    [[ "$x" =~ ^[0-9]+$ && "$y" =~ ^[0-9]+$ ]] || {
      printf 'click requires integer screen coordinates\n' >&2
      exit 2
    }
    require_screen_input
    remote_zsh "$x" "$y" <<'REMOTE'
set -eu
/usr/bin/osascript -e 'tell application "Simulator" to activate'
/bin/sleep 0.3
/opt/homebrew/bin/cliclick "c:$1,$2"
REMOTE
    ;;
  type)
    text="${1:-}"
    [[ -n "$text" ]] || {
      printf 'type requires text\n' >&2
      exit 2
    }
    require_screen_input
    remote_zsh "$text" <<'REMOTE'
set -eu
/usr/bin/osascript -e 'tell application "Simulator" to activate'
/bin/sleep 0.3
/opt/homebrew/bin/cliclick "t:$1"
REMOTE
    ;;
  key)
    key_name="${1:-}"
    [[ "$key_name" =~ ^[A-Za-z0-9+_-]+$ ]] || {
      printf 'key requires a cliclick key name\n' >&2
      exit 2
    }
    require_screen_input
    remote_zsh "$key_name" <<'REMOTE'
set -eu
/usr/bin/osascript -e 'tell application "Simulator" to activate'
/bin/sleep 0.3
/opt/homebrew/bin/cliclick "kp:$1"
REMOTE
    ;;
  open-url)
    url="${1:-}"
    [[ "$url" == stella-mobile://* \
      || "$url" == exp+stella-mobile://* \
      || "$url" == com.stella.mobile://expo-development-client/?url=* ]] || {
      printf 'Refusing unsupported URL scheme: %s\n' "$url" >&2
      exit 2
    }
    remote_zsh "$url" <<'REMOTE'
set -eu
/usr/bin/xcrun simctl openurl booted "$1"
REMOTE
    ;;
  launch)
    bundle_id="${1:-com.stella.mobile}"
    [[ "$bundle_id" =~ ^[A-Za-z0-9.-]+$ ]] || {
      printf 'Invalid bundle identifier\n' >&2
      exit 2
    }
    remote_zsh "$bundle_id" <<'REMOTE'
set -eu
/usr/bin/xcrun simctl launch booted "$1"
REMOTE
    ;;
  logs)
    remote_zsh <<'REMOTE'
set -eu
/usr/bin/xcrun simctl spawn booted log show --last 5m --style compact --predicate 'process == "Stella"' | /usr/bin/tail -n 300
REMOTE
    ;;
  shutdown)
    if [[ ! -f "$sim_state" ]]; then
      printf 'No simulator recorded.\n'
      exit 0
    fi
    boot_udid="$(read_state_value "$sim_state" UDID)"
    boot_started="$(read_state_value "$sim_state" STARTED)"
    validate_udid "$boot_udid"
    if [[ "$boot_started" == "1" ]]; then
      remote_zsh "$boot_udid" <<'REMOTE'
set -eu
/usr/bin/xcrun simctl shutdown "$1"
REMOTE
      printf 'Shut down %s\n' "$boot_udid"
    else
      printf 'Left pre-existing simulator %s running.\n' "$boot_udid"
    fi
    rm -f -- "$sim_state"
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
