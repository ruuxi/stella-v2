#!/usr/bin/env bash
set -euo pipefail

target="${1:-}"
cd "$(dirname "$0")/.."

unset NEXT_PUBLIC_GOOGLE_ADS_ID NEXT_PUBLIC_GOOGLE_ADS_DOWNLOAD_LABEL NEXT_PUBLIC_GOOGLE_ADS_SIGNUP_LABEL
export NEXT_PUBLIC_TURNSTILE_SITE_KEY="0x4AAAAAAElT6LwLa_VHN9Qq"

case "$target" in
  dev)
    export NEXT_PUBLIC_STELLA_BACKEND_URL="https://stella-v2-cloud-builder-dev.lolruuxi.workers.dev"
    export NEXT_PUBLIC_STELLA_SITE_URL="https://stella-website-dev.lolruuxi.workers.dev"
    env_args=()
    ;;
  production)
    if [[ -z "${NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY:-}" ]]; then
      echo "NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY must be set for a production build." >&2
      exit 1
    fi
    export NEXT_PUBLIC_STELLA_BACKEND_URL="https://stella-v2-cloud-builder-prod.lolruuxi.workers.dev"
    export NEXT_PUBLIC_STELLA_SITE_URL="https://stella.sh"
    export NEXT_PUBLIC_GOOGLE_ADS_ID="AW-18375048850"
    export NEXT_PUBLIC_GOOGLE_ADS_DOWNLOAD_LABEL="CrdSCMj5-d8cEJL987lE"
    export NEXT_PUBLIC_GOOGLE_ADS_SIGNUP_LABEL="6cIuCJjxhuAcEJL987lE"
    env_args=(--env production)
    ;;
  *)
    echo "usage: scripts/deploy-stella.sh dev|production" >&2
    exit 2
    ;;
esac

unset VITE_STELLA_APPS_HOST VITE_STELLA_APPS_AUTH_HOST NEXT_PUBLIC_STELLA_APPS_HOST
export VITE_STELLA_BACKEND_URL="$NEXT_PUBLIC_STELLA_BACKEND_URL"
export VITE_TURNSTILE_SITE_KEY="$NEXT_PUBLIC_TURNSTILE_SITE_KEY"

bunx opennextjs-cloudflare build
bunx opennextjs-cloudflare deploy "${env_args[@]}"
