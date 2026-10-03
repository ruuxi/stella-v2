import { promises as fs } from "node:fs";
import path from "node:path";
import { gitRaw } from "./git.js";

/**
 * A `reference-transaction` hook that keeps agents out of the running
 * checkout. Agent shells carry `STELLA_DRAFTS_DIR` (runtime shell.ts); when a
 * git command run from one would move the branch the checkout has checked
 * out, the hook refuses the transaction and points the agent at the draft
 * flow. Stella itself (this service, the launchers) never sets that variable,
 * so applies, undos and syncs pass. Unlike pre-commit, `--no-verify` doesn't skip it, and
 * it also covers merges, resets and fast-forwards.
 */

const MARKER = "stella-checkout-guard v3";

const HOOK = `#!/bin/sh
# ${MARKER} (written by Stella; rewritten on launch)
[ "$1" = prepared ] || exit 0
[ -n "$STELLA_DRAFTS_DIR" ] || exit 0
common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
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
