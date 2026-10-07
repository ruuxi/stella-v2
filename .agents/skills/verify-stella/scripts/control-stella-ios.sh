#!/usr/bin/env bash
set -euo pipefail

skill_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd -P "$skill_dir/../../.." && pwd)"
run_dir="$skill_dir/.run"
sim_state="$run_dir/ios-simulator"
source_state="$run_dir/ios-source"
xcodebuildmcp_version="${STELLA_XCODEBUILDMCP_VERSION:-2.7.0}"
system_path="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
mac_repo="${STELLA_IOS_MAC_REPO:-$repo_root}"
mac_path="$HOME/.bun/bin:$system_path"

usage() {
  cat <<'EOF'
Usage: .agents/skills/verify-stella/scripts/control-stella-ios.sh <command> [options]

Runs on the Mac. An agent elsewhere moves itself to the Mac for iOS work.

Commands:
  doctor
  mcp-doctor
  devices
  stage
  source
  clean-source
  boot [udid]
  build [--no-bundler] [--metro-only] [--port <port>]
  sign-in [--plan pro|go|free] [--email <name>@test.stella.local]
  info
  app-status [bundle-id]
  uninstall [bundle-id]
  derived-data [--remove]
  frame --path <local-png>
  screen --path <local-png>
  windows
  click <screen-x> <screen-y>
  type <text>
  key <key-name>
  open-url <url>
  launch [bundle-id]
  logs
  shutdown
EOF
}

if [[ "$(uname -s)" != Darwin && "${1:-}" != "" ]]; then
  printf 'control-stella-ios runs on the Mac. Move this agent to the Mac and run it there.\n' >&2
  exit 2
fi

run_zsh() {
  {
    printf 'export PATH=%q\n' "$mac_path"
    /bin/cat
  } | /bin/zsh -s -- "$@"
}

target_udid() {
  local recorded=""
  if [[ -f "$sim_state" ]]; then
    recorded="$(read_state_value "$sim_state" UDID)"
  fi
  if [[ -n "$recorded" ]]; then
    printf '%s\n' "$recorded"
  else
    printf 'booted\n'
  fi
}

open_url() {
  run_zsh "$1" "$(target_udid)" <<'REMOTE'
set -eu
/usr/bin/xcrun simctl openurl "$2" "$1"
REMOTE
}

require_repo_root() {
  git -C "$repo_root" rev-parse --show-toplevel 2>/dev/null
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

require_free_disk() {
  local min_free_gb="$1"
  local free_gb
  free_gb="$(run_zsh <<'REMOTE'
set -eu
/bin/df -g / | /usr/bin/awk 'NR == 2 { print $4 }'
REMOTE
)"
  [[ "$free_gb" =~ ^[0-9]+$ ]] || {
    printf 'Could not read free disk space on the Mac.\n' >&2
    exit 3
  }
  if (( free_gb < min_free_gb )); then
    printf 'Only %s GB free on the Mac; a native build needs about %s GB and filling the disk breaks every tool on it.\nUse `build --metro-only` against the already-installed development build, or free space first (STELLA_IOS_MIN_FREE_GB overrides this floor).\n' "$free_gb" "$min_free_gb" >&2
    exit 3
  fi
}

require_screen_input() {
  if ! run_zsh <<'REMOTE'
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
    run_zsh "$mac_repo" "$mac_path" "$xcodebuildmcp_version" <<'REMOTE'
set -eu
repo="$1"
export PATH="$2"
xcodebuildmcp_version="$3"
test -d "$repo/.git"
test -x /usr/bin/xcodebuild
test -x /usr/bin/xcrun
command -v bun >/dev/null
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
    run_zsh "$xcodebuildmcp_version" <<'REMOTE'
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
printf 'mcp_transport=local-stdio\n'
printf 'workflows=simulator,ui-automation\n'
printf 'semantic_input=yes\n'
REMOTE
    ;;
  devices)
    run_zsh <<'REMOTE'
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
    remote_source="$(run_zsh <<'REMOTE'
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
      | /usr/bin/tar -xzf - -C "$remote_source"; then
      run_zsh "$remote_source" <<'REMOTE' || true
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
    run_zsh "$remote_source" <<'REMOTE'
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
    boot_result="$(run_zsh "$requested_udid" <<'REMOTE'
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
  build)
    no_bundler=""
    metro_only=""
    metro_port="8081"
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --no-bundler) no_bundler="--no-bundler" ;;
        --metro-only) metro_only="1" ;;
        --port)
          metro_port="${2:-}"
          [[ "$metro_port" =~ ^[0-9]{2,5}$ ]] || {
            printf '--port requires a port number\n' >&2
            exit 2
          }
          shift
          ;;
        *)
          printf 'Unknown build option: %s\n' "$1" >&2
          exit 2
          ;;
      esac
      shift
    done
    test -f "$source_state" || {
      printf 'No staged source. Run stage first.\n' >&2
      exit 2
    }
    test -f "$sim_state" || {
      printf 'No simulator recorded. Run boot first.\n' >&2
      exit 2
    }
    remote_source="$(read_state_value "$source_state" PATH)"
    validate_scratch_path "$remote_source"
    boot_udid="$(read_state_value "$sim_state" UDID)"
    validate_udid "$boot_udid"
    backend_url="${STELLA_BACKEND_URL:-https://stella-v2-cloud-builder-dev.lolruuxi.workers.dev}"
    if [[ -z "$metro_only" ]]; then
      require_free_disk "${STELLA_IOS_MIN_FREE_GB:-30}"
    fi
    run_zsh "$mac_repo" "$remote_source" "$boot_udid" "$backend_url" "$no_bundler" "$metro_only" "$metro_port" <<'REMOTE'
set -eu
export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8
repo="$1"
staged="$2"
udid="$3"
backend="$4"
no_bundler="$5"
metro_only="$6"
metro_port="$7"
env_file="$repo/packages/mobile/.env.local"
if test -f "$env_file"; then
  set -a
  . "$env_file"
  set +a
fi
export EXPO_PUBLIC_STELLA_BACKEND_URL="$backend"
cd "$staged"
bun install --frozen-lockfile
cd packages/mobile
bun run i18n:sync
if test -n "$metro_only"; then
  exec bunx expo start --dev-client --port "$metro_port"
fi
bunx expo prebuild -p ios --no-install
exec bunx expo run:ios --device "$udid" ${no_bundler:+--no-bundler}
REMOTE
    ;;
  sign-in)
    minted="$(node "$skill_dir/scripts/mobile-test-session.mjs" "$@")"
    url="$(printf '%s' "$minted" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).url)')"
    [[ "$url" == stella-mobile://dev-test-session\?ott=* ]] || {
      printf 'Unexpected sign-in link.\n' >&2
      exit 2
    }
    open_url "$url"
    printf '%s' "$minted" | node -e 'const p = JSON.parse(require("fs").readFileSync(0, "utf8")); process.stdout.write(`email=${p.email}\nowner_id=${p.ownerId}\nplan=${p.plan}\n`)'
    ;;
  info)
    printf 'mac_repo=%s\n' "$mac_repo"
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
  app-status)
    bundle_id="${1:-com.stella.mobile}"
    [[ "$bundle_id" =~ ^[A-Za-z0-9.-]+$ ]] || {
      printf 'Invalid bundle identifier\n' >&2
      exit 2
    }
    run_zsh "$bundle_id" "$(target_udid)" <<'REMOTE'
set -eu
bundle="$1"
udid="$2"
if container="$(/usr/bin/xcrun simctl get_app_container "$udid" "$bundle" 2>/dev/null)"; then
  printf 'installed=yes\nbundle_path=%s\n' "$container"
  printf 'bundle_built=%s\n' "$(/bin/date -r "$container" '+%Y-%m-%dT%H:%M:%S')"
  data="$(/usr/bin/xcrun simctl get_app_container "$udid" "$bundle" data 2>/dev/null || true)"
  if test -n "$data"; then
    printf 'data_path=%s\n' "$data"
    printf 'data_changed=%s\n' "$(/bin/date -r "$data" '+%Y-%m-%dT%H:%M:%S')"
  fi
else
  printf 'installed=no\n'
fi
REMOTE
    ;;
  uninstall)
    bundle_id="${1:-com.stella.mobile}"
    [[ "$bundle_id" =~ ^[A-Za-z0-9.-]+$ ]] || {
      printf 'Invalid bundle identifier\n' >&2
      exit 2
    }
    test -f "$sim_state" || {
      printf 'No simulator recorded. Run boot first.\n' >&2
      exit 2
    }
    boot_udid="$(read_state_value "$sim_state" UDID)"
    validate_udid "$boot_udid"
    run_zsh "$bundle_id" "$boot_udid" <<'REMOTE'
set -eu
/usr/bin/xcrun simctl uninstall "$2" "$1"
REMOTE
    printf 'uninstalled=%s\nudid=%s\n' "$bundle_id" "$boot_udid"
    ;;
  derived-data)
    remove=""
    if [[ "${1:-}" == "--remove" ]]; then
      remove="1"
    elif [[ -n "${1:-}" ]]; then
      printf 'Unknown derived-data option: %s\n' "$1" >&2
      exit 2
    fi
    test -f "$source_state" || {
      printf 'No staged source recorded; the staged path is how owned DerivedData is identified.\n' >&2
      exit 2
    }
    remote_source="$(read_state_value "$source_state" PATH)"
    validate_scratch_path "$remote_source"
    run_zsh "$remote_source" "$remove" <<'REMOTE'
set -eu
setopt null_glob
staged="$1"
remove="$2"
root="$HOME/Library/Developer/Xcode/DerivedData"
if ! test -d "$root"; then
  printf 'derived_data=none\n'
  exit 0
fi
found=0
for dir in "$root"/*/; do
  plist="${dir}info.plist"
  test -f "$plist" || continue
  workspace="$(/usr/bin/plutil -extract WorkspacePath raw -o - "$plist" 2>/dev/null || true)"
  case "$workspace" in
    "$staged"/*)
      found=1
      printf 'derived_data=%s\nsize=%s\nworkspace=%s\n' "${dir%/}" "$(/usr/bin/du -sh "$dir" | /usr/bin/awk '{ print $1 }')" "$workspace"
      if test -n "$remove"; then
        /bin/rm -rf -- "${dir%/}"
        printf 'removed=%s\n' "${dir%/}"
      fi
      ;;
  esac
done
test "$found" = 1 || printf 'derived_data=none\n'
REMOTE
    ;;
  frame|screen)
    [[ "${1:-}" == "--path" && -n "${2:-}" ]] || {
      printf '%s requires --path <local-png>\n' "$command" >&2
      exit 2
    }
    local_path="$2"
    mkdir -p "$(dirname "$local_path")"
    if [[ "$command" == "frame" ]]; then
      remote_file="$(run_zsh "$(target_udid)" <<'REMOTE'
set -eu
path="/tmp/stella-ios-frame-$$.png"
/usr/bin/xcrun simctl io "$1" screenshot "$path" >&2
printf '%s\n' "$path"
REMOTE
)"
    else
      remote_file="$(run_zsh <<'REMOTE'
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
    /bin/cp -- "$remote_file" "$local_path"
    if [[ "$command" == "screen" ]]; then
      screen_metrics="$(run_zsh "$remote_file" <<'REMOTE'
set -eu
/usr/bin/sips -g pixelWidth -g pixelHeight "$1" | /usr/bin/awk '/pixelWidth/ { w = $2 } /pixelHeight/ { h = $2 } END { printf "%d %d\n", w, h }'
/usr/bin/osascript -e 'tell application "Finder" to get bounds of window of desktop' | /usr/bin/awk -F'[ ,]+' '{ printf "%d %d\n", $3, $4 }'
REMOTE
)"
      pixel_size="$(printf '%s\n' "$screen_metrics" | head -n 1)"
      point_size="$(printf '%s\n' "$screen_metrics" | tail -n 1)"
      printf 'pixel_size=%sx%s\npoint_size=%sx%s\nscale=%s\n' \
        "${pixel_size% *}" "${pixel_size#* }" "${point_size% *}" "${point_size#* }" \
        "$(awk -v px="${pixel_size% *}" -v pt="${point_size% *}" 'BEGIN { if (pt > 0) printf "%.4g", px / pt; else print "unknown" }')"
      printf 'click_coordinates=points (divide pixel coordinates read from this image by scale)\n'
    fi
    run_zsh "$remote_file" <<'REMOTE'
set -eu
path="$1"
case "$path" in
  /tmp/stella-ios-frame-*.png|/tmp/stella-ios-screen-*.png) /bin/rm -f -- "$path" ;;
  *) exit 2 ;;
esac
REMOTE
    printf '%s\n' "$local_path"
    ;;
  windows)
    require_screen_input
    run_zsh "$(target_udid)" <<'REMOTE'
set -eu
udid="$1"
if test "$udid" != booted; then
  printf 'recorded_device=%s\n' "$(/usr/bin/xcrun simctl list devices available | /usr/bin/grep -F "$udid" | /usr/bin/sed -E 's/^ *//; s/ \(.*//' | /usr/bin/head -n 1)"
fi
/usr/bin/osascript <<'OSA'
tell application "System Events"
  if not (exists process "Simulator") then return "simulator_windows=0"
  set report to ""
  repeat with simulatorWindow in windows of process "Simulator"
    set windowPosition to position of simulatorWindow
    set windowSize to size of simulatorWindow
    set report to report & "window=" & (name of simulatorWindow) & " position=" & (item 1 of windowPosition) & "," & (item 2 of windowPosition) & " size=" & (item 1 of windowSize) & "x" & (item 2 of windowSize) & linefeed
  end repeat
  return report
end tell
OSA
REMOTE
    ;;
  click)
    x="${1:-}"
    y="${2:-}"
    [[ "$x" =~ ^[0-9]+$ && "$y" =~ ^[0-9]+$ ]] || {
      printf 'click requires integer screen coordinates\n' >&2
      exit 2
    }
    require_screen_input
    run_zsh "$x" "$y" <<'REMOTE'
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
    run_zsh "$text" <<'REMOTE'
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
    run_zsh "$key_name" <<'REMOTE'
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
    open_url "$url"
    ;;
  launch)
    bundle_id="${1:-com.stella.mobile}"
    [[ "$bundle_id" =~ ^[A-Za-z0-9.-]+$ ]] || {
      printf 'Invalid bundle identifier\n' >&2
      exit 2
    }
    run_zsh "$bundle_id" "$(target_udid)" <<'REMOTE'
set -eu
/usr/bin/xcrun simctl launch "$2" "$1"
REMOTE
    ;;
  logs)
    run_zsh "$(target_udid)" <<'REMOTE'
set -eu
/usr/bin/xcrun simctl spawn "$1" log show --last 5m --style compact --predicate 'process == "Stella"' \
  | /usr/bin/tail -n 300 \
  | /usr/bin/sed -E 's/(ott=)[^[:space:]"<>]+/\1[REDACTED]/g; s/([Bb]earer )[A-Za-z0-9._~+/-]+=*/\1[REDACTED]/g; s/("?(oneTimeToken|token|accessToken|refreshToken|sessionToken)"?[=:] ?"?)[A-Za-z0-9._~+/-]{8,}/\1[REDACTED]/g'
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
      run_zsh "$boot_udid" <<'REMOTE'
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
