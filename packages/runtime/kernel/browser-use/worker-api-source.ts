import path from "node:path";

/**
 * `installBrowserWorkerApi` as source for the Node REPL worker.
 *
 * That worker is started from a source string (computer-use/kernel-worker.ts),
 * so it cannot import worker-api.ts. Instead the module and the worker-api/
 * modules it imports are bundled into one self-contained expression when this
 * module loads: one Bun.build from the source tree per process, about 10ms,
 * with no build step and no generated file. The runtime always runs from
 * source on Bun; only Node-hosted tooling (vitest) takes the esbuild fallback
 * below. A failed build surfaces when a kernel starts, not when this module
 * is imported.
 */
const ENTRYPOINT = path.join(import.meta.dirname, "worker-api.ts");

const selfContainedError = (packageImports: readonly string[]): Error =>
  new Error(
    `The browser worker API must import only its own modules: ${packageImports.join("; ")}.`,
  );

const bundleWithBun = async (bun: typeof Bun): Promise<string> => {
  const packageImports: string[] = [];
  const result = await bun.build({
    entrypoints: [ENTRYPOINT],
    // Plain JavaScript with no Node runtime helpers: the worker API uses no
    // platform APIs, and the eval worker has no module loader for them.
    target: "browser",
    format: "cjs",
    throw: false,
    plugins: [
      {
        name: "browser-worker-api-self-contained",
        setup(build) {
          build.onResolve(
            { filter: /^[^./]/ },
            ({ path: specifier, importer }) => {
              packageImports.push(`${importer} imports ${specifier}`);
              return { path: specifier, external: true };
            },
          );
        },
      },
    ],
  });
  if (packageImports.length > 0) throw selfContainedError(packageImports);
  const [output] = result.outputs;
  if (!result.success || !output || result.outputs.length !== 1) {
    throw new AggregateError(
      result.logs,
      "Bundling the Node REPL browser API failed.",
    );
  }
  return output.text();
};

/** Same bundle under Node, where Bun.build does not exist (vitest). */
const bundleWithEsbuild = async (): Promise<string> => {
  const esbuild = await import("esbuild");
  const packageImports: string[] = [];
  const result = await esbuild.build({
    entryPoints: [ENTRYPOINT],
    bundle: true,
    write: false,
    platform: "browser",
    format: "cjs",
    logLevel: "silent",
    plugins: [
      {
        name: "browser-worker-api-self-contained",
        setup(build) {
          build.onResolve(
            { filter: /^[^./]/ },
            ({ path: specifier, importer, kind }) => {
              if (kind === "entry-point") return undefined;
              packageImports.push(`${importer} imports ${specifier}`);
              return { path: specifier, external: true };
            },
          );
        },
      },
    ],
  });
  if (packageImports.length > 0) throw selfContainedError(packageImports);
  const [output] = result.outputFiles;
  if (!output || result.outputFiles.length !== 1) {
    throw new Error("Bundling the Node REPL browser API failed.");
  }
  return output.text;
};

const bundleBrowserWorkerApi = async (): Promise<string> => {
  const bun = (globalThis as typeof globalThis & { Bun?: typeof Bun }).Bun;
  const code = bun ? await bundleWithBun(bun) : await bundleWithEsbuild();
  return `(() => {\nconst module = { exports: {} };\nconst exports = module.exports;\n${code}\nreturn module.exports.installBrowserWorkerApi;\n})()`;
};

const bundled: Readonly<{ source: string } | { error: unknown }> =
  await bundleBrowserWorkerApi().then(
    (source) => ({ source }),
    (error: unknown) => ({ error }),
  );

/** An expression evaluating to `installBrowserWorkerApi`. */
export const browserWorkerApiSource = (): string => {
  if ("error" in bundled) throw bundled.error;
  return bundled.source;
};
