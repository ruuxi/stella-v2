import os from "node:os";
import path from "node:path";

/**
 * Node-only path helper, deliberately not in `safety.ts`: that module's text
 * redaction runs in workerd too (the cloud `web` tool sanitizes fetched pages
 * with it), and a top-level `node:os` import there would break the worker
 * bundle.
 */
export const resolveHomeRelative = (candidate: string): string => {
  const expanded = candidate.replace(/^~(?=$|[\\/])/, os.homedir());
  return path.resolve(expanded);
};
