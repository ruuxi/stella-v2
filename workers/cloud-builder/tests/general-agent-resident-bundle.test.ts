import { describe, expect, test } from "bun:test";
import { build } from "esbuild";

const workerRoot = new URL("..", import.meta.url).pathname;
const ENTRY = "tests/fixtures/resident-import-graph.ts";

/**
 * workerd offers none of these, and `createToolHost` reaches all of them. A
 * resident turn that pulls one in does not fail in a test, it fails when the
 * Worker script is instantiated, taking every unrelated route down with it.
 */
const FORBIDDEN_MODULES: readonly string[] = [
  "child_process",
  "node:child_process",
  "fs",
  "node:fs",
  "fs/promises",
  "node:fs/promises",
  "worker_threads",
  "node:worker_threads",
];

const FORBIDDEN_SOURCES: readonly string[] = [
  "packages/runtime/kernel/tools/host.ts",
  // The daemon and its client are executor-side Node processes. A worker
  // module reaching either would pull `createToolHost` and `node:net` into the
  // Worker script, so the bridge stays a wire the DO writes to, never a
  // module it links against.
  "packages/executor-cloud/src/attached-tool-host.ts",
  "packages/executor-cloud/src/attached-tool-client.ts",
];

const REQUIRED_SOURCES: readonly string[] = [
  ENTRY,
  "src/general-agent-tools.ts",
  "src/agent-compute-ladder.ts",
  "../../packages/executor-cloud/src/attached-tool-protocol.ts",
  "../../packages/executor-cloud/src/general-agent-prompt.ts",
  "../../packages/executor-cloud/src/agent-history.ts",
  "../../packages/executor-cloud/src/prune-history.ts",
  "../../packages/runtime/kernel/tools/defs/exec-command-def.ts",
  "../../packages/runtime/kernel/tools/defs/write-stdin-def.ts",
  "../../packages/runtime/kernel/tools/defs/read-def.ts",
  "../../packages/runtime/kernel/tools/defs/apply-patch-def.ts",
  "../../packages/runtime/kernel/tools/defs/code-def.ts",
  "../../packages/runtime/kernel/tools/defs/web-def.ts",
  "../../packages/runtime/kernel/tools/defs/agent-orchestration-def.ts",
];

type ResidentGraph = {
  readonly files: readonly string[];
  readonly externals: ReadonlyMap<string, readonly string[]>;
};

const buildResidentGraph = async (): Promise<ResidentGraph> => {
  const result = await build({
    absWorkingDir: workerRoot,
    entryPoints: [ENTRY],
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    platform: "node",
    conditions: ["workerd", "worker", "browser"],
    logLevel: "silent",
  });
  const externals = new Map<string, readonly string[]>();
  for (const [file, input] of Object.entries(result.metafile.inputs)) {
    for (const edge of input.imports) {
      if (!edge.external) continue;
      externals.set(edge.path, [...(externals.get(edge.path) ?? []), file]);
    }
  }
  return { files: Object.keys(result.metafile.inputs), externals };
};

const graph = buildResidentGraph();

describe("resident general-agent import graph", () => {
  test("covers every module the resident turn loads", async () => {
    const { files } = await graph;
    for (const source of REQUIRED_SOURCES) expect(files).toContain(source);
  });

  test("reaches no Node builtin workerd lacks", async () => {
    const { externals } = await graph;
    const violations = FORBIDDEN_MODULES.flatMap((specifier) =>
      (externals.get(specifier) ?? []).map(
        (importer) => `${importer} imports ${specifier}`,
      ),
    );
    expect(violations).toEqual([]);
  });

  test("reaches no Node-only source file, createToolHost above all", async () => {
    const { files } = await graph;
    const violations = files.filter((file) =>
      FORBIDDEN_SOURCES.some((source) => file.endsWith(source)),
    );
    expect(violations).toEqual([]);
  });
});
