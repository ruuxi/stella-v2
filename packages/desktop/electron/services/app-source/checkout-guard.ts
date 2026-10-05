import { promises as fs } from "node:fs";
import path from "node:path";
import { gitRaw } from "./git.js";

/**
 * A `reference-transaction` hook that keeps agents out of the running
 * checkout. Agent shells carry `STELLA_DRAFTS_DIR` and `STELLA_APP_DIR`, the
 * checkout their own Stella runs from (runtime shell.ts); when a git command
 * run from one would move the branch that checkout has checked out, the hook
 * refuses the transaction and points the agent at the draft flow. A repo that
 * isn't the shell's `STELLA_APP_DIR` passes, so a hook left behind in a
 * checkout Stella no longer runs from blocks nobody. Stella itself (this
 * service, the launchers) never sets `STELLA_DRAFTS_DIR`, so applies, undos
 * and syncs pass. Unlike pre-commit, `--no-verify` doesn't skip it, and
 * it also covers merges, resets and fast-forwards.
 *
 * Once a transaction commits, it also notes which agent (`STELLA_AGENT_ID`,
 * set by the same shells) last moved each `draft/<name>` branch, in
 * `<common dir>/stella-drafts/<name>`, so the chat can offer the draft on
 * that agent's completion.
 */

const MARKER = "stella-checkout-guard v5";

/** Where the hook notes each draft's agent, under the git common dir. */
export const DRAFT_AGENTS_DIR = "stella-drafts";

const HOOK = `#!/bin/sh
# ${MARKER} (written by Stella; rewritten on launch)
common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
case "$1" in
prepared)
  [ -n "$STELLA_DRAFTS_DIR" ] && [ -n "$STELLA_APP_DIR" ] || exit 0
  here=$(cd "$common" 2>/dev/null && pwd -P) || exit 0
  app=$(unset GIT_DIR GIT_COMMON_DIR GIT_WORK_TREE; cd "$STELLA_APP_DIR" 2>/dev/null && git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
  app=$(cd "$app" 2>/dev/null && pwd -P) || exit 0
  [ "$here" = "$app" ] || exit 0
  branch=$(sed -n 's/^ref: //p' "$common/HEAD")
  [ -n "$branch" ] || exit 0
  while read -r old new ref; do
    if [ "$ref" = "$branch" ] && [ "$old" != "$new" ]; then
      echo "Stella's running checkout can't be changed directly ($ref)." >&2
      echo "Follow the modify-stella skill: make the change in a draft under \\$STELLA_DRAFTS_DIR; the user applies it with Update." >&2
      echo "If this command already changed files in the checkout, restore them with: git -C \\"\\$STELLA_APP_DIR\\" reset --merge" >&2
      echo "This guard is deliberate: don't unset STELLA_DRAFTS_DIR, skip hooks or otherwise work around it." >&2
      exit 1
    fi
  done
  ;;
committed)
  [ -n "$STELLA_AGENT_ID" ] || exit 0
  while read -r old new ref; do
    case "$ref" in refs/heads/draft/*) ;; *) continue ;; esac
    case "$new" in *[!0]*) ;; *) continue ;; esac
    mkdir -p "$common/${DRAFT_AGENTS_DIR}" &&
      printf '%s\\n' "$STELLA_AGENT_ID" > "$common/${DRAFT_AGENTS_DIR}/\${ref#refs/heads/draft/}"
  done
  ;;
esac
exit 0
`;

/** Install or refresh the hook; leaves a foreign reference-transaction hook alone. */
export const installCheckoutGuard = async (
  appDir: string,
  log: (event: string, data: Record<string, unknown>) => void,
) => {
  const hooks = await gitRaw(appDir, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "hooks",
  ]);
  if (hooks.code !== 0) return;
  const target = path.join(hooks.stdout.trim(), "reference-transaction");
  const existing = await fs.readFile(target, "utf8").catch(() => null);
  if (existing === HOOK) return;
  if (existing !== null && !existing.includes("stella-checkout-guard")) {
    log("app-source.checkout-guard-skipped", { reason: "foreign hook" });
    return;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, HOOK, { mode: 0o755 });
  await fs.chmod(target, 0o755);
};
