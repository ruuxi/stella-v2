/**
 * Deterministic Stella-interior candidate builder.
 *
 * This runs inside the cloud sandbox after a successful general-agent turn.
 * It owns source/output bounds and artifact hashing; the Worker independently
 * rechecks every output before putting bytes in R2.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { injectStellaRendererCsp } from "./interior-security.js";

const MAX_SOURCE_FILES = 5_000;
const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const MAX_ARTIFACT_FILES = 2_000;
const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const MAX_ARTIFACT_FILE_BYTES = 25 * 1024 * 1024;
const REQUIRED_ENTRIES = {
  full: "index.html",
  mini: "mini.html",
  overlay: "overlay.html",
  pet: "pet.html",
} as const;
const SOURCE_EXCLUDES = new Set(["node_modules", "dist", ".stella", ".git"]);

type HashedFile = {
  path: string;
  size: number;
  sha256: string;
  contentType: string;
};

type InteriorBuildResult = {
  schemaVersion: 1;
  sourceRevision: string;
  baseRevision?: string;
  upstreamSeedRevision: string;
  outputRoot: string;
  entries: typeof REQUIRED_ENTRIES;
  files: HashedFile[];
  artifactSha256: string;
  size: number;
};

type InteriorPublicBuildConfig = {
  convexUrl: string;
  convexSiteUrl: string;
  appsHost: string;
};

const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

const normalizeRelative = (root: string, absolute: string): string => {
  const relative = path.relative(root, absolute).split(path.sep).join("/");
  if (
    !relative ||
    relative.startsWith("/") ||
    relative === ".." ||
    relative.startsWith("../") ||
    relative.includes("\0")
  ) {
    throw new Error(`Unsafe interior path: ${relative || "(empty)"}`);
  }
  return relative;
};

const listRegularFiles = async (args: {
  root: string;
  maxFiles: number;
  maxBytes: number;
  maxFileBytes?: number;
  excludeTopLevel?: Set<string>;
}): Promise<Array<{ absolute: string; relative: string; size: number }>> => {
  const root = await realpath(args.root);
  const files: Array<{ absolute: string; relative: string; size: number }> = [];
  let bytes = 0;
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const relative = normalizeRelative(root, absolute);
      const topLevel = relative.split("/", 1)[0] ?? relative;
      if (args.excludeTopLevel?.has(topLevel)) continue;
      if (entry.isSymbolicLink()) {
        // `node_modules` is the only expected symlink and is excluded above.
        // Following any other link would allow artifact/source traversal.
        throw new Error(`Interior source contains a symlink: ${relative}`);
      }
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Interior source contains a special file: ${relative}`);
      }
      const details = await lstat(absolute);
      if (
        args.maxFileBytes !== undefined &&
        details.size > args.maxFileBytes
      ) {
        throw new Error(`Interior file is too large: ${relative}`);
      }
      bytes += details.size;
      if (bytes > args.maxBytes) {
        throw new Error("The Stella interior exceeds its total size limit.");
      }
      files.push({ absolute, relative, size: details.size });
      if (files.length > args.maxFiles) {
        throw new Error("The Stella interior contains too many files.");
      }
    }
  };
  await walk(root);
  files.sort((left, right) =>
    left.relative < right.relative
      ? -1
      : left.relative > right.relative
        ? 1
        : 0,
  );
  return files;
};

const digestFiles = async (
  files: Array<{ absolute: string; relative: string; size: number }>,
): Promise<{ digest: string; bytes: number; hashes: Map<string, string> }> => {
  const aggregate = createHash("sha256");
  const hashes = new Map<string, string>();
  let bytes = 0;
  for (const file of files) {
    const hash = sha256(await readFile(file.absolute));
    hashes.set(file.relative, hash);
    bytes += file.size;
    aggregate.update(file.relative);
    aggregate.update("\0");
    aggregate.update(String(file.size));
    aggregate.update("\0");
    aggregate.update(hash);
    aggregate.update("\n");
  }
  return { digest: aggregate.digest("hex"), bytes, hashes };
};

const contentType = (relative: string): string => {
  const extension = path.extname(relative).toLowerCase();
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".mjs": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".map": "application/json",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif",
      ".ico": "image/x-icon",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
      ".ttf": "font/ttf",
      ".wasm": "application/wasm",
      ".webmanifest": "application/manifest+json",
      ".txt": "text/plain; charset=utf-8",
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
    }[extension] ?? "application/octet-stream"
  );
};

const requireHttpsOrigin = (value: string | undefined, label: string) => {
  try {
    const parsed = new URL(value?.trim() ?? "");
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error("not an origin");
    }
    return parsed.origin;
  } catch {
    throw new Error(`${label} must be configured as an HTTPS origin.`);
  }
};

const readPublicBuildConfig = (): InteriorPublicBuildConfig => ({
  convexUrl: requireHttpsOrigin(
    process.env.VITE_CONVEX_URL,
    "VITE_CONVEX_URL",
  ),
  convexSiteUrl: requireHttpsOrigin(
    process.env.VITE_CONVEX_SITE_URL,
    "VITE_CONVEX_SITE_URL",
  ),
  appsHost: requireHttpsOrigin(
    process.env.VITE_STELLA_APPS_HOST,
    "VITE_STELLA_APPS_HOST",
  ),
});

const verifyPublicBuildConfig = async (
  files: Array<{ absolute: string; relative: string }>,
  config: InteriorPublicBuildConfig,
): Promise<void> => {
  const searchable = files.filter(
    (file) =>
      file.relative.endsWith(".html") ||
      file.relative.endsWith(".js") ||
      file.relative.endsWith(".mjs"),
  );
  const output = (
    await Promise.all(searchable.map((file) => readFile(file.absolute, "utf8")))
  ).join("\n");
  for (const [label, value] of Object.entries(config)) {
    if (!output.includes(value)) {
      throw new Error(`Interior build did not embed its ${label} origin.`);
    }
  }
  if (output.includes("http://127.0.0.1:3210")) {
    throw new Error("Interior build retained the loopback Convex fallback.");
  }
  const sourceFallback =
    "https://stella-v2-apps-host-dev.lolruuxi.workers.dev";
  if (
    config.appsHost !== sourceFallback &&
    output.includes(sourceFallback)
  ) {
    throw new Error("Interior build retained the source apps-host fallback.");
  }
};

const runVite = async (sourceRoot: string, outputRoot: string): Promise<void> => {
  const configPath = fileURLToPath(
    new URL("./interior-vite.config.ts", import.meta.url),
  );
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "/usr/local/bin/vite",
      ["build", "--config", configPath],
      {
        cwd: sourceRoot,
        env: {
          ...process.env,
          STELLA_INTERIOR_SOURCE_ROOT: sourceRoot,
          STELLA_INTERIOR_OUTPUT_ROOT: outputRoot,
        },
        stdio: ["ignore", "inherit", "inherit"],
      },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `Interior production build failed (${signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`}).`,
          ),
        );
    });
  });
};

const main = async (): Promise<InteriorBuildResult> => {
  const publicBuildConfig = readPublicBuildConfig();
  const sourceRoot = path.resolve(
    process.env.STELLA_INTERIOR_SOURCE_ROOT ?? "/workspace/stella",
  );
  const outputRoot = path.resolve(
    process.env.STELLA_INTERIOR_OUTPUT_ROOT ??
      "/workspace/.stella-interior-build/dist",
  );
  if (
    sourceRoot !== "/workspace/stella" ||
    !outputRoot.startsWith("/workspace/.stella-interior-build/")
  ) {
    throw new Error("Interior build paths are outside their allowed roots.");
  }

  const sourceFiles = await listRegularFiles({
    root: sourceRoot,
    maxFiles: MAX_SOURCE_FILES,
    maxBytes: MAX_SOURCE_BYTES,
    excludeTopLevel: SOURCE_EXCLUDES,
  });
  const source = await digestFiles(sourceFiles);
  const sourceRevision = `sha256:${source.digest}`;
  const revisionState = await readFile(
    path.join(sourceRoot, ".stella", "interior-source.json"),
    "utf8",
  )
    .then(
      (raw) =>
        JSON.parse(raw) as {
          sourceRevision?: unknown;
          upstreamSeedRevision?: unknown;
        },
    )
    .catch(() => null);
  const baseRevision =
    typeof revisionState?.sourceRevision === "string" &&
    /^sha256:[0-9a-f]{64}$/.test(revisionState.sourceRevision)
      ? revisionState.sourceRevision
      : undefined;
  const upstreamSeedRevision =
    typeof revisionState?.upstreamSeedRevision === "string" &&
    /^sha256:[0-9a-f]{64}$/.test(revisionState.upstreamSeedRevision)
      ? revisionState.upstreamSeedRevision
      : baseRevision;
  if (!upstreamSeedRevision) {
    throw new Error("Interior source is missing its upstream seed revision.");
  }

  await rm(path.dirname(outputRoot), { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  await runVite(sourceRoot, outputRoot);

  await Promise.all(
    Object.values(REQUIRED_ENTRIES).map(async (entry) => {
      const entryPath = path.join(outputRoot, entry);
      const html = await readFile(entryPath, "utf8");
      await writeFile(entryPath, injectStellaRendererCsp(html), "utf8");
    }),
  );

  for (const entry of Object.values(REQUIRED_ENTRIES)) {
    const details = await lstat(path.join(outputRoot, entry)).catch(() => null);
    if (!details?.isFile()) {
      throw new Error(`Interior build is missing required entrypoint ${entry}.`);
    }
  }
  const artifactFiles = await listRegularFiles({
    root: outputRoot,
    maxFiles: MAX_ARTIFACT_FILES,
    maxBytes: MAX_ARTIFACT_BYTES,
    maxFileBytes: MAX_ARTIFACT_FILE_BYTES,
  });
  if (!artifactFiles.some((file) => file.relative.startsWith("assets/"))) {
    throw new Error("Interior build did not produce an assets directory.");
  }
  await verifyPublicBuildConfig(artifactFiles, publicBuildConfig);
  const artifact = await digestFiles(artifactFiles);
  const files: HashedFile[] = artifactFiles.map((file) => ({
    path: file.relative,
    size: file.size,
    sha256: artifact.hashes.get(file.relative) as string,
    contentType: contentType(file.relative),
  }));
  // Shared producer/desktop contract: artifactSha256 is over the canonical
  // JSON projection, with files already sorted lexicographically by path.
  // contentType and future manifest metadata do not change byte identity.
  const artifactSha256 = sha256(
    JSON.stringify(
      files.map(({ path: filePath, size, sha256: fileSha256 }) => ({
        path: filePath,
        size,
        sha256: fileSha256,
      })),
    ),
  );
  return {
    schemaVersion: 1,
    sourceRevision,
    ...(baseRevision ? { baseRevision } : {}),
    upstreamSeedRevision,
    outputRoot,
    entries: REQUIRED_ENTRIES,
    files,
    artifactSha256,
    size: artifact.bytes,
  };
};

const result = await main();
process.stdout.write(`${JSON.stringify(result)}\n`);
