#!/usr/bin/env node

import { build } from "esbuild";
import { builtinModules } from "node:module";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const workerBuildDirectory = path.join(workerRoot, ".wrangler", "worker-build");

/** Keep real import() boundaries; Wrangler's normal bundle flattens them. */
export const buildWorker = async ({ outdir = workerBuildDirectory } = {}) => {
  const result = await build({
    absWorkingDir: workerRoot,
    entryPoints: ["src/index.ts"],
    outdir,
    bundle: true,
    splitting: true,
    format: "esm",
    target: "es2022",
    platform: "browser",
    conditions: ["workerd", "worker", "browser"],
    // nodejs_compat supplies built-ins at runtime. Never replace native
    // subscription dependencies with stubs to shrink the Worker.
    external: ["cloudflare:*", "node:*", ...builtinModules],
    define: { "process.env.NODE_ENV": '"production"' },
    keepNames: true,
    sourcemap: true,
    sourcesContent: true,
    metafile: true,
    write: false,
    logLevel: "warning",
  });
  const modules = Object.entries(result.metafile.outputs)
    .filter(([file]) => file.endsWith(".js"));
  const entry = modules.find(([, output]) => output.entryPoint === "src/index.ts")?.[0];
  if (!entry) throw new Error("Worker build did not emit its entry module.");
  const byPath = new Map(modules);
  const eager = new Set();
  const pending = [entry];
  while (pending.length) {
    const file = pending.pop();
    if (eager.has(file)) continue;
    eager.add(file);
    for (const dependency of byPath.get(file)?.imports ?? []) {
      if (!dependency.external && dependency.kind !== "dynamic-import") pending.push(dependency.path);
    }
  }
  const relativeOutput = (file) => path.relative(outdir, path.resolve(workerRoot, file)).replaceAll(path.sep, "/");
  const manifest = {
    entry: relativeOutput(entry),
    modules: modules.map(([file, output]) => ({
      file: relativeOutput(file),
      bytes: output.bytes,
      imports: output.imports.filter(value => !value.external).map(value => ({
        file: relativeOutput(value.path), dynamic: value.kind === "dynamic-import",
      })),
    })),
    totalBytes: modules.reduce((sum, [, output]) => sum + output.bytes, 0),
    eagerBytes: [...eager].reduce((sum, file) => sum + (byPath.get(file)?.bytes ?? 0), 0),
  };

  // Build completely before replacing the prior output. Failed compilation
  // leaves the last valid artifact intact; old hashed chunks never accumulate.
  await mkdir(path.dirname(outdir), { recursive: true });
  const staging = await mkdtemp(path.join(path.dirname(outdir), ".worker-build-"));
  try {
    await Promise.all(result.outputFiles.map(async file => {
      const relative = path.relative(outdir, file.path);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Worker output escaped its build directory.");
      const target = path.join(staging, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.contents);
    }));
    await writeFile(path.join(staging, "build-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await rm(outdir, { recursive: true, force: true });
    await rename(staging, outdir);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return manifest;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = await buildWorker();
  process.stdout.write(`${JSON.stringify({ event: "cloud_builder_bundle", modules: manifest.modules.length,
    eagerBytes: manifest.eagerBytes, totalBytes: manifest.totalBytes })}\n`);
}
