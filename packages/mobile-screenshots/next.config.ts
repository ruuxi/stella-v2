import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(rootDir, "../..");

const nextConfig: NextConfig = {
  devIndicators: false,
  turbopack: {
    root: workspaceRoot,
  },
};

export default nextConfig;
