import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomInt } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWorker } from "../scripts/build-worker.mjs";
import { allocateWorkerdInspectorPort } from "./helpers/workerd-test-port.js";

const packageRoot = new URL("..", import.meta.url);
const port = randomInt(27_000, 28_000);
const origin = `http://127.0.0.1:${port}`;

const pause = async (delayMs: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
};

describe("Split Worker build in real Workerd", () => {
  let persistencePath = "";
  let workerd: ChildProcess | null = null;
  let workerdOutput = "";
  let moduleCount = 0;

  beforeAll(async () => {
    persistencePath = await mkdtemp(
      join(tmpdir(), "stella-split-worker-build-"),
    );
    const outdir = join(persistencePath, "bundle");
    await buildWorker({ outdir });
    await writeFile(
      join(outdir, "obsolete-chunk.js"),
      "throw new Error('obsolete bundle');",
    );
    const manifest = await buildWorker({ outdir });
    await expect(access(join(outdir, "obsolete-chunk.js"))).rejects.toThrow();
    moduleCount = manifest.modules.length;
    expect(moduleCount).toBeGreaterThan(1);
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
    const imports = manifest.modules
      .map((module) => `import(${JSON.stringify(`./${module.file}`)})`)
      .join(",");
    await writeFile(
      join(outdir, "smoke.js"),
      `export * from "./index.js";
      import { BuildSession } from "./index.js";
      export class BuildSessionProbe extends BuildSession {
        async fetch(request) {
          const path = new URL(request.url).pathname;
          if (path === "/__test/arm") {
            await this.ctx.storage.setAlarm(Date.now() + 100);
            return Response.json({ armed: true });
          }
          if (path === "/__test/status") {
            return Response.json({ alarmRan: (await this.ctx.storage.get("alarmRan")) === true });
          }
          return super.fetch(request);
        }
        async alarm() {
          await super.alarm();
          await this.ctx.storage.put("alarmRan", true);
        }
      }
      export default { async fetch(request, env) {
        const path = new URL(request.url).pathname;
        if (path.startsWith("/build-session")) {
          const suffix = path.slice("/build-session".length) || "/";
          return env.BUILD_SESSIONS.getByName("probe").fetch(new Request(new URL(suffix, request.url), request));
        }
        const modules = await Promise.all([${imports}]);
        const entry = await import("./index.js");
        return Response.json({ loaded: modules.length, exports: Object.keys(entry) });
      } };`,
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
    await writeFile(
      join(persistencePath, "wrangler.json"),
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
    const inspectorPort = await allocateWorkerdInspectorPort();
    const child = spawn(
      process.execPath,
      [
        "x",
        "wrangler",
        "dev",
        "--config",
        join(persistencePath, "wrangler.json"),
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        "--local",
        "--persist-to",
        persistencePath,
        "--inspector-port",
        String(inspectorPort),
        "--show-interactive-dev-session=false",
      ],
      { cwd: packageRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    workerd = child;
    const observe = (chunk: unknown): void => {
      workerdOutput += String(chunk);
    };
    child.stdout?.on("data", observe);
    child.stderr?.on("data", observe);

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`wrangler exited before readiness:\n${workerdOutput}`);
      }
      try {
        const response = await fetch(origin);
        if (response.ok) return;
      } catch {
        // Workerd is still starting.
      }
      await pause(50);
    }
    throw new Error(`workerd did not become ready:\n${workerdOutput}`);
  });

  afterAll(async () => {
    const child = workerd;
    workerd = null;
    try {
      if (child && child.exitCode === null) {
        child.kill("SIGTERM");
        await Promise.race([once(child, "exit"), pause(5_000)]);
        if (child.exitCode === null) {
          child.kill("SIGKILL");
          await once(child, "exit");
        }
      }
    } finally {
      if (persistencePath.includes("stella-split-worker-build-")) {
        await rm(persistencePath, { recursive: true, force: true });
      }
    }
  });

  test("loads every emitted lazy module and retains durable object exports in real Workerd", async () => {
    const response = await fetch(origin);
    const report = await response.json();
    expect(report.loaded).toBe(moduleCount);
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
    const first = await fetch(`${origin}/build-session`);
    expect(first.status).toBe(405);
    expect(
      await fetch(`${origin}/build-session/__test/arm`).then((response) =>
        response.json(),
      ),
    ).toEqual({ armed: true });
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const status = (await fetch(`${origin}/build-session/__test/status`).then(
        (response) => response.json(),
      )) as { alarmRan: boolean };
      if (status.alarmRan) return;
      await pause(50);
    }
    throw new Error(`BuildSession alarm did not run:\n${workerdOutput}`);
  });
});
