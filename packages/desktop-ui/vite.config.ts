import fs from "fs";
import type { Socket } from "node:net";
import path from "path";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, searchForWorkspaceRoot, type Plugin } from "vite";
import { uiStateSharedStore } from "./vite/ui-state-plugin.ts";

const __dirname = import.meta.dirname;

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

const DIST_ELECTRON_DIR = path.resolve(
  __dirname,
  "..",
  "desktop",
  "dist-electron",
);

const NATIVE_DIR = path.resolve(__dirname, "..", "native");
const RELEASE_DIR = path.resolve(__dirname, "..", "desktop", "release");
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

function pdfWorkerAsset(): Plugin {
  const candidatePaths = [

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

const packageNameFromModuleId = (id: string): string | null => {
  const normalized = id.replace(/\\/g, "/");
  const marker = "/node_modules/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex === -1) return null;

  let rest = normalized.slice(markerIndex + marker.length);
  if (rest.startsWith(".bun/")) {
    const nestedIndex = rest.indexOf(marker);
    if (nestedIndex === -1) return null;
    rest = rest.slice(nestedIndex + marker.length);
  }

  const [first, second] = rest.split("/");
  if (!first) return null;
  if (first.startsWith("@")) {
    return second ? `${first}/${second}` : null;
  }
  return first;
};

const packageChunkName = (packageName: string): string =>
  `vendor-${packageName.replace(/^@/, "").replace(/[^a-zA-Z0-9_-]+/g, "-")}`;

export default defineConfig({
  plugins: [
    TanStackRouterVite({
      target: "react",
      autoCodeSplitting: true,
      routesDirectory: "./src/routes",
      generatedRouteTree: "./src/routeTree.gen.ts",
    }),
    react(),
    tailwindcss(),
    devCspRelax(),
    bunHttpServerCloseFix(),
    uiStateSharedStore(),
    pdfWorkerAsset(),
  ],
  base: "./",
  optimizeDeps: {

    include: [
      "streamdown",
      "recharts",
      "react-pdf",
      "motion",
      "@tanstack/react-router",
      "@tanstack/react-table",
      "convex/react",
      "@legendapp/list/react",
      "zod",
      "@radix-ui/react-dialog",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-popover",
      "@radix-ui/react-switch",
    ],

    entries: ["index.html", "overlay.html", "pet.html"],
    rolldownOptions: {
      transform: {
        target: "esnext",
      },
    },
  },
  build: {
    outDir: "dist",
    target: "esnext",
    modulePreload: {
      polyfill: false,
    },
    rolldownOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        overlay: path.resolve(__dirname, "overlay.html"),
        pet: path.resolve(__dirname, "pet.html"),
      },
      output: {
        manualChunks(id: string) {
          const normalized = id.replace(/\\/g, "/");
          if (normalized.includes("/node_modules/react/")) {
            return "vendor-react";
          }
          if (normalized.includes("/node_modules/react-dom/")) {
            return "vendor-react-dom";
          }
          const packageName = packageNameFromModuleId(id);
          if (packageName === "convex") {
            return undefined;
          }
          return packageName ? packageChunkName(packageName) : undefined;
        },
      },
    },
  },
  server: {

    warmup: {
      clientFiles: [

        "./src/main.tsx",
        "./src/App.tsx",
        "./src/context/AppProviders.tsx",
        "./src/shell/FullShell.tsx",

        "./src/router.tsx",
        "./src/routes/__root.tsx",
        "./src/app/home/HomeContent.jsx",
        "./src/app/chat/ChatColumn.tsx",
        "./src/app/chat/ChatTimeline.tsx",
        "./src/app/chat/ConversationEvents.tsx",
        "./src/app/chat/Composer.tsx",
        "./src/app/chat/MessageRow.tsx",

        "./src/overlay-entry.tsx",
        "./src/pet-entry.tsx",
      ],
    },

    host: DEV_SERVER_URL.hostname,
    port: Number(DEV_SERVER_URL.port || 80),
    strictPort: true,
    forwardConsole: true,

    hmr: { overlay: false },
    fs: {
      allow: [VITE_WORKSPACE_ROOT],
    },
    watch: {
      ignored: [
        `${BUNDLED_STELLA_DATA_SEED_DIR.replace(/\\/g, "/")},
        `${DIST_ELECTRON_DIR.replace(/\\/g, "/")},

        `${NATIVE_DIR.replace(/\\/g, "/")},
        `${RELEASE_DIR.replace(/\\/g, "/")},
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
