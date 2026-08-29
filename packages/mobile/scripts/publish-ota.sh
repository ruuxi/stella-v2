#!/usr/bin/env bash
# Safe OTA publish ritual. Born from the 2026-07-02 boot-crash postmortem:
# `eas update` was run from a DIRTY working tree, so the bundle labeled
# `cc5808e` actually contained a mid-refactor ChatPane referencing an
# unimported <ActivityTray/> — ReferenceError on first render, instant
# release-mode crash on every launch of builds 95/96.
#
# This script refuses dirty trees, pins the OTA target to the build the stores
# actually serve, exports locally, proves (via the Hermes sourcemap's
# sourcesContent) that the bundle matches HEAD byte-for-byte, and only then
# publishes with the real commit stamped in the message.
#
# Usage: scripts/publish-ota.sh <channel> [platform]
#   e.g. scripts/publish-ota.sh preview ios
set -euo pipefail
cd "$(dirname "$0")/.."

CHANNEL="${1:?usage: publish-ota.sh <channel> [platform]}"
PLATFORM="${2:-all}"

case "${PLATFORM}" in
  ios|android|all) ;;
  *)
    echo "REFUSING to publish: platform must be ios, android, or all." >&2
    exit 1
    ;;
esac

if [[ -n "$(git status --porcelain)" ]]; then
  echo "REFUSING to publish: working tree is dirty. Commit or stash first:" >&2
  git status --short >&2
  exit 1
fi

# The export bakes EXPO_PUBLIC_* in at bundle time; a missing env produced
# the first broken OTA of 2026-07-02. Expo CLI auto-loads .env.local.
if [[ ! -f .env.local ]] && [[ -z "${EXPO_PUBLIC_CONVEX_URL:-}" ]]; then
  echo "REFUSING to publish: no .env.local and EXPO_PUBLIC_CONVEX_URL unset." >&2
  exit 1
fi

SHA="$(git rev-parse --short HEAD)"
SUBJECT="$(git log -1 --format=%s)"

# An update on a channel reaches every installed binary with a matching runtime
# fingerprint, so targeting the newest EAS build would ship JS to a public app
# whose native side is older. Resolve the live store build instead and abort
# unless this tree's fingerprint is identical to it.
echo "Resolving the public store build instead of the newest EAS build..."
bun scripts/resolve-public-mobile-builds.ts --platform "${PLATFORM}" \
  --channel "${CHANNEL}" --verify-local-fingerprint

if [[ "${PLATFORM}" == "all" ]]; then
  PLATFORMS=(ios android)
else
  PLATFORMS=("${PLATFORM}")
fi

for EXPORT_PLATFORM in "${PLATFORMS[@]}"; do
  echo "Exporting ${EXPORT_PLATFORM} release bundle for verification (HEAD ${SHA})..."
  rm -rf dist
  bunx expo export --platform "${EXPORT_PLATFORM}" --source-maps

  echo "Verifying exported ${EXPORT_PLATFORM} bundle matches git HEAD..."
  bun scripts/verify-ota-export.ts HEAD "${EXPORT_PLATFORM}"
done

echo "Publishing ${PLATFORM} to channel '${CHANNEL}' as: ${SHA} ${SUBJECT}"
# Channels here (development/preview/production) map 1:1 to the default EAS
# environments; --environment is mandatory in --non-interactive mode.
bunx eas-cli update --channel "${CHANNEL}" --environment "${CHANNEL}" \
  --platform "${PLATFORM}" --message "${SHA} ${SUBJECT}" --non-interactive
