#!/usr/bin/env bash
# Remaining surface of the workspace-kind taxonomy. Every count must reach zero.
set -uo pipefail
cd "$(dirname "$0")/.."

count() { rg -c --no-filename "$1" packages workers 2>/dev/null | awk '{s+=$1} END {print s+0}'; }

total=0
report() {
  local hits
  hits=$(count "$2")
  total=$((total + hits))
  printf '%-46s %s\n' "$1" "$hits"
}

for sym in CLOUD_WORKSPACE_PATTERN checkWorkspaceProvisioned executionSubjectForWorkspace \
  resolveWorkspace COMPUTER_AGENT_WORKSPACE WorkspaceKind MOUNT_PATHS WORKSPACE_ROOTS \
  normalizeExecutionWorkspace deriveServerExecutionSubject assertExecutionWorkspaceAuthority \
  driveWritePrefixForWorkspace getTurnWorkspaceInternal turnHydratesDrive drivePrefixFor \
  toolStateDirFor workspaceKind TOOL_WORKSPACE_ROOTS \
  TURN_STATE_WORKSPACE_ROOTS spawnIntentFingerprint; do
  report "$sym" "\\b$sym\\b"
done

report 'workspace: "<kind>"' 'workspace: "(cloud|computer|stella|drive)"'
report 'workspace.kind' '\bworkspace\.kind\b'
report 'workspace === "<kind>"' 'workspace === "(cloud|computer|stella|drive)"'

printf '%-46s %s\n' TOTAL "$total"
[ "$total" -eq 0 ]
