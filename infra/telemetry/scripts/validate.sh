#!/usr/bin/env bash
set -euo pipefail

telemetry_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

python3 "${telemetry_root}/scripts/validate.py"

if ! command -v terraform >/dev/null 2>&1; then
  echo "terraform is unavailable; dependency-free validation completed"
  exit 0
fi

terraform -chdir="${telemetry_root}" fmt -check -recursive

validation_data_root="$(mktemp -d)"
trap 'rm -rf -- "${validation_data_root}"' EXIT

for stack in development production; do
  stack_dir="${telemetry_root}/stacks/${stack}"
  stack_data_dir="${validation_data_root}/${stack}"
  mkdir -p "${stack_data_dir}"
  TF_DATA_DIR="${stack_data_dir}" terraform -chdir="${stack_dir}" init -backend=false -input=false
  TF_DATA_DIR="${stack_data_dir}" terraform -chdir="${stack_dir}" validate
done

echo "telemetry Terraform validation passed"
