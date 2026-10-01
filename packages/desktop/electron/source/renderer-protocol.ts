import path from "node:path";
import { app, BrowserWindow, protocol, session } from "electron";
import { RENDERER_ORIGIN, RENDERER_SCHEME } from "./origin.js";

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

/**
 * Serve the renderer from source on the app's session and start warming it.
 * The server (oxc, rolldown, Tailwind) loads only here, never on a packaged
 * launch.
 */
export const serveRendererSource = (options: {
  partition: string;
  stellaAppDir: string;
  isDev: boolean;
  log: (message: string) => void;
}) => {
  const ready = Promise.all([import("./renderer-source.js"), import("./tools.js")]).then(
    async ([{ createRendererSource }, { loadSourceTools }]) =>
    createRendererSource({
      tools: await loadSourceTools(),
      uiRoot: path.join(options.stellaAppDir, "packages", "desktop-ui"),
      repoRoot: options.stellaAppDir,
      cacheDir: path.join(app.getPath("userData"), "Renderer Source Cache"),
      isDev: options.isDev,
      log: options.log,
      onReloadNeeded: () => {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed() && isRendererSourceUrl(window.webContents.getURL())) {
            window.webContents.reload();
          }
        }
      },
    }),
  );
  session.fromPartition(options.partition).protocol.handle(RENDERER_SCHEME, async (request) =>
    (await ready).handle(request),
  );
  void ready
    .then((source) => source.prepare())
    .catch((error) => {
      options.log(`[source] prepare failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  return ready;
};
