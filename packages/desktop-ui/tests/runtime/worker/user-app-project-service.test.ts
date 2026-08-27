import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UserAppProjectService } from "@stella/runtime/worker/user-apps/project-service";

const roots: string[] = [];

const CHANGE_NOTIFICATION_TIMEOUT_MS = 10_000;
const CHANGE_NOTIFICATION_RETRY_MS = 250;

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
    }),
  );
  await writeFile(
    path.join(projectPath, "package.json"),
    JSON.stringify({ name: slug, private: true }),
  );
  return projectPath;
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
const port = process.argv[portIndex + 1]
${announceUrl ? "setTimeout(() => console.log('  Local:   http://127.0.0.1:' + port + '/'), 250)" : ""}
const { createServer } = await import('node:net')
createServer(() => {}).listen(Number(port), '127.0.0.1')
`,
  );
  await chmod(filePath, 0o755);
  return filePath;
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
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
    const first = new UserAppProjectService({ workspacePath: workspace });
    await first.start();
    const firstPrivate = first as unknown as {
      portForSlug: (slug: string) => Promise<number>;
    };
    const alphaPort = await firstPrivate.portForSlug("alpha");
    const bravoPort = await firstPrivate.portForSlug("bravo");
    expect(alphaPort).not.toBe(bravoPort);
    await first.shutdown();

    const second = new UserAppProjectService({ workspacePath: workspace });
    await second.start();
    const secondPrivate = second as unknown as {
      portForSlug: (slug: string) => Promise<number>;
    };
    await expect(secondPrivate.portForSlug("alpha")).resolves.toBe(alphaPort);
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
      portForSlug: (slug: string) => Promise<number>;
    };
    const originalPortForSlug = servicePrivate.portForSlug.bind(service);
    servicePrivate.portForSlug = async (slug) => {
      markPortAllocationReached();
      await portAllocationGate;
      return await originalPortForSlug(slug);
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

  it("emits a change when an existing project's manifest is edited", async () => {
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
      void editManifest(`Updated name ${(edits += 1)}`).catch(() => undefined);
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
  }, CHANGE_NOTIFICATION_TIMEOUT_MS + 5_000);
});
