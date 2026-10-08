import { WORLD_ROOT } from "../workspace.js";
import { WORLD_PATH_LIMIT_BYTES } from "./types.js";

const pathBytes = (path: string): number =>
  new TextEncoder().encode(path).byteLength;

export const normalizeWorldPath = (
  input: string,
  options: { allowRoot?: boolean } = {},
): string => {
  if (input === "" && options.allowRoot) return "";
  if (
    input.startsWith("/") ||
    input.includes("\\") ||
    input.includes("\0") ||
    input.endsWith("/")
  ) {
    throw new Error(`Invalid world-relative path: ${input}`);
  }
  const segments = input.split("/");
  if (
    segments.length === 0 ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    ) ||
    pathBytes(input) > WORLD_PATH_LIMIT_BYTES
  ) {
    throw new Error(`Invalid world-relative path: ${input}`);
  }
  return segments.join("/");
};

/**
 * The world is the cloud agent's HOME, so `~` and `$HOME` name its root in a
 * file tool exactly as they do in the agent's shell.
 */
export const expandWorldHome = (
  value: string,
  root: string = WORLD_ROOT,
): string => value.replace(/^(?:~|\$HOME|\$\{HOME\})(?=$|\/)/u, () => root);

export const worldRelativeToolPath = (
  value: unknown,
  root: string = WORLD_ROOT,
): string => {
  const raw = expandWorldHome(String(value ?? ""), root);
  if (!raw.startsWith("/")) {
    throw new Error(
      `File tool paths must be absolute. Received relative path '${raw}'. ` +
        "Pass a full absolute path (e.g. /Users/you/projects/foo/bar.ts); " +
        "the file tools do not resolve relative to the shell's working directory.",
    );
  }
  const segments: string[] = [];
  for (const segment of raw.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  const resolved = `/${segments.join("/")}`;
  if (resolved === root) return "";
  const prefix = `${root}/`;
  if (!resolved.startsWith(prefix)) {
    throw new Error("Path is outside this agent's workspace.");
  }
  return normalizeWorldPath(resolved.slice(prefix.length));
};

export const absoluteWorldPath = (
  path: string,
  root: string = WORLD_ROOT,
): string => (path === "" ? root : `${root}/${path}`);

export const parentPath = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
};

export const baseName = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? path : path.slice(slash + 1);
};

export const pathWithin = (path: string, prefix: string): boolean =>
  prefix === "" || path === prefix || path.startsWith(`${prefix}/`);

/**
 * The owner's drive, as the world names it. The drive is its own store (the
 * owner object's rows and the drive's R2 bucket); a sandbox keeps a working
 * copy of it under the world root, and the world never stores, exports or
 * counts that copy.
 */
export const WORLD_DRIVE_DIR = "drive";

export const isWorldDrivePath = (path: string): boolean =>
  pathWithin(path, WORLD_DRIVE_DIR);
