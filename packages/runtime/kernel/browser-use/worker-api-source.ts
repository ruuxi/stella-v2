import path from "node:path";

/**
 * `installBrowserWorkerApi` as source for the Node REPL worker.
 *
 * That worker is started from a source string (computer-use/kernel-worker.ts),
 * so it cannot import worker-api.ts. Instead the module and the worker-api/
 * modules it imports are bundled into one self-contained expression when this
 * module loads: one Bun.build from the source tree per process, about 10ms,
 * with no build step and no generated file. The runtime always runs from
 * source on Bun. Anything else, or a failed build, surfaces when a kernel
 * starts, not when this module is imported.
 */
const bundleBrowserWorkerApi = async (): Promise<string> => {
  const bun = (globalThis as typeof globalThis & { Bun?: typeof Bun }).Bun;
  if (!bun) {
    throw new Error(
      "The Node REPL browser API is bundled with Bun.build; run the runtime under Bun.",
    );
  }
  const packageImports: string[] = [];
  const result = await bun.build({
    entrypoints: [path.join(import.meta.dirname, "worker-api.ts")],
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
  if (packageImports.length > 0) {
    throw new Error(
      `The browser worker API must import only its own modules: ${packageImports.join("; ")}.`,
    );
  }
  const [output] = result.outputs;
  if (!result.success || !output || result.outputs.length !== 1) {
    throw new AggregateError(
      result.logs,
      "Bundling the Node REPL browser API failed.",
    );
  }
  const code = await output.text();
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
