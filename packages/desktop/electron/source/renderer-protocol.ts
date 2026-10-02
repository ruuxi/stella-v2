import path from "node:path";
import { app, protocol, session, webContents } from "electron";
import { RENDERER_ORIGIN, RENDERER_SCHEME } from "./origin.js";
import type { RendererSource } from "./renderer-source.js";

/** Must run before `ready`: the scheme behaves like https (ESM, fetch, CSP 'self'). */
export const registerRendererScheme = () => {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: RENDERER_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
        codeCache: true,
      },
    },
  ]);
};

export const isRendererSourceUrl = (url: string) => url.startsWith(`${RENDERER_ORIGIN}/`);

export type RendererSourceHandle = {
  ready: Promise<RendererSource>;
  /**
   * Swap in files that changed in this source root (repo-relative posix
   * paths). Hot-updates every renderer webContents on this partition
   * (windows and WebContentsViews), falling back to reloading them. "none"
   * when no path is a renderer input (desktop-ui files, or files of other
   * packages, such as packages/contracts, that the served graph includes).
   */
  applyChanges(paths: string[]): Promise<{ mode: "none" | "hot" | "reload" }>;
  /** Stop serving: unhandle the protocol on the partition, dispose the source. */
  dispose(): void;
};

/**
 * Serve the renderer from a source root on a session partition and start
 * warming it. The server (oxc, rolldown, Tailwind) loads only here, never on
 * a packaged launch. Every partition shares one transform and dependency
 * cache.
 */
export const serveRendererSource = (options: {
  partition: string;
  /** Repo root to serve (the checkout, or a draft worktree). */
  sourceRoot: string;
  /** Repo root whose packages/desktop-ui .env files supply the defines; defaults to sourceRoot. */
  envRoot?: string;
  isDev: boolean;
  log: (message: string) => void;
}): RendererSourceHandle => {
  const partitionSession = session.fromPartition(options.partition);
  const pages = () =>
    webContents
      .getAllWebContents()
      .filter(
        (contents) =>
          !contents.isDestroyed() &&
          contents.session === partitionSession &&
          isRendererSourceUrl(contents.getURL()),
      );
  const reloadPages = () => {
    for (const contents of pages()) contents.reload();
  };
  const ready = Promise.all([import("./renderer-source.js"), import("./tools.js")]).then(
    async ([{ createRendererSource }, { loadSourceTools }]) =>
      createRendererSource({
        tools: await loadSourceTools(),
        uiRoot: path.join(options.sourceRoot, "packages", "desktop-ui"),
        repoRoot: options.sourceRoot,
        envDir: path.join(options.envRoot ?? options.sourceRoot, "packages", "desktop-ui"),
        cacheDir: path.join(app.getPath("userData"), "Renderer Source Cache"),
        isDev: options.isDev,
        log: options.log,
        onReloadNeeded: reloadPages,
      }),
  );
  partitionSession.protocol.handle(RENDERER_SCHEME, async (request) =>
    (await ready).handle(request),
  );
  void ready
    .then((source) => source.prepare())
    .catch((error) => {
      options.log(`[source] prepare failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  return {
    ready,
    applyChanges: async (paths) => {
      const result = await (await ready).applyChanges(paths);
      if (result.mode === "reload") reloadPages();
      if (result.mode === "hot") {
        const script = `globalThis.__stellaHot?.update(${JSON.stringify(result.payload)})`;
        await Promise.all(
          pages().map((contents) =>
            contents.executeJavaScript(script).catch((error: unknown) => {
              options.log(`[source] hot update failed: ${error instanceof Error ? error.message : String(error)}`);
              if (!contents.isDestroyed()) contents.reload();
            }),
          ),
        );
      }
      return { mode: result.mode };
    },
    dispose: () => {
      partitionSession.protocol.unhandle(RENDERER_SCHEME);
      void ready.then((source) => source.dispose(), () => undefined);
    },
  };
};
