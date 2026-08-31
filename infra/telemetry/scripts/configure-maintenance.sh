#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 <development|production>" >&2
  exit 64
}

[[ $# -eq 1 ]] || usage
environment="$1"
case "${environment}" in
  development | production) ;;
  *) usage ;;
esac

command -v terraform >/dev/null 2>&1 || {
  echo "terraform is required to resolve the managed bucket" >&2
  exit 69
}
command -v bunx >/dev/null 2>&1 || {
  echo "bunx is required to run the repository-pinned Wrangler" >&2
  exit 69
}
: "${R2_CATALOG_MAINTENANCE_TOKEN:?set R2_CATALOG_MAINTENANCE_TOKEN to a scoped R2 catalog and storage write token}"

telemetry_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
stack_dir="${telemetry_root}/stacks/${environment}"
bucket_name="$(terraform -chdir="${stack_dir}" output -raw bucket_name)"

[[ "${bucket_name}" =~ ^stella-telemetry-(dev|prod)-v1(-[a-z0-9-]+)?$ ]] || {
  echo "refusing to configure unexpected bucket: ${bucket_name}" >&2
  exit 65
}

# The Cloudflare Terraform provider exposes maintenance configuration as
# read-only. These setters are safe to repeat and converge on the desired state.
bunx wrangler r2 bucket catalog compaction enable \
  "${bucket_name}" \
  --target-size 128 \
  --token "${R2_CATALOG_MAINTENANCE_TOKEN}"

if [[ "${environment}" == "production" ]]; then
  older_than_days=30
  retain_last=20
else
  older_than_days=7
  retain_last=10
fi

bunx wrangler r2 bucket catalog snapshot-expiration enable \
  "${bucket_name}" \
  --older-than-days "${older_than_days}" \
  --retain-last "${retain_last}" \
  --token "${R2_CATALOG_MAINTENANCE_TOKEN}"

echo "configured catalog maintenance for ${bucket_name}"
