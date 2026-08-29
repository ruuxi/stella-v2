#!/usr/bin/env bash
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

if [[ ! -f .env.local ]] && [[ -z "${EXPO_PUBLIC_CONVEX_URL:-}" ]]; then
  echo "REFUSING to publish: no .env.local and EXPO_PUBLIC_CONVEX_URL unset." >&2
  exit 1
fi

SHA="$(git rev-parse --short HEAD)"
SUBJECT="$(git log -1 --format=%s)"

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
  bun x expo export --platform "${EXPORT_PLATFORM}" --source-maps

  echo "Verifying exported ${EXPORT_PLATFORM} bundle matches git HEAD..."
  bun scripts/verify-ota-export.ts HEAD "${EXPORT_PLATFORM}"
done

echo "Publishing ${PLATFORM} to channel '${CHANNEL}' as: ${SHA} ${SUBJECT}"

bun x eas-cli update --channel "${CHANNEL}" --environment "${CHANNEL}" \
  --platform "${PLATFORM}" --message "${SHA} ${SUBJECT}" --non-interactive
