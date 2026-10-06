import { promises as fs } from "node:fs";
import path from "node:path";
import { git, gitRaw, run } from "./git.js";

/**
 * The check a merged update has to pass before it is applied by itself.
 *
 * It is the build the launcher already runs on every start: Electron main and
 * the sandboxed preload, esbuild bundles over `packages/desktop/electron`,
 * `packages/contracts` and `packages/runtime`. That is deliberately the one
 * check worth gating on here — a main or preload that does not build is a
 * Stella that does not start, which is the only outcome a user cannot ask
 * Stella to fix. It costs about a second and needs no install.
 *
 * It runs on a detached scratch worktree, never on the checkout, so an abort
 * leaves nothing half-merged: the checkout is only touched by the final
 * fast-forward, after this returns.
 *
 * `node_modules` is symlinked in rather than installed. The root directory
 * holds no workspace packages (bun puts `@stella/*` in each package's own
 * `node_modules`), and the bundle resolves `@stella/contracts` and
 * `@stella/runtime` through esbuild aliases computed from the tree it is
 * building — so the sources under test are the merged ones, while third-party
 * packages come from the checkout. A merge that needs dependencies the
 * checkout does not have yet therefore fails the gate rather than passing it
 * blindly, and the failure goes to an agent.
 *
 * What it does not cover: the renderer, which is served from source and
 * type-checked nowhere on this path. A renderer that breaks is recoverable
 * from inside the running app; main and preload are not.
 */

export type GateResult = { ok: true } | { ok: false; output: string };

const BUILD_TIMEOUT_MS = 5 * 60_000;
/** Enough of the build's complaint to act on, without a brief made of noise. */
const OUTPUT_LIMIT = 4_000;
const RUNNER = "stella-update-gate.mjs";
/**
 * Written into the scratch worktree and run there, rather than running the
 * build script as the entry point.
 *
 * Any entry-point guard decides whether to work from the shape of
 * `process.argv[1]`, and this gate was where one got that wrong: a scratch
 * path under a symlinked directory made the comparison fail, and the build
 * exited 0 having built nothing. The guard is fixed (`scripts/lib/
 * entry-point.mjs`), but a gate should not be taking anyone's word for it:
 * importing the export and asserting both `built` and the outputs cannot
 * pass vacuously, whatever the guard decides.
 */
const RUNNER_SOURCE = `import {
  ensureElectronBundlesFresh,
  requiredOutputsExist,
} from "./packages/desktop/scripts/dev-electron-build.mjs";

try {
  const result = await ensureElectronBundlesFresh({
    log: (message) => console.log(message),
  });
  if (!result.built || !requiredOutputsExist()) {
    console.error("The update check did not build Electron main and preload.");
    process.exit(1);
  }
} catch (error) {
  // esbuild's message is already the list of files and reasons; its thrown
  // object dumped whole is noise an agent would have to read past.
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
`;

/** Packages whose `node_modules` the bundle build resolves through. */
const linkNodeModules = async (cwd: string, scratch: string) => {
  await fs.symlink(
    path.join(cwd, "node_modules"),
    path.join(scratch, "node_modules"),
    "dir",
  );
  const packages = await fs
    .readdir(path.join(scratch, "packages"), { withFileTypes: true })
    .catch(() => []);
  for (const entry of packages) {
    if (!entry.isDirectory()) continue;
    const from = path.join(cwd, "packages", entry.name, "node_modules");
    if (!(await fs.stat(from).catch(() => null))) continue;
    await fs.symlink(
      from,
      path.join(scratch, "packages", entry.name, "node_modules"),
      "dir",
    );
  }
};

/**
 * Build Electron main and preload from `commit` in a scratch worktree.
 * Always removes the worktree, including when the build throws.
 */
export const checkMergedUpdate = async (
  cwd: string,
  commit: string,
  scratch: string,
  log: (event: string, data: Record<string, unknown>) => void,
): Promise<GateResult> => {
  // A scratch directory left by a crash would fail `worktree add`.
  await fs.rm(scratch, { recursive: true, force: true });
  await gitRaw(cwd, ["worktree", "prune"]);
  await git(cwd, ["worktree", "add", "--detach", "--force", scratch, commit]);
  try {
    await linkNodeModules(cwd, scratch);
    await fs.writeFile(path.join(scratch, RUNNER), RUNNER_SOURCE);
    const startedAt = Date.now();
    const result = await run(process.execPath, [path.join(scratch, RUNNER)], {
      cwd: scratch,
      // Electron's binary is the only Node this app is sure to have, and it
      // is what builds these bundles on a normal launch.
      env: { ELECTRON_RUN_AS_NODE: "1" },
      timeoutMs: BUILD_TIMEOUT_MS,
    });
    log("app-source.update-gate", {
      code: result.code,
      ms: Date.now() - startedAt,
    });
    if (result.code === 0) return { ok: true };
    const output = `${result.stdout}\n${result.stderr}`.trim();
    return { ok: false, output: output.slice(-OUTPUT_LIMIT) };
  } finally {
    await gitRaw(cwd, ["worktree", "remove", "--force", scratch]);
    await fs.rm(scratch, { recursive: true, force: true });
  }
};
