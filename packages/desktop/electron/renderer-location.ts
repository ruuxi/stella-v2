import fs from "node:fs";
import path from "node:path";

const DEFAULT_DEV_SERVER_URL = "http://127.0.0.1:57315";

export const getDevServerUrl = (): string =>
  process.env.STELLA_DEV_SERVER_URL?.trim() || DEFAULT_DEV_SERVER_URL;

export const resolveRendererRoot = (electronDir: string): string => {
  const candidates = [
    // Packaged app: app.asar/renderer.
    path.resolve(electronDir, "../../renderer"),
    // Monorepo build output: packages/desktop-ui/dist.
    path.resolve(electronDir, "../../../desktop-ui/dist"),
  ];
  return (
    candidates.find((candidate) => {
      try {
        return fs.statSync(candidate).isDirectory();
      } catch {
        return false;
      }
    }) ?? candidates[0]
  );
};
