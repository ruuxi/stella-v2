import fs from "node:fs";
import path from "node:path";

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
