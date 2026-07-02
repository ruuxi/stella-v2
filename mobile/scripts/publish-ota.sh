#!/usr/bin/env bash
# Safe OTA publish ritual. Born from the 2026-07-02 boot-crash postmortem:
# `eas update` was run from a DIRTY working tree, so the bundle labeled
# `cc5808e` actually contained a mid-refactor ChatPane referencing an
# unimported <ActivityTray/> — ReferenceError on first render, instant
# release-mode crash on every launch of builds 95/96.
#
# This script refuses dirty trees, exports locally, proves (via the Hermes
# sourcemap's sourcesContent) that the bundle matches HEAD byte-for-byte,
# and only then publishes with the real commit stamped in the message.
#
# Usage: scripts/publish-ota.sh <channel>   e.g. scripts/publish-ota.sh preview
set -euo pipefail
cd "$(dirname "$0")/.."

CHANNEL="${1:?usage: publish-ota.sh <channel>}"

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

echo "Exporting release bundle for verification (HEAD ${SHA})..."
rm -rf dist
bunx expo export --platform ios

echo "Verifying exported bundle matches git HEAD..."
bun scripts/verify-ota-export.ts HEAD

echo "Publishing to channel '${CHANNEL}' as: ${SHA} ${SUBJECT}"
bunx eas-cli update --channel "${CHANNEL}" --message "${SHA} ${SUBJECT}" --non-interactive
