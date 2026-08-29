import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectUserAppRuntime,
  UserAppProjectService,
} from "@stella/runtime/worker/user-apps/project-service";

const roots: string[] = [];

/**
 * On macOS `fs.watch` is backed by FSEvents, which does not deliver changes
 * made in the window between the watcher being created and the stream actually
 * running. A single write straight after `start()` can land in that window and
 * be dropped outright — so the notification never arrives and no amount of
 * waiting helps. That, not slowness, was this test's flakiness: it failed on
 * roughly three runs in four under a loaded parallel suite.
 *
 * Re-writing until the change is observed removes the race without hiding a
 * real regression: a watcher that never emits still exhausts the deadline.
 */
const CHANGE_NOTIFICATION_TIMEOUT_MS = 10_000;
const CHANGE_NOTIFICATION_RETRY_MS = 250;

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "..",
);
const SCAFFOLD_PACKAGE_TEMPLATE = path.join(
  REPO_ROOT,
  "packages",
  "home-seed",
  "skills",
  "create-stella-app",
  "templates",
  "package.json.tmpl",
);

const makeWorkspace = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-user-apps-"));
  roots.push(root);
  await mkdir(path.join(root, "apps"), { recursive: true });
  return root;
};

const writeProject = async (
  workspace: string,
  slug: string,
  manifestSlug = slug,
  includeReact = true,
  runtime?: unknown,
  scripts?: Record<string, string>,
) => {
  const projectPath = path.join(workspace, "apps", slug);
  await mkdir(path.join(projectPath, "node_modules", "vite"), {
    recursive: true,
  });
  if (includeReact) {
    await mkdir(path.join(projectPath, "node_modules", "react"), {
      recursive: true,
    });
  }
  await writeFile(
    path.join(projectPath, "stella.app.json"),
    JSON.stringify({
      schemaVersion: 1,
      slug: manifestSlug,
      name: `App ${slug}`,
      createdAt: "2026-08-05T00:00:00.000Z",
      ...(runtime ? { runtime } : {}),
    }),
  );
  await writeFile(
    path.join(projectPath, "package.json"),
    JSON.stringify({
      name: slug,
      private: true,
      ...(scripts ? { scripts } : {}),
    }),
  );
  return projectPath;
};

const multiProcessRuntime = {
  frontend: "web",
  processes: [
    {
      id: "api",
      command: "bun",
      port: "auto",
      ports: [{ id: "metrics", protocol: "tcp" }],
      readiness: { type: "tcp" },
    },
    {
      id: "web",
      command: "bun",
      args: ["--assigned-port", "${PORT}"],
      port: "auto",
      readiness: { type: "tcp" },
    },
  ],
};

const fakeBun = async (
  workspace: string,
  { announceUrl = true }: { announceUrl?: boolean } = {},
) => {
  const filePath = path.join(workspace, "fake-bun.mjs");
  await writeFile(
    filePath,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const countFile = path.join(process.cwd(), '.spawn-count')
let count = 0
try { count = Number(readFileSync(countFile, 'utf8')) || 0 } catch {}
writeFileSync(countFile, String(count + 1))
if (process.argv[2] === 'install') {
  writeFileSync(path.join(process.cwd(), '.install-called'), 'yes')
  process.exit(0)
}
const portIndex = process.argv.indexOf('--port')
const port = portIndex >= 0 ? process.argv[portIndex + 1] : process.env.PORT
${announceUrl ? "setTimeout(() => console.log('  Local:   http://127.0.0.1:' + port + '/'), 250)" : ""}
const { createServer } = await import('node:net')
createServer(() => {}).listen(Number(port), '127.0.0.1')
`,
  );
  await chmod(filePath, 0o755);
  return filePath;
};

/**
 * Stands in for every supervised process of one app. It records its own start
 * and stop, dumps the sibling ports it was handed, and spawns a grandchild so
 * a test can prove the whole process tree is torn down and not just the direct
 * child.
 */
const fakeMultiProcessBun = async (
  workspace: string,
  {
    failProcess,
    crashOnceProcess,
  }: { failProcess?: string; crashOnceProcess?: string } = {},
) => {
  const filePath = path.join(workspace, "fake-multi-process-bun.mjs");
  await writeFile(
    filePath,
    `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import path from 'node:path'
const id = process.env.STELLA_APP_PROCESS_ID
const root = process.cwd()
appendFileSync(path.join(root, '.process-events'), 'start:' + id + ':' + process.pid + '\\n')
writeFileSync(path.join(root, '.process-env-' + id + '.json'), JSON.stringify({
  port: process.env.PORT,
  ownPort: process.env.STELLA_APP_PORT,
  slug: process.env.STELLA_APP_SLUG,
  apiPort: process.env.STELLA_APP_PORT_API,
  apiUrl: process.env.STELLA_APP_URL_API,
  apiMetricsPort: process.env.STELLA_APP_PORT_API_METRICS,
  ownMetricsPort: process.env.STELLA_APP_PORT_METRICS,
  webPort: process.env.STELLA_APP_PORT_WEB,
  webUrl: process.env.STELLA_APP_URL_WEB,
  assignedPort: process.argv[process.argv.indexOf('--assigned-port') + 1],
}))
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
writeFileSync(path.join(root, '.grandchild-' + id), String(grandchild.pid))
const server = createServer(() => {})
server.listen(Number(process.env.PORT), '127.0.0.1', () => {
  if (id === ${JSON.stringify(failProcess ?? null)}) setTimeout(() => process.exit(17), 25)
  const crashMarker = path.join(root, '.crashed-' + id)
  if (id === ${JSON.stringify(crashOnceProcess ?? null)} && !existsSync(crashMarker)) {
    writeFileSync(crashMarker, 'yes')
    setTimeout(() => process.exit(18), 500)
  }
})
process.on('SIGTERM', () => {
  appendFileSync(path.join(root, '.process-events'), 'stop:' + id + ':' + process.pid + '\\n')
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 100).unref()
})
`,
  );
  await chmod(filePath, 0o755);
  return filePath;
};

/** Answers an HTTP readiness probe only after `readyAfterMs` has elapsed. */
const fakeHttpBun = async (workspace: string, readyAfterMs: number) => {
  const filePath = path.join(workspace, "fake-http-bun.mjs");
  await writeFile(
    filePath,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
const id = process.env.STELLA_APP_PROCESS_ID
const root = process.cwd()
appendFileSync(path.join(root, '.process-events'), 'start:' + id + ':' + process.pid + '\\n')
const startedAt = Date.now()
createServer((request, response) => {
  const healthy = request.url === '/healthz' && Date.now() - startedAt >= ${readyAfterMs}
  appendFileSync(path.join(root, '.http-probes'), request.url + '\\n')
  response.writeHead(healthy ? 200 : 503).end()
}).listen(Number(process.env.PORT), '127.0.0.1')
process.on('SIGTERM', () => process.exit(0))
`,
  );
  await chmod(filePath, 0o755);
  return filePath;
};

const readProcessStarts = async (projectPath: string) =>
  (await readFile(path.join(projectPath, ".process-events"), "utf8"))
    .split("\n")
    .filter((line) => line.startsWith("start:"));

const waitFor = async (
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Condition did not become true before timeout.");
};

const processExists = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("detectUserAppRuntime", () => {
  /**
   * The scaffolder and the supervisor have to agree without either knowing
   * about the other, so the contract is pinned against the real template
   * rather than a copy of its scripts. A template edit that leaves the app
   * unlaunchable fails here instead of on the user's first start.
   */
  it("supervises the scaffolded app template as a single frontend", async () => {
    const template = JSON.parse(
      await readFile(SCAFFOLD_PACKAGE_TEMPLATE, "utf8"),
    ) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    const runtime = detectUserAppRuntime(
      template.scripts,
      new Set(Object.keys(template.devDependencies)),
    );

    expect(runtime.frontend).toBe("frontend");
    expect(runtime.processes).toMatchObject([
      {
        id: "frontend",
        port: "auto",
        args: [
          "run",
          "dev",
          "--",
          "--host",
          "127.0.0.1",
          "--port",
          "${PORT}",
          "--strictPort",
        ],
      },
    ]);
  });

  it("ignores build and preview scripts that run the same frontend tool", () => {
    const runtime = detectUserAppRuntime({
      dev: "vite",
      build: "tsc --noEmit && vite build",
      preview: "vite preview",
      "build:web": "vite build",
    });

    expect(runtime.processes.map((process) => process.id)).toEqual([
      "frontend",
    ]);
  });

  it("detects ordinary frontend, API, and worker package scripts", () => {
    const runtime = detectUserAppRuntime({
      dev: "vite",
      "dev:api": "tsx src/server.ts",
      "dev:worker": "tsx src/worker.ts",
    });

    expect(runtime.frontend).toBe("frontend");
    expect(runtime.processes).toMatchObject([
      {
        id: "dev-api",
        args: ["run", "dev:api"],
        port: "auto",
        readiness: { type: "tcp" },
      },
      {
        id: "dev-worker",
        args: ["run", "dev:worker"],
        port: null,
        readiness: { type: "process" },
      },
      {
        id: "frontend",
        args: [
          "run",
          "dev",
          "--",
          "--host",
          "127.0.0.1",
          "--port",
          "${PORT}",
          "--strictPort",
        ],
      },
    ]);
  });

  it("detects split full-stack scripts without requiring a dev alias", () => {
    const runtime = detectUserAppRuntime({
      "dev:web": "vite",
      "server:dev": "tsx src/server.ts",
    });

    expect(runtime.processes.map((process) => process.id)).toEqual([
      "server-dev",
      "frontend",
    ]);
    expect(runtime.processes.at(-1)?.args.slice(0, 2)).toEqual([
      "run",
      "dev:web",
    ]);
  });

  it("splits a transparent aggregate into individually supervised scripts", () => {
    const runtime = detectUserAppRuntime({
      dev: 'concurrently "bun run dev:web" "bun run dev:api"',
      "dev:web": "vite",
      "dev:api": "tsx src/server.ts",
    });
    expect(runtime.processes.map((process) => process.id)).toEqual([
      "dev-api",
      "frontend",
    ]);
  });

  it("does not double-start opaque aggregate dev commands", () => {
    for (const dev of ["node scripts/dev.mjs", "turbo dev"]) {
      const runtime = detectUserAppRuntime({
        dev,
        "dev:web": "vite",
        "dev:api": "tsx src/server.ts",
      });
      expect(runtime.processes).toMatchObject([
        { id: "frontend", args: ["run", "dev"] },
      ]);
      expect(runtime.processes).toHaveLength(1);
    }
  });

  it("recognizes an ordinary backend dev script next to a named frontend", () => {
    const runtime = detectUserAppRuntime({
      dev: "tsx src/server.ts",
      "dev:web": "vite",
      "dev:worker": "tsx src/worker.ts",
    });
    expect(runtime.processes.map((process) => process.id)).toEqual([
      "dev",
      "dev-worker",
      "frontend",
    ]);
  });

  it("fails safely when ordinary frontend discovery is ambiguous", () => {
    expect(() =>
      detectUserAppRuntime({
        "dev:web": "vite",
        "dev:client": "next dev",
      }),
    ).toThrow("Frontend discovery is ambiguous");
    expect(() =>
      detectUserAppRuntime({ "dev:api": "tsx src/server.ts" }),
    ).toThrow("No usable frontend dev script");
  });

  it("refuses a discovered layout above the supervised process limit", () => {
    const scripts: Record<string, string> = { dev: "vite" };
    for (const name of [
      "api",
      "server",
      "backend",
      "worker",
      "workers",
      "queue",
      "livekit",
      "realtime",
    ]) {
      scripts[`dev:${name}`] = `tsx src/${name}.ts`;
    }
    expect(() => detectUserAppRuntime(scripts)).toThrow(
      "above the 8 process limit",
    );
  });

  it("falls back to a bare Vite server when a project declares no scripts", () => {
    expect(detectUserAppRuntime({})).toMatchObject({
      frontend: "frontend",
      processes: [
        {
          id: "frontend",
          port: "auto",
          args: [
            "x",
            "vite",
            "--host",
            "127.0.0.1",
            "--port",
            "${PORT}",
            "--strictPort",
          ],
        },
      ],
    });
    expect(() => detectUserAppRuntime({}, new Set(["next"]))).toThrow(
      "No standard frontend dev script",
    );
  });
});

describe("UserAppProjectService", () => {
  it("rejects traversal and non-canonical slugs before touching disk", async () => {
    const workspace = await makeWorkspace();
    const service = new UserAppProjectService({ workspacePath: workspace });
    await service.start();
    await expect(service.startProject("../escape")).rejects.toThrow(
      "Invalid app slug",
    );
    await expect(service.stopProject("Uppercase")).rejects.toThrow(
      "Invalid app slug",
    );
    await service.shutdown();
  });

  it("discovers only strict in-root projects with matching manifests", async () => {
    const workspace = await makeWorkspace();
    await writeProject(workspace, "valid-app");
    await writeProject(workspace, "wrong-manifest", "different-slug");
    await writeProject(workspace, "invalid-runtime", "invalid-runtime", true, {
      frontend: "web",
      processes: [
        { id: "web", command: "bun", port: "auto" },
        { id: "web", command: "bun", port: "auto" },
      ],
    });
    await writeProject(
      workspace,
      "port-name-collision",
      "port-name-collision",
      true,
      {
        frontend: "api-metrics",
        processes: [
          {
            id: "api",
            command: "bun",
            ports: [{ id: "metrics", protocol: "tcp" }],
          },
          { id: "api-metrics", command: "bun", port: "auto" },
        ],
      },
    );
    if (process.platform !== "win32") {
      const outside = await mkdtemp(
        path.join(os.tmpdir(), "stella-user-app-outside-"),
      );
      roots.push(outside);
      await symlink(outside, path.join(workspace, "apps", "linked-app"));
    }
    const service = new UserAppProjectService({ workspacePath: workspace });
    await service.start();
    await expect(service.list()).resolves.toEqual({
      apps: [
        {
          slug: "valid-app",
          meta: {
            label: "App valid-app",
            createdAt: "2026-08-05T00:00:00.000Z",
          },
          status: "stopped",
        },
      ],
    });
    await service.shutdown();
  });

  it("keeps each slug on its persisted stable port", async () => {
    const workspace = await makeWorkspace();
    await writeProject(workspace, "alpha");
    await writeProject(workspace, "bravo");
    type PortAllocator = {
      portForProcess: (
        slug: string,
        processId: string,
        frontend: boolean,
      ) => Promise<number>;
    };
    const first = new UserAppProjectService({ workspacePath: workspace });
    await first.start();
    const firstPrivate = first as unknown as PortAllocator;
    const alphaPort = await firstPrivate.portForProcess(
      "alpha",
      "frontend",
      true,
    );
    const bravoPort = await firstPrivate.portForProcess(
      "bravo",
      "frontend",
      true,
    );
    expect(alphaPort).not.toBe(bravoPort);
    await first.shutdown();

    const second = new UserAppProjectService({ workspacePath: workspace });
    await second.start();
    const secondPrivate = second as unknown as PortAllocator;
    await expect(
      secondPrivate.portForProcess("alpha", "frontend", true),
    ).resolves.toBe(alphaPort);
    const persisted = JSON.parse(
      await readFile(
        path.join(workspace, "apps", ".stella-app-ports.json"),
        "utf8",
      ),
    );
    expect(persisted.ports).toMatchObject({
      alpha: alphaPort,
      bravo: bravoPort,
    });
    await second.shutdown();

    // A pinned port someone else now holds is re-drawn: a strict-port child
    // handed the stale one would only fail to bind.
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(alphaPort, "127.0.0.1", resolve);
    });
    try {
      const third = new UserAppProjectService({ workspacePath: workspace });
      await third.start();
      const thirdPrivate = third as unknown as PortAllocator;
      await expect(
        thirdPrivate.portForProcess("alpha", "frontend", true),
      ).resolves.not.toBe(alphaPort);
      await third.shutdown();
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("stops a project cleanly while its Vite process is still starting", async () => {
    const workspace = await makeWorkspace();
    await writeProject(workspace, "racing-app");
    const executablePath = await fakeBun(workspace);
    const service = new UserAppProjectService({
      workspacePath: workspace,
      executablePath,
    });
    await service.start();
    const starting = service.startProject("racing-app");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(service.stopProject("racing-app")).resolves.toEqual({
      slug: "racing-app",
      status: "stopped",
    });
    await expect(starting).resolves.toMatchObject({
      slug: "racing-app",
      status: "stopped",
      url: null,
    });
    await service.shutdown();
  });

  it("does not spawn after a stop invalidates launch during port allocation", async () => {
    const workspace = await makeWorkspace();
    const projectPath = await writeProject(workspace, "port-race-app");
    const executablePath = await fakeBun(workspace);
    const service = new UserAppProjectService({
      workspacePath: workspace,
      executablePath,
    });
    await service.start();

    let markPortAllocationReached = () => {};
    const portAllocationReached = new Promise<void>((resolve) => {
      markPortAllocationReached = resolve;
    });
    let resumePortAllocation = () => {};
    const portAllocationGate = new Promise<void>((resolve) => {
      resumePortAllocation = resolve;
    });
    const servicePrivate = service as unknown as {
      portForProcess: (
        slug: string,
        processId: string,
        frontend: boolean,
      ) => Promise<number>;
    };
    const originalPortForProcess = servicePrivate.portForProcess.bind(service);
    servicePrivate.portForProcess = async (slug, processId, frontend) => {
      markPortAllocationReached();
      await portAllocationGate;
      return await originalPortForProcess(slug, processId, frontend);
    };

    const starting = service.startProject("port-race-app");
    await portAllocationReached;
    await expect(service.stopProject("port-race-app")).resolves.toEqual({
      slug: "port-race-app",
      status: "stopped",
    });
    resumePortAllocation();
    await expect(starting).resolves.toEqual({
      slug: "port-race-app",
      url: null,
      status: "stopped",
    });
    await expect(
      readFile(path.join(projectPath, ".spawn-count"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(service.list()).resolves.toEqual({
      apps: [
        expect.objectContaining({ slug: "port-race-app", status: "stopped" }),
      ],
    });
    await service.shutdown();
  });

  it("singleflights concurrent starts, reports running, and stops the child", async () => {
    const workspace = await makeWorkspace();
    const projectPath = await writeProject(workspace, "running-app");
    const executablePath = await fakeBun(workspace);
    const service = new UserAppProjectService({
      workspacePath: workspace,
      executablePath,
    });
    await service.start();
    expect(service.hasActiveWork()).toBe(false);
    const [first, second] = await Promise.all([
      service.startProject("running-app"),
      service.startProject("running-app"),
    ]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      slug: "running-app",
      status: "running",
    });
    expect(service.hasActiveWork()).toBe(true);
    expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const portMap = JSON.parse(
      await readFile(
        path.join(workspace, "apps", ".stella-app-ports.json"),
        "utf8",
      ),
    );
    expect(first.url).toBe(`http://127.0.0.1:${portMap.ports["running-app"]}/`);
    await expect(
      readFile(path.join(projectPath, ".spawn-count"), "utf8"),
    ).resolves.toBe("1");
    await expect(service.list()).resolves.toEqual({
      apps: [
        expect.objectContaining({ slug: "running-app", status: "running" }),
      ],
    });
    await expect(service.stopProject("running-app")).resolves.toEqual({
      slug: "running-app",
      status: "stopped",
    });
    expect(service.hasActiveWork()).toBe(false);
    await expect(service.list()).resolves.toEqual({
      apps: [
        expect.objectContaining({ slug: "running-app", status: "stopped" }),
      ],
    });
    await service.shutdown();
  });

  it("automatically supervises and cleans up an ordinary split full-stack app", async () => {
    const workspace = await makeWorkspace();
    const projectPath = await writeProject(
      workspace,
      "ordinary-full-stack",
      "ordinary-full-stack",
      true,
      undefined,
      { dev: "vite", "dev:api": "tsx src/server.ts" },
    );
    const executablePath = await fakeMultiProcessBun(workspace);
    const service = new UserAppProjectService({
      workspacePath: workspace,
      executablePath,
    });
    await service.start();

    await expect(
      service.startProject("ordinary-full-stack"),
    ).resolves.toMatchObject({
      status: "running",
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/$/),
    });
    const starts = await readProcessStarts(projectPath);
    expect(starts.map((line) => line.split(":")[1])).toEqual([
      "dev-api",
      "frontend",
    ]);
    const pids = await Promise.all(
      starts.flatMap((line) => {
        const id = line.split(":")[1]!;
        return [
          Promise.resolve(Number(line.split(":")[2])),
          readFile(path.join(projectPath, `.grandchild-${id}`), "utf8").then(
            Number,
          ),
        ];
      }),
    );

    await service.stopProject("ordinary-full-stack");
    await waitFor(() => pids.every((pid) => !processExists(pid)));
    await service.shutdown();
  });

  it("starts transparent aggregate children once without also launching the parent", async () => {
    const workspace = await makeWorkspace();
    const projectPath = await writeProject(
      workspace,
      "aggregate-app",
      "aggregate-app",
      true,
      undefined,
      {
        dev: 'concurrently "bun run dev:web" "bun run dev:api"',
        "dev:web": "vite",
        "dev:api": "tsx src/server.ts",
      },
    );
    const executablePath = await fakeMultiProcessBun(workspace);
    const service = new UserAppProjectService({
      workspacePath: workspace,
      executablePath,
    });
    await service.start();

    await expect(service.startProject("aggregate-app")).resolves.toMatchObject({
      status: "running",
    });
    const starts = await readProcessStarts(projectPath);
    expect(starts.map((line) => line.split(":")[1])).toEqual([
      "dev-api",
      "frontend",
    ]);
    await service.stopProject("aggregate-app");
    await service.shutdown();
  });

  it("reports automatic discovery ambiguity without spawning a process", async () => {
    const workspace = await makeWorkspace();
    const projectPath = await writeProject(
      workspace,
      "ambiguous-app",
      "ambiguous-app",
      true,
      undefined,
      { "dev:web": "vite", "dev:client": "next dev" },
    );
    const executablePath = await fakeBun(workspace);
    const service = new UserAppProjectService({
      workspacePath: workspace,
      executablePath,
    });
    await service.start();

    await expect(service.startProject("ambiguous-app")).resolves.toMatchObject({
      status: "error",
      error: expect.stringContaining("Frontend discovery is ambiguous"),
    });
    await expect(
      readFile(path.join(projectPath, ".spawn-count"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await service.shutdown();
  });

  it("starts one multi-process lifecycle, exposes sibling ports, and stops every process tree", async () => {
    const workspace = await makeWorkspace();
    const projectPath = await writeProject(
      workspace,
      "multi-app",
      "multi-app",
      true,
      multiProcessRuntime,
    );
    const executablePath = await fakeMultiProcessBun(workspace);
    const service = new UserAppProjectService({
      workspacePath: workspace,
      executablePath,
    });
    await service.start();

    const [first, second] = await Promise.all([
      service.startProject("multi-app"),
      service.startProject("multi-app"),
    ]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ slug: "multi-app", status: "running" });

    const portMap = JSON.parse(
      await readFile(
        path.join(workspace, "apps", ".stella-app-ports.json"),
        "utf8",
      ),
    );
    expect(portMap.ports["multi-app"]).toEqual(expect.any(Number));
    expect(portMap.ports["multi-app:api"]).toEqual(expect.any(Number));
    expect(portMap.ports["multi-app:api-metrics"]).toEqual(expect.any(Number));
    expect(first.url).toBe(`http://127.0.0.1:${portMap.ports["multi-app"]}/`);
    const webEnvironment = JSON.parse(
      await readFile(path.join(projectPath, ".process-env-web.json"), "utf8"),
    );
    expect(webEnvironment).toMatchObject({
      port: String(portMap.ports["multi-app"]),
      ownPort: String(portMap.ports["multi-app"]),
      slug: "multi-app",
      apiPort: String(portMap.ports["multi-app:api"]),
      apiUrl: `http://127.0.0.1:${portMap.ports["multi-app:api"]}`,
      apiMetricsPort: String(portMap.ports["multi-app:api-metrics"]),
      webPort: String(portMap.ports["multi-app"]),
      webUrl: `http://127.0.0.1:${portMap.ports["multi-app"]}`,
      assignedPort: String(portMap.ports["multi-app"]),
    });
    // A named port belongs to the process that declared it, so the frontend
    // must not have picked up the API's metrics port under its own name.
    expect(webEnvironment.ownMetricsPort).toBeUndefined();
    const starts = await readProcessStarts(projectPath);
    expect(starts).toHaveLength(2);

    const firstPids = [
      ...starts.map((line) => Number(line.split(":")[2])),
      Number(await readFile(path.join(projectPath, ".grandchild-api"), "utf8")),
      Number(await readFile(path.join(projectPath, ".grandchild-web"), "utf8")),
    ];
    await expect(
      Promise.all([
        service.stopProject("multi-app"),
        service.stopProject("multi-app"),
      ]),
    ).resolves.toEqual([
      { slug: "multi-app", status: "stopped" },
      { slug: "multi-app", status: "stopped" },
    ]);
    await waitFor(() => firstPids.every((pid) => !processExists(pid)));

    await expect(service.startProject("multi-app")).resolves.toMatchObject({
      status: "running",
    });
    const restartedEvents = await readProcessStarts(projectPath);
    const restartedPids = [
      ...restartedEvents.slice(-2).map((line) => Number(line.split(":")[2])),
      Number(await readFile(path.join(projectPath, ".grandchild-api"), "utf8")),
      Number(await readFile(path.join(projectPath, ".grandchild-web"), "utf8")),
    ];
    await service.shutdown();
    await waitFor(() => restartedPids.every((pid) => !processExists(pid)));
  });

  it("waits for an HTTP readiness path before reporting running", async () => {
    const workspace = await makeWorkspace();
    const projectPath = await writeProject(
      workspace,
      "http-ready-app",
      "http-ready-app",
      true,
      {
        frontend: "web",
        processes: [
          {
            id: "web",
            command: "bun",
            port: "auto",
            readiness: { type: "http", path: "/healthz", timeoutMs: 10_000 },
          },
        ],
      },
    );
    const executablePath = await fakeHttpBun(workspace, 400);
    const service = new UserAppProjectService({
      workspacePath: workspace,
      executablePath,
    });
    await service.start();

    await expect(service.startProject("http-ready-app")).resolves.toMatchObject(
      { status: "running" },
    );
    const probes = (
      await readFile(path.join(projectPath, ".http-probes"), "utf8")
    )
      .split("\n")
      .filter(Boolean);
    expect(probes.every((probePath) => probePath === "/healthz")).toBe(true);
    // The declared path had to answer 503 before it answered 200, so a
    // listening-but-unhealthy server did not count as ready.
    expect(probes.length).toBeGreaterThan(2);
    await service.stopProject("http-ready-app");
    await service.shutdown();
  }, 20_000);

  it("rolls back automatically discovered siblings when a later process fails", async () => {
    const workspace = await makeWorkspace();
    const projectPath = await writeProject(
      workspace,
      "failing-multi-app",
      "failing-multi-app",
      true,
      undefined,
      { dev: "vite", "dev:api": "tsx src/server.ts" },
    );
    const executablePath = await fakeMultiProcessBun(workspace, {
      failProcess: "frontend",
    });
    const service = new UserAppProjectService({
      workspacePath: workspace,
      executablePath,
    });
    await service.start();

    await expect(
      service.startProject("failing-multi-app"),
    ).resolves.toMatchObject({
      slug: "failing-multi-app",
      status: "error",
      url: null,
      error: expect.stringContaining("frontend"),
    });
    const events = await readProcessStarts(projectPath);
    expect(events).toHaveLength(2);
    const pids = events.map((line) => Number(line.split(":")[2]));
    const grandchildPids = await Promise.all(
      events.map(async (line) =>
        Number(
          await readFile(
            path.join(projectPath, `.grandchild-${line.split(":")[1]}`),
            "utf8",
          ),
        ),
      ),
    );
    await waitFor(() =>
      [...pids, ...grandchildPids].every((pid) => !processExists(pid)),
    );
    await expect(service.list()).resolves.toEqual({
      apps: [
        expect.objectContaining({ slug: "failing-multi-app", status: "error" }),
      ],
    });
    await service.shutdown();
  });

  it("restarts the whole process set when one running process exits", async () => {
    const workspace = await makeWorkspace();
    const projectPath = await writeProject(
      workspace,
      "restarting-multi-app",
      "restarting-multi-app",
      true,
      multiProcessRuntime,
    );
    const executablePath = await fakeMultiProcessBun(workspace, {
      crashOnceProcess: "api",
    });
    const service = new UserAppProjectService({
      workspacePath: workspace,
      executablePath,
    });
    await service.start();
    await expect(
      service.startProject("restarting-multi-app"),
    ).resolves.toMatchObject({
      status: "running",
    });
    const initialEvents = await readProcessStarts(projectPath);
    const initialWebPid = Number(
      initialEvents
        .find((line) => line.startsWith("start:web:"))
        ?.split(":")[2],
    );

    await waitFor(async () => {
      const events = await readProcessStarts(projectPath);
      const listed = await service.list();
      return events.length >= 4 && listed.apps[0]?.status === "running";
    }, 7_000);
    // The healthy sibling was taken down with the crashed one, so the restart
    // is a whole new set rather than a patched-up half.
    expect(processExists(initialWebPid)).toBe(false);
    await service.shutdown();
  }, 10_000);

  it("does not double-start when start is requested during crash recovery", async () => {
    const workspace = await makeWorkspace();
    const projectPath = await writeProject(
      workspace,
      "manual-recovery-app",
      "manual-recovery-app",
      true,
      multiProcessRuntime,
    );
    const executablePath = await fakeMultiProcessBun(workspace, {
      crashOnceProcess: "api",
    });
    const service = new UserAppProjectService({
      workspacePath: workspace,
      executablePath,
    });
    await service.start();
    await expect(
      service.startProject("manual-recovery-app"),
    ).resolves.toMatchObject({
      status: "running",
    });
    await waitFor(async () => {
      const listed = await service.list();
      return listed.apps[0]?.status === "error";
    });

    await expect(
      service.startProject("manual-recovery-app"),
    ).resolves.toMatchObject({
      status: "running",
    });
    // Long enough for the scheduled restart backoff to have fired had the
    // manual start not taken ownership of the recovery.
    await new Promise((resolve) => setTimeout(resolve, 2_300));
    const starts = await readProcessStarts(projectPath);
    expect(starts).toHaveLength(4);
    await service.shutdown();
  }, 10_000);

  it("starts a non-React Vite project without reinstalling dependencies", async () => {
    const workspace = await makeWorkspace();
    const projectPath = await writeProject(
      workspace,
      "vanilla-app",
      "vanilla-app",
      false,
    );
    const executablePath = await fakeBun(workspace);
    const service = new UserAppProjectService({
      workspacePath: workspace,
      executablePath,
    });
    await service.start();
    await expect(service.startProject("vanilla-app")).resolves.toMatchObject({
      slug: "vanilla-app",
      status: "running",
    });
    await expect(
      readFile(path.join(projectPath, ".spawn-count"), "utf8"),
    ).resolves.toBe("1");
    await expect(
      readFile(path.join(projectPath, ".install-called"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await service.stopProject("vanilla-app");
    await service.shutdown();
  });

  it("detects readiness from the loopback server without parsing Vite output", async () => {
    const workspace = await makeWorkspace();
    await writeProject(workspace, "silent-app");
    const executablePath = await fakeBun(workspace, { announceUrl: false });
    const service = new UserAppProjectService({
      workspacePath: workspace,
      executablePath,
    });
    await service.start();
    await expect(service.startProject("silent-app")).resolves.toMatchObject({
      slug: "silent-app",
      status: "running",
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/$/),
    });
    await service.stopProject("silent-app");
    await service.shutdown();
  });

  it(
    "emits a change when an existing project's manifest is edited",
    async () => {
      const workspace = await makeWorkspace();
      const projectPath = await writeProject(workspace, "watched-app");
      let resolveChanged = () => {};
      const changed = new Promise<void>((resolve) => {
        resolveChanged = resolve;
      });
      const service = new UserAppProjectService({
        workspacePath: workspace,
        onChanged: resolveChanged,
      });
      await service.start();

      const editManifest = (name: string) =>
        writeFile(
          path.join(projectPath, "stella.app.json"),
          JSON.stringify({
            schemaVersion: 1,
            slug: "watched-app",
            name,
            createdAt: "2026-08-05T00:00:00.000Z",
          }),
        );

      let edits = 0;
      const retry = setInterval(() => {
        void editManifest(`Updated name ${(edits += 1)}`).catch(
          () => undefined,
        );
      }, CHANGE_NOTIFICATION_RETRY_MS);
      void editManifest("Updated name").catch(() => undefined);

      try {
        await expect(
          Promise.race([
            changed,
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error("change notification timed out")),
                CHANGE_NOTIFICATION_TIMEOUT_MS,
              ),
            ),
          ]),
        ).resolves.toBeUndefined();
      } finally {
        clearInterval(retry);
      }
      await service.shutdown();
    },
    CHANGE_NOTIFICATION_TIMEOUT_MS + 5_000,
  );
});
