#!/usr/bin/env node
// Stella's own code for the sandbox container, built at deploy time and
// delivered when a container starts instead of being baked into the image.
//
// The image changes only when the OS, its tools or the third-party
// dependencies change (Dockerfile + sandbox-image.bun.lock), so a deploy of
// Stella source keeps the image digest and with it every owner's container
// snapshot. This module packs the workspace sources the executor runs into one
// deterministic tar.gz named by its SHA-256. The Worker serves it as a static
// asset of its own version and compiles the same hash in, and the container
// refuses any bytes whose hash differs (`sandbox-bin/stella-code-install`).
//
// The archive mirrors the image's old `/opt/stella` layout so the runtime's
// root discovery (`package.json` + `packages/runtime`) and every
// `import.meta`-relative path keep working:
//
//   package.json
//   packages/{contracts,runtime,executor-cloud,model-catalog}/...
//   packages/stella-office -> /opt/stella/packages/stella-office   (image)
//   node_modules/@stella/<name> -> ../../packages/<name>
//
// The install step links every other `node_modules` entry to the image's
// third-party install.

import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { isEntryPoint } from "../../../scripts/lib/entry-point.mjs";

const workerRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.resolve(workerRoot, "..", "..");

/** The workspace packages the cloud executor loads, as `@stella/<name>`. */
export const SANDBOX_CODE_PACKAGES = Object.freeze([
  "contracts",
  "runtime",
  "executor-cloud",
  "model-catalog",
]);

/** Where the Worker's static assets live and where the bundle sits in them. */
export const sandboxCodeAssetsDirectory = path.join(
  workerRoot,
  ".wrangler",
  "sandbox-code",
);
export const SANDBOX_CODE_ASSET_PREFIX = "sandbox-code";

/**
 * Never shipped: installs, VCS state, and tests, which nothing in a container
 * loads. Everything else in a package ships, because runtime code reads JSON
 * catalogs and markdown beside its sources.
 */
const isExcluded = (relative) => {
  const segments = relative.split("/");
  return (
    segments.includes("node_modules") ||
    segments.includes(".git") ||
    segments.includes("test-fixtures") ||
    segments[0] === "tests" ||
    /\.test\.[cm]?[jt]sx?$/u.test(relative)
  );
};

const collect = async (packageName) => {
  const root = path.join(repoRoot, "packages", packageName);
  const entries = [];
  const walk = async (relative) => {
    const absolute = path.join(root, relative);
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (isExcluded(child)) continue;
      if (entry.isDirectory()) {
        entries.push({ kind: "directory", path: child });
        await walk(child);
      } else if (entry.isFile()) {
        const info = await lstat(path.join(root, child));
        entries.push({
          kind: "file",
          path: child,
          executable: (info.mode & 0o111) !== 0,
          bytes: await readFile(path.join(root, child)),
        });
      } else {
        throw new Error(
          `packages/${packageName}/${child} is neither a file nor a directory; the sandbox code bundle ships only plain files.`,
        );
      }
    }
  };
  await walk("");
  return entries.map((entry) => ({
    ...entry,
    path: `packages/${packageName}/${entry.path}`,
  }));
};

const encoder = new TextEncoder();

/** One ustar header. Owner root, fixed mtime: the archive is a function of its contents. */
const header = ({ name, mode, size, type, linkname = "" }) => {
  const block = new Uint8Array(512);
  let prefix = "";
  let base = name;
  if (encoder.encode(name).length > 100) {
    const split = name.lastIndexOf("/", 155);
    prefix = name.slice(0, split);
    base = name.slice(split + 1);
    if (
      split <= 0 ||
      encoder.encode(prefix).length > 155 ||
      encoder.encode(base).length > 100
    ) {
      throw new Error(`Path is too long for the sandbox code archive: ${name}`);
    }
  }
  const put = (offset, length, value) => {
    const bytes = encoder.encode(value);
    if (bytes.length > length) throw new Error(`Tar field overflow: ${value}`);
    block.set(bytes, offset);
  };
  const octal = (offset, length, value) =>
    put(offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
  put(0, 100, base);
  octal(100, 8, mode);
  octal(108, 8, 0);
  octal(116, 8, 0);
  octal(124, 12, size);
  octal(136, 12, 0);
  block.fill(0x20, 148, 156);
  put(156, 1, type);
  put(157, 100, linkname);
  put(257, 6, "ustar\0");
  put(263, 2, "00");
  put(265, 32, "root");
  put(297, 32, "root");
  put(345, 155, prefix);
  let checksum = 0;
  for (const byte of block) checksum += byte;
  put(148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return block;
};

const tar = (entries) => {
  const chunks = [];
  for (const entry of entries) {
    if (entry.kind === "directory") {
      chunks.push(
        header({ name: `${entry.path}/`, mode: 0o755, size: 0, type: "5" }),
      );
    } else if (entry.kind === "symlink") {
      chunks.push(
        header({
          name: entry.path,
          mode: 0o777,
          size: 0,
          type: "2",
          linkname: entry.target,
        }),
      );
    } else {
      chunks.push(
        header({
          name: entry.path,
          mode: entry.executable ? 0o755 : 0o644,
          size: entry.bytes.length,
          type: "0",
        }),
        entry.bytes,
      );
      const padding = (512 - (entry.bytes.length % 512)) % 512;
      if (padding) chunks.push(new Uint8Array(padding));
    }
  }
  chunks.push(new Uint8Array(1024));
  return Buffer.concat(chunks);
};

/**
 * Pack the sandbox code and write it into the Worker's assets directory as
 * `sandbox-code/<sha256>.tar.gz`, replacing any earlier bundle there.
 */
export const buildSandboxCode = async ({
  assetsDirectory = sandboxCodeAssetsDirectory,
} = {}) => {
  const entries = [
    { kind: "directory", path: "node_modules" },
    { kind: "directory", path: "node_modules/@stella" },
    { kind: "directory", path: "packages" },
    {
      kind: "file",
      path: "package.json",
      executable: false,
      bytes: Buffer.from(
        `${JSON.stringify(
          { name: "stella-sandbox-code", private: true, type: "module" },
          null,
          2,
        )}\n`,
      ),
    },
    // The office CLI and its native binary stay in the image.
    {
      kind: "symlink",
      path: "packages/stella-office",
      target: "/opt/stella/packages/stella-office",
    },
  ];
  for (const packageName of SANDBOX_CODE_PACKAGES) {
    const manifest = JSON.parse(
      await readFile(
        path.join(repoRoot, "packages", packageName, "package.json"),
        "utf8",
      ),
    );
    if (manifest.name !== `@stella/${packageName}`) {
      throw new Error(
        `packages/${packageName} is ${manifest.name}, not @stella/${packageName}.`,
      );
    }
    entries.push(
      { kind: "directory", path: `packages/${packageName}` },
      {
        kind: "symlink",
        path: `node_modules/@stella/${packageName}`,
        target: `../../packages/${packageName}`,
      },
      ...(await collect(packageName)),
    );
  }
  entries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const archive = gzipSync(tar(entries), { level: 9 });
  const sha256 = createHash("sha256").update(archive).digest("hex");
  const directory = path.join(assetsDirectory, SANDBOX_CODE_ASSET_PREFIX);
  await rm(assetsDirectory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${sha256}.tar.gz`);
  await writeFile(file, archive);
  return {
    sha256,
    bytes: archive.length,
    files: entries.filter((entry) => entry.kind === "file").length,
    sourceBytes: entries.reduce(
      (sum, entry) => sum + (entry.kind === "file" ? entry.bytes.length : 0),
      0,
    ),
    file,
  };
};

if (isEntryPoint(import.meta.url)) {
  const bundle = await buildSandboxCode();
  process.stdout.write(
    `${JSON.stringify({
      event: "sandbox_code_bundle",
      sha256: bundle.sha256,
      bytes: bundle.bytes,
      files: bundle.files,
      sourceBytes: bundle.sourceBytes,
      file: path.relative(workerRoot, bundle.file),
    })}\n`,
  );
}
