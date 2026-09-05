import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWorker } from "../scripts/build-worker.mjs";
import { startWorkerdDev, type WorkerdDev } from "./helpers/workerd-dev.js";

const pause = async (delayMs: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
};

describe("Split Worker build in real Workerd", () => {
  let buildPath = "";
  let outdir = "";
  let manifest: Awaited<ReturnType<typeof buildWorker>>;
  let dev: WorkerdDev;

  beforeAll(async () => {
    buildPath = await mkdtemp(join(tmpdir(), "stella-split-worker-build-"));
    outdir = join(buildPath, "bundle");
    await buildWorker({ outdir });
    await writeFile(
      join(outdir, "obsolete-chunk.js"),
      "throw new Error('obsolete bundle');",
    );
    manifest = await buildWorker({ outdir });
    const imports = manifest.modules
      .map((module) => `import(${JSON.stringify(`./${module.file}`)})`)
      .join(",");
    const smoke = await readFile(
      new URL("./fixtures/split-worker-build-smoke.js", import.meta.url),
      "utf8",
    );
    await writeFile(
      join(outdir, "smoke.js"),
      smoke.replace("__LAZY_MODULE_IMPORTS__", imports),
    );
    const configText = await readFile(
      new URL("../wrangler.jsonc", import.meta.url),
      "utf8",
    );
    const compatibilityDate = configText.match(
      /"compatibility_date"\s*:\s*"([^\"]+)"/,
    )?.[1];
    if (!compatibilityDate)
      throw new Error("Missing Worker compatibility date");
    const config = join(buildPath, "wrangler.json");
    await writeFile(
      config,
      JSON.stringify({
        name: "stella-split-worker-build-test",
        main: join(outdir, "smoke.js"),
        compatibility_date: compatibilityDate,
        compatibility_flags: ["nodejs_compat"],
        no_bundle: true,
        find_additional_modules: true,
        base_dir: outdir,
        durable_objects: {
          bindings: [
            { name: "BUILD_SESSIONS", class_name: "BuildSessionProbe" },
          ],
        },
        migrations: [{ tag: "v1", new_sqlite_classes: ["BuildSessionProbe"] }],
        rules: [{ type: "ESModule", globs: ["**/*.js"], fallthrough: true }],
      }),
    );
    dev = await startWorkerdDev({
      config,
      prefix: "stella-split-worker-build-state-",
    });
  }, 120_000);

  afterAll(async () => {
    try {
      await dev?.stop();
    } finally {
      if (buildPath.includes("stella-split-worker-build-")) {
        await rm(buildPath, { recursive: true, force: true });
      }
    }
  }, 30_000);

  test("emits a lazy module manifest with source maps and removes stale chunks", async () => {
    await expect(access(join(outdir, "obsolete-chunk.js"))).rejects.toThrow();
    expect(manifest.modules.length).toBeGreaterThan(1);
    expect(manifest.eagerBytes).toBeLessThan(manifest.totalBytes);
    for (const module of manifest.modules) {
      await access(join(outdir, module.file));
      const map = JSON.parse(
        await readFile(join(outdir, `${module.file}.map`), "utf8"),
      );
      expect(map.version).toBe(3);
      expect(Array.isArray(map.sources)).toBe(true);
      if (module.file === manifest.entry)
        expect(map.sources.length).toBeGreaterThan(0);
      for (const dependency of module.imports)
        await access(join(outdir, dependency.file));
    }
  });

  test("loads every emitted lazy module and retains durable object exports in real Workerd", async () => {
    const response = await fetch(dev.origin);
    const report = await response.json();
    expect(report.loaded).toBe(manifest.modules.length);
    for (const name of [
      "OrchestratorSession",
      "OwnerGate",
      "BuildSession",
      "Sandbox",
      "SandboxSmall",
      "AppBuildSandbox",
      "WorldStore",
    ]) {
      expect(report.exports).toContain(name);
    }
  });

  test("loads the BuildSession implementation on first fetch and delegates alarms", async () => {
    const first = await fetch(`${dev.origin}/build-session`);
    expect(first.status).toBe(405);
    expect(
      await fetch(`${dev.origin}/build-session/__test/arm`).then((response) =>
        response.json(),
      ),
    ).toEqual({ armed: true });
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const status = (await fetch(
        `${dev.origin}/build-session/__test/status`,
      ).then((response) => response.json())) as { alarmRan: boolean };
      if (status.alarmRan) return;
      await pause(50);
    }
    throw new Error(`BuildSession alarm did not run:\n${dev.output()}`);
  });
});
