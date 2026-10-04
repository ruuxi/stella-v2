import fs from "fs";
import type { Socket } from "node:net";
import path from "path";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, searchForWorkspaceRoot, type Plugin } from "vite";
import { uiStateSharedStore } from "./vite/ui-state-plugin.ts";

const __dirname = import.meta.dirname;

const ROUTER_CONFIG = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "tsr.config.json"), "utf8"),
) as {
  target: "react";
  autoCodeSplitting: boolean;
  routesDirectory: string;
  generatedRouteTree: string;
};

// Written by the supervisor after every electron-bundle build; not a renderer
// module, and its write cadence would only churn the watcher.
const BUNDLE_FINGERPRINT_FILE = path.resolve(
  __dirname,
  ".dev-electron-bundle-fingerprint.json",
);
const STELLA_REPO_ROOT = path.resolve(__dirname, "..", "..");
const BUNDLED_STELLA_DATA_SEED_DIR = path.resolve(
  STELLA_REPO_ROOT,
  "packages",
  "home-seed",
);
// esbuild owns this tree (the Electron-main/preload bundles); the dev script
// runs its own purpose-built recursive watcher over it. Vite's default
// auto-ignore only covers build.outDir ('dist'), so without this entry Vite's
// renderer chokidar watcher also subscribes to the esbuild output and filters
// its write bursts on every electron rebuild (heavier ReadDirectoryChangesW
// churn on Windows). Keep Vite out of it entirely.
const DIST_ELECTRON_DIR = path.resolve(
  __dirname,
  "..",
  "desktop",
  "dist-electron",
);
// A large build/artifact tree that never participates in renderer HMR.
// Without this, Vite's chokidar root watcher subscribes to ~14.5k files under
// native/ (5.8GB, incl. the 5.2GB wakeword model tree) — a needless recursive
// readdirp walk + stat-per-file at startup and (on Windows) ongoing
// ReadDirectoryChangesW churn. Nothing under it is a renderer module.
const NATIVE_DIR = path.resolve(__dirname, "..", "native");
const VITE_WORKSPACE_ROOT = searchForWorkspaceRoot(__dirname);
const DEV_SERVER_URL = new URL(
  process.env.STELLA_DEV_SERVER_URL?.trim() || "http://127.0.0.1:57314",
);

const normalizeWatchedFilePath = (filePath: string) =>
  path.resolve(filePath).replace(/\\/g, "/");

const PDF_WORKER_PUBLIC_REL = path.posix.join(
  "vendor",
  "pdfjs",
  "pdf.worker.min.mjs",
);
const PDF_WORKER_PUBLIC_ABS = path.resolve(
  __dirname,
  "public",
  PDF_WORKER_PUBLIC_REL,
);

/**
 * Copies the pdfjs-dist worker into `public/vendor/pdfjs/` so the renderer
 * can load it as a static asset served by Vite's dev server.
 *
 * We can't rely on Vite/Rolldown to resolve the deep package path with
 * `?url`: the bun-managed node_modules layout hides pdfjs-dist behind
 * `.bun/node_modules/` and the deep path probe (`new URL("pdfjs-dist/...")`)
 * only sees Vite's import-map resolver, which doesn't expose deep file
 * paths through that channel. Copying via Node's resolver is the most
 * portable path: it works under bun's symlink layout, npm's flat layout,
 * and pnpm's strict-peer layout.
 */
function pdfWorkerAsset(): Plugin {
  const candidatePaths = [
    // wojtekmaj/react-pdf nests pdfjs-dist as its own dependency, which is
    // the most stable resolution target across package managers.
    path.resolve(
      STELLA_REPO_ROOT,
      "node_modules",
      ".bun",
      "node_modules",
      "pdfjs-dist",
      "build",
      "pdf.worker.min.mjs",
    ),
    path.resolve(
      STELLA_REPO_ROOT,
      "node_modules",
      "pdfjs-dist",
      "build",
      "pdf.worker.min.mjs",
    ),
  ];

  const resolveSource = (): string | null => {
    for (const candidate of candidatePaths) {
      try {
        if (fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        /* try next */
      }
    }
    return null;
  };

  const ensureWorkerCopied = () => {
    const sourcePath = resolveSource();
    if (!sourcePath) {
      console.warn(
        "[pdf-worker-asset] Could not locate pdfjs-dist/build/pdf.worker.min.mjs; PDF previews will not render.",
      );
      return;
    }
    const destPath = PDF_WORKER_PUBLIC_ABS;
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    let needsCopy = true;
    try {
      const sourceStat = fs.statSync(sourcePath);
      const destStat = fs.statSync(destPath);
      if (
        destStat.size === sourceStat.size &&
        destStat.mtimeMs >= sourceStat.mtimeMs
      ) {
        needsCopy = false;
      }
    } catch {
      needsCopy = true;
    }

    if (needsCopy) {
      fs.copyFileSync(sourcePath, destPath);
    }
  };

  return {
    name: "pdf-worker-asset",
    configResolved() {
      ensureWorkerCopied();
    },
  };
}

/**
 * Vite injects an inline React Refresh init script into `index.html`
 * during dev (`<script type="module">injectIntoGlobalHook(window);…</script>`).
 * Our production CSP doesn't allow `'unsafe-inline'`, so the inline
 * script gets blocked → React Refresh fails to register and HMR breaks
 * for component state. Strip the `<meta http-equiv="Content-Security-Policy">`
 * tag in dev only; prod builds keep the strict CSP intact.
 */
function devCspRelax(): Plugin {
  return {
    name: "dev-csp-relax",
    apply: "serve",
    transformIndexHtml(html) {
      return html.replace(
        /<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>\s*/i,
        "",
      );
    },
  };
}

/**
 * Warm the connection to the Stella backend worker before any script runs:
 * backend calls, live views and (in the browser shell) Better Auth all go
 * there. The entry chunk graph takes a few hundred milliseconds to fetch and
 * evaluate; DNS and TLS for the origin can finish meanwhile. Backend fetches
 * are credential-less CORS requests, hence `crossorigin`.
 */
function backendPreconnectHint(): Plugin {
  let origin: string | null = null;
  return {
    name: "backend-preconnect-hint",
    configResolved(config) {
      try {
        const value = config.env.VITE_STELLA_BACKEND_URL?.trim();
        origin = value ? new URL(value).origin : null;
      } catch {
        origin = null;
      }
    },
    transformIndexHtml(html, ctx) {
      if (!origin || path.basename(ctx.filename) !== "index.html") {
        return html;
      }
      return {
        html,
        tags: [
          {
            tag: "link",
            attrs: { rel: "preconnect", href: origin, crossorigin: "anonymous" },
            injectTo: "head" as const,
          },
        ],
      };
    },
  };
}

/**
 * Bun's node:http never settles `server.close(callback)` once a WebSocket
 * upgrade has happened on the server (zombie upgrade sockets keep the
 * connection count from draining — oven-sh/bun#13184). The production
 * desktop dev command runs this whole supervisor under Bun, and Vite's config-change
 * restart awaits exactly that callback inside `server.close()`, so an update
 * that rewrites vite.config.ts while the renderer's HMR socket is connected
 * hangs the restart forever and leaves the app headless. Deliver the close
 * callback ourselves: destroy every tracked connection, then settle as soon
 * as the listener is down and all sockets are gone.
 */
function bunHttpServerCloseFix(): Plugin {
  return {
    name: "bun-http-server-close-fix",
    apply: "serve",
    configureServer(server) {
      if (!process.versions.bun) return;
      const httpServer = server.httpServer;
      if (!httpServer) return;

      const openSockets = new Set<Socket>();
      httpServer.on("connection", (socket) => {
        openSockets.add(socket);
        socket.once("close", () => openSockets.delete(socket));
      });

      const originalClose = httpServer.close.bind(httpServer);
      httpServer.close = ((callback?: (err?: Error) => void) => {
        let settled = false;
        const settle = (err?: Error) => {
          if (settled) return;
          settled = true;
          callback?.(err);
        };
        originalClose(settle);
        for (const socket of openSockets) socket.destroy();
        const poll = setInterval(() => {
          if (httpServer.listening || openSockets.size > 0) return;
          clearInterval(poll);
          settle();
        }, 10);
        poll.unref();
        return httpServer;
      }) as typeof httpServer.close;
    },
  };
}

export default defineConfig({
  plugins: [
    TanStackRouterVite(ROUTER_CONFIG),
    react(),
    tailwindcss(),
    devCspRelax(),
    backendPreconnectHint(),
    bunHttpServerCloseFix(),
    uiStateSharedStore(),
    pdfWorkerAsset(),
  ],
  optimizeDeps: {
    // Front-load prebundling of the heavy/transitive deps deterministically on
    // first launch. Without this, dep discovery is entirely on-demand: a cold
    // cache (fresh clone, dep bump, cache invalidation) lets the first markdown,
    // chart, or PDF render discover an unoptimized dep at runtime, which makes
    // Vite emit a full-reload ("optimized dependencies changed. reloading")
    // that yanks the renderer mid-session. Streamdown's optional plugins are
    // not installed; recharts/react-pdf are large leaf deps.
    include: [
      "streamdown",
      "recharts",
      "react-pdf",
      "motion",
      "@tanstack/react-router",
      "@tanstack/react-table",
      "@legendapp/list/react",
      "zod",
      "@radix-ui/react-dialog",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-popover",
      "@radix-ui/react-switch",
    ],
    // Cover every window's HTML entry in the cold dep scan (not just index.html),
    // so the overlay/mini spines don't trigger a separate re-optimize when
    // first opened.
    entries: ["index.html", "overlay.html", "companion.html"],
    rolldownOptions: {
      transform: {
        target: "esnext",
      },
    },
  },
  server: {
    // Pre-transform the renderer's first-paint module spine on cold start so
    // Vite isn't serializing `main.tsx -> App -> AppProviders -> FullShell`
    // transforms against the renderer's initial request (and window creation).
    warmup: {
      clientFiles: [
        // First-paint spine.
        "./src/main.tsx",
        "./src/App.tsx",
        "./src/context/AppProviders.tsx",
        "./src/shell/FullShell.tsx",
        // The chat surface is the primary (eager, non-lazy) first interaction;
        // pre-transform its long static chain in parallel instead of
        // serializing it against the renderer's first requests.
        "./src/router.tsx",
        "./src/routes/__root.tsx",
        "./src/app/home/HomeContent.jsx",
        "./src/app/chat/ChatColumn.tsx",
        "./src/app/chat/ChatTimeline.tsx",
        "./src/app/chat/ConversationEvents.tsx",
        "./src/app/chat/Composer.tsx",
        "./src/app/chat/MessageRow.tsx",
        // Secondary windows are opened deferred (after first paint); warming
        // their entries during the post-paint idle window means they open
        // instantly instead of cold-transforming on creation.
        "./src/overlay-entry.tsx",
        "./src/companion-entry.tsx",
      ],
    },
    // Defaults to the standard Stella loopback URL; an override lets an
    // isolated development checkout run beside another Stella instance.
    host: DEV_SERVER_URL.hostname,
    port: Number(DEV_SERVER_URL.port || 80),
    strictPort: true,
    forwardConsole: true,
    // Vite's red overlay is replaced by the renderer-side CrashSurface (see
    // `src/platform/dev/vite-error-recovery.ts` + `src/shell/ErrorBoundary.tsx`).
    // We forward `vite:error` events to the same boundary that catches React
    // render crashes so build / parse errors get Reload / Ask-Stella-to-repair
    // / Undo-update affordances instead of a raw oxc stack.
    hmr: { overlay: false },
    fs: {
      allow: [VITE_WORKSPACE_ROOT],
    },
    watch: {
      ignored: [
        `${BUNDLED_STELLA_DATA_SEED_DIR.replace(/\\/g, "/")}/**`,
        `${DIST_ELECTRON_DIR.replace(/\\/g, "/")}/**`,
        `${NATIVE_DIR.replace(/\\/g, "/")}/**`,
        normalizeWatchedFilePath(BUNDLE_FINGERPRINT_FILE),
      ],
    },
  },
  resolve: {
    tsconfigPaths: true,
    alias: [
      {
        find: /^react$/,
        replacement: path.resolve(
          STELLA_REPO_ROOT,
          "node_modules/react/index.js",
        ),
      },
      {
        find: /^react\/jsx-runtime$/,
        replacement: path.resolve(
          STELLA_REPO_ROOT,
          "node_modules/react/jsx-runtime.js",
        ),
      },
      {
        find: /^react\/jsx-dev-runtime$/,
        replacement: path.resolve(
          STELLA_REPO_ROOT,
          "node_modules/react/jsx-dev-runtime.js",
        ),
      },
      {
        find: /^react-dom$/,
        replacement: path.resolve(
          STELLA_REPO_ROOT,
          "node_modules/react-dom/index.js",
        ),
      },
      {
        find: /^react-dom\/client$/,
        replacement: path.resolve(
          STELLA_REPO_ROOT,
          "node_modules/react-dom/client.js",
        ),
      },
    ],
    dedupe: ["react", "react-dom"],
  },
});
