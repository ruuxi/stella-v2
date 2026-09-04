/**
 * Production-only config for a Stella interior build.
 *
 * The editable world contains the renderer source, while this config and
 * all build tooling come from the immutable sandbox image. That separation is
 * intentional: an agent may change Stella's web interior, but it cannot
 * redefine what the candidate builder reads, where it writes, or which entry
 * points are required.
 */

import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import {
  createInteriorBridgePlugin,
  readInteriorBridgeRuntimeOptions,
} from "./interior-bridge-runtime.js";

const workspaceRoot = path.resolve(
  process.env.STELLA_INTERIOR_SOURCE_ROOT ?? "/workspace/world/stella",
);
const outputRoot = path.resolve(
  process.env.STELLA_INTERIOR_OUTPUT_ROOT ??
    "/workspace/.stella-interior-build/dist",
);

export default defineConfig({
  root: workspaceRoot,
  base: "./",
  publicDir: path.join(workspaceRoot, "public"),
  plugins: [
    createInteriorBridgePlugin(readInteriorBridgeRuntimeOptions()),
    react(),
    tailwindcss(),
  ],
  build: {
    outDir: outputRoot,
    emptyOutDir: true,
    target: "esnext",
    modulePreload: { polyfill: false },
    rolldownOptions: {
      input: {
        full: path.join(workspaceRoot, "index.html"),
        mini: path.join(workspaceRoot, "mini.html"),
        overlay: path.join(workspaceRoot, "overlay.html"),
      },
    },
  },
  resolve: {
    alias: {
      "@": path.join(workspaceRoot, "src"),
    },
    dedupe: ["react", "react-dom"],
  },
});
