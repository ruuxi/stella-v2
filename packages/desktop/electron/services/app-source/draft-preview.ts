import fs from "node:fs";
import path from "node:path";
import { WebContentsView } from "electron";
import { serveRendererSource } from "../../source/renderer-protocol.js";
import { getSourceUrl } from "../../windows/window-load.js";
import { createSharedWebPreferences } from "../../windows/shared-window-preferences.js";
import { configureStellaSessionPermissions } from "../../bootstrap/session-permissions.js";
import { getMainLogger } from "../../observability/main-logger.js";
import { DRAFT_REF_PREFIX, isDraftName, listWorktrees, run } from "./git.js";

export type DraftPreview = {
  view: WebContentsView;
  url: string;
  dispose: () => void;
};

/**
 * The preview resolves packages inside the draft, so the draft needs its own
 * install: a missing `node_modules`, or a symlink into the app checkout
 * (which resolves outside the draft), leaves the preview on its launch screen.
 */
const ensureDraftDependencies = async (draftRoot: string) => {
  let missing = false;
  for (const dir of [draftRoot, path.join(draftRoot, "packages", "desktop-ui")]) {
    const modules = path.join(dir, "node_modules");
    const stat = fs.lstatSync(modules, { throwIfNoEntry: false });
    if (stat?.isDirectory()) continue;
    if (stat) fs.rmSync(modules, { force: true });
    missing = true;
  }
  if (!missing) return;
  const bun = process.env.STELLA_BUN_PATH?.trim() || "bun";
  const result = await run(bun, ["install", "--frozen-lockfile"], {
    cwd: draftRoot,
    timeoutMs: 300_000,
  });
  if (result.code !== 0) {
    throw new Error(
      `Installing the draft's dependencies failed; run \`bun install\` in the draft. ${result.stderr.trim().slice(-400)}`,
    );
  }
};

/**
 * The full Stella UI served from a draft worktree, headless inside the
 * running app: same preload and IPC as the real windows (so the user's real
 * account and runtime), but its own in-memory session, so browser storage is
 * separate.
 */
export const openDraftPreview = async (options: {
  name: string;
  stellaAppDir: string;
  preloadPath: string;
}): Promise<DraftPreview> => {
  if (!isDraftName(options.name)) {
    throw new Error(`"${options.name}" is not a valid draft name.`);
  }
  const branch = `${DRAFT_REF_PREFIX}${options.name}`;
  const worktree = (await listWorktrees(options.stellaAppDir)).find(
    (tree) => tree.branch === branch,
  );
  if (!worktree) {
    throw new Error(
      `No draft named "${options.name}" is in progress (no worktree on draft/${options.name}).`,
    );
  }
  await ensureDraftDependencies(worktree.path);
  const partition = `stella-preview-${options.name}`;
  configureStellaSessionPermissions({ appPartition: partition, isDev: true });
  const source = serveRendererSource({
    partition,
    sourceRoot: worktree.path,
    envRoot: options.stellaAppDir,
    isDev: true,
    log: (message) =>
      getMainLogger()?.process("renderer.preview-source", {
        draft: options.name,
        message,
      }),
  });
  const view = new WebContentsView({
    webPreferences: createSharedWebPreferences({
      preloadPath: options.preloadPath,
      sessionPartition: partition,
      // Agents screenshot it while it sits in a hidden host.
      backgroundThrottling: false,
    }),
  });
  return {
    view,
    url: getSourceUrl("full"),
    dispose: () => source.dispose(),
  };
};
