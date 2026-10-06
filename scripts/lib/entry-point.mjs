import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Whether this module is the file the process was started with.
 *
 * Scripts here are both a library (imported by tests and by each other) and a
 * command (`node packages/.../check-thing.mjs`), so each one guards its
 * command half with this. Getting the guard wrong is unusually costly: a
 * check whose guard is false exits 0 having verified nothing, which is a
 * green result that means nothing and looks exactly like a passing one. One
 * of these was found doing precisely that.
 *
 * The comparison every one of them used to hand-roll —
 * `path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)` — is
 * wrong, because the two sides are not the same kind of path. Node resolves a
 * relative `argv[1]` against the physical working directory but leaves an
 * absolute one exactly as given, while `import.meta.url` is always fully
 * resolved. So the guard holds for `node packages/x/check.mjs` and fails for
 * `node /tmp/repo/packages/x/check.mjs`, because `/tmp` is a symlink to
 * `/private/tmp` on macOS — as is `/var`, under which every system temp
 * directory lives. Worktrees and scratch checkouts live in exactly those
 * places. Bun resolves `argv[1]` fully and is unaffected, which is part of
 * why this went unnoticed.
 *
 * Both sides are canonicalised here instead, so it is the file being
 * compared rather than the spelling of its path. That also makes a script
 * invoked through a symlink to itself (a `node_modules/.bin` shim) recognise
 * itself correctly.
 *
 * Use this rather than writing the comparison again:
 *
 * ```js
 * import { isEntryPoint } from "../../scripts/lib/entry-point.mjs";
 * if (isEntryPoint(import.meta.url)) { await main(); }
 * ```
 */
export const isEntryPoint = (moduleUrl) => {
  const entry = process.argv[1];
  if (typeof entry !== "string" || entry.length === 0) return false;
  const canonical = (file) => {
    // A path that does not exist cannot be the running entry; realpathSync
    // throwing is the answer, not an error to propagate.
    try {
      return pathToFileURL(realpathSync(path.resolve(file))).href;
    } catch {
      return null;
    }
  };
  let modulePath;
  try {
    modulePath = fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
  const here = canonical(modulePath);
  return here !== null && canonical(entry) === here;
};
