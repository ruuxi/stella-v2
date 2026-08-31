#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 <development|production> <init|validate|plan|apply|output> [terraform args...]" >&2
  exit 64
}

[[ $# -ge 2 ]] || usage
environment="$1"
action="$2"
shift 2

case "${environment}" in
  development | production) ;;
  *) usage ;;
esac

case "${action}" in
  init | validate | plan | apply | output) ;;
  *) usage ;;
esac

command -v terraform >/dev/null 2>&1 || {
  echo "terraform is required" >&2
  exit 69
}

telemetry_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
stack_dir="${telemetry_root}/stacks/${environment}"
backend_config="${stack_dir}/backend.hcl"

require_backend() {
  if [[ ! -f "${backend_config}" ]]; then
    echo "missing ${backend_config}; copy backend.hcl.example and configure the R2 endpoint" >&2
    exit 78
  fi
  : "${AWS_ACCESS_KEY_ID:?set AWS_ACCESS_KEY_ID for the R2 state bucket}"
  : "${AWS_SECRET_ACCESS_KEY:?set AWS_SECRET_ACCESS_KEY for the R2 state bucket}"
}

if [[ "${action}" != "init" && "${action}" != "validate" ]]; then
  : "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN to a scoped IaC token}"
  : "${TF_VAR_cloudflare_account_id:?set TF_VAR_cloudflare_account_id}"
fi

case "${action}" in
  init)
    require_backend
    exec terraform -chdir="${stack_dir}" init -backend-config="${backend_config}" "$@"
    ;;
  validate)
    terraform -chdir="${stack_dir}" init -backend=false -input=false
    exec terraform -chdir="${stack_dir}" validate "$@"
    ;;
  plan)
    require_backend
    terraform -chdir="${stack_dir}" init -input=false -backend-config="${backend_config}"
    exec terraform -chdir="${stack_dir}" plan -input=false "$@"
    ;;
  apply)
    if [[ "${TELEMETRY_TERRAFORM_APPLY:-}" != "yes" ]]; then
      echo "refusing apply; set TELEMETRY_TERRAFORM_APPLY=yes after reviewing a saved plan" >&2
      exit 77
    fi
    require_backend
    terraform -chdir="${stack_dir}" init -input=false -backend-config="${backend_config}"
    exec terraform -chdir="${stack_dir}" apply -input=false "$@"
    ;;
  output)
    exec terraform -chdir="${stack_dir}" output "$@"
    ;;
esac
