import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { SourceTools } from "./tools.js";

/**
 * Pre-bundles the renderer's npm dependencies into ESM chunks the source
 * server hands out at `/@deps/<entry>.js`. One entry per resolved dependency
 * file (two packages can depend on different copies of the same name), all
 * built together so shared code like React is one instance.
 *
 * An ESM entry keeps its own exports. A CommonJS entry gets a facade that
 * names its exports (found statically, the way Node finds them), so source
 * modules can `import { useState } from "react"`.
 *
 * The bundle is cached on disk, keyed by the lockfile and the entry set, and
 * only rebuilt when either changes.
 */

export type DepBundle = {
  dir: string;
  /** Resolved dependency file → entry file name inside `dir`. */
  entries: Map<string, string>;
};

const BUNDLE_FORMAT_VERSION = "1";
const FACADE_PREFIX = "\0stella-facade:";

const entryName = (file: string): string => {
  const marker = "/node_modules/";
  const normalized = file.replace(/\\/g, "/");
  const index = normalized.lastIndexOf(marker);
  const tail = index >= 0 ? normalized.slice(index + marker.length) : path.basename(file);
  const readable = tail.replace(/\.[cm]?js$/, "").replace(/[^a-zA-Z0-9]+/g, "_").slice(-60);
  const digest = createHash("sha256").update(file).digest("hex").slice(0, 8);
  return `${readable}-${digest}`;
};

const hasModuleSyntax = (tools: SourceTools, file: string): boolean => {
  if (file.endsWith(".mjs")) return true;
  if (file.endsWith(".cjs")) return false;
  try {
    return tools.parseSync(file, fs.readFileSync(file, "utf8")).module.hasModuleSyntax;
  } catch {
    return false;
  }
};

/** The names a CommonJS file exports, following `module.exports = require(...)`. */
const commonJsExportNames = (
  tools: SourceTools,
  file: string,
  seen = new Set<string>(),
): Set<string> => {
  const names = new Set<string>();
  if (seen.has(file)) return names;
  seen.add(file);
  let parsed: { exports: string[]; reexports: string[] };
  try {
    parsed = tools.parseCommonJs(fs.readFileSync(file, "utf8"));
  } catch {
    return names;
  }
  for (const name of parsed.exports) names.add(name);
  const requireFrom = createRequire(file);
  for (const target of parsed.reexports) {
    try {
      for (const name of commonJsExportNames(tools, requireFrom.resolve(target), seen)) {
        names.add(name);
      }
    } catch {
      // An unresolvable reexport just contributes nothing.
    }
  }
  return names;
};

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const RESERVED = new Set(["default", "__esModule", "import", "export", "class", "function", "delete", "new", "this", "var", "let", "const", "enum", "await", "yield"]);

const facadeSource = (tools: SourceTools, file: string): string => {
  const names = [...commonJsExportNames(tools, file)].filter(
    (name) => IDENTIFIER.test(name) && !RESERVED.has(name),
  );
  const target = JSON.stringify(file);
  return [
    `import * as namespace from ${target};`,
    `const mod = namespace.default ?? namespace;`,
    `export default mod;`,
    ...(names.length > 0 ? [`export const { ${names.join(", ")} } = mod;`] : []),
  ].join("\n");
};

const fileDigest = (file: string): string => {
  try {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return "missing";
  }
};

export const bundleDependencies = async (options: {
  tools: SourceTools;
  files: Iterable<string>;
  cacheDir: string;
  lockfile: string;
  mode: string;
  log: (message: string) => void;
}): Promise<DepBundle> => {
  const files = [...new Set(options.files)].sort();
  const key = createHash("sha256")
    .update(
      JSON.stringify([BUNDLE_FORMAT_VERSION, options.mode, fileDigest(options.lockfile), files]),
    )
    .digest("hex")
    .slice(0, 16);
  const dir = path.join(options.cacheDir, "deps", key);
  const manifestPath = path.join(dir, "manifest.json");
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, string>;
    return { dir, entries: new Map(Object.entries(manifest)) };
  } catch {
    // Not built yet.
  }

  const { tools } = options;
  const startedAt = Date.now();
  const entries = new Map<string, string>();
  const input: Record<string, string> = {};
  const facades = new Map<string, string>();
  for (const file of files) {
    const name = entryName(file);
    entries.set(file, `${name}.js`);
    if (hasModuleSyntax(tools, file)) {
      input[name] = file;
    } else {
      input[name] = `${FACADE_PREFIX}${file}`;
      facades.set(`${FACADE_PREFIX}${file}`, facadeSource(tools, file));
    }
  }

  const staging = `${dir}.tmp-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  const bundle = await tools.rolldown({
    input,
    platform: "browser",
    transform: {
      define: {
        "process.env.NODE_ENV": JSON.stringify(options.mode === "production" ? "production" : "development"),
        global: "globalThis",
      },
    },
    plugins: [
      {
        name: "stella-cjs-facades",
        resolveId: (id) => (facades.has(id) ? id : null),
        load: (id) => facades.get(id) ?? null,
      },
    ],
    onLog: (level, log) => {
      if (level === "warn" && log.code === "IMPORT_IS_UNDEFINED") return;
      if (level === "warn" || level === "info") return;
      options.log(`[deps] ${log.message}`);
    },
  });
  try {
    await bundle.write({
      dir: staging,
      format: "esm",
      entryFileNames: "[name].js",
      chunkFileNames: "chunk-[hash].js",
      assetFileNames: "asset-[hash][extname]",
    });
  } finally {
    await bundle.close();
  }
  fs.writeFileSync(path.join(staging, "manifest.json"), JSON.stringify(Object.fromEntries(entries)));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(staging, dir);
  options.log(`[deps] bundled ${files.length} dependencies in ${Date.now() - startedAt}ms`);
  return { dir, entries };
};
