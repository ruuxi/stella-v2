import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSelfModHmrController,
  deriveApplyTransitionRequirements,
} from "@stella/runtime/kernel/self-mod/hmr";

const tempRoots: string[] = [];

const makeTempRoot = () => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-hmr-test-"));
  tempRoots.push(root);
  return root;
};

afterEach(() => {
  vi.restoreAllMocks();
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("self-mod HMR controller", () => {
  it("reports apply failure when the Vite endpoint is unavailable", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response("missing", { status: 404 }),
    ) as typeof fetch;
    const controller = createSelfModHmrController({
      enabled: true,
      getDevServerUrl: () => "http://127.0.0.1:57314",
      repoRoot: makeTempRoot(),
    });

    try {
      await expect(
        controller.apply([
          {
            runId: "run-a",
            paths: ["packages/desktop-ui/src/foo.tsx"],
            files: [{ path: "packages/desktop-ui/src/foo.tsx", content: "export const a = 1" }],
            runtimeRestartRelevantPaths: [],
            processRestartRelevantPaths: [],
            restartRelevantPaths: [],
            fullReloadRelevantPaths: [],
          },
        ]),
      ).resolves.toEqual({ ok: false });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reports track failure when the Vite endpoint cannot pin paths", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/pause-client-updates")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response("forbidden", { status: 403 });
    }) as typeof fetch;
    const root = makeTempRoot();
    const filePath = path.join(root, "packages/desktop-ui/src/foo.tsx");
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "export const a = 1;\n");
    const controller = createSelfModHmrController({
      enabled: true,
      getDevServerUrl: () => "http://127.0.0.1:57314",
      repoRoot: root,
    });

    try {
      await controller.beginRun("run-a");
      await expect(controller.recordWrite("run-a", [filePath])).rejects.toThrow(
        "Failed to pin self-mod HMR paths before write.",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not pin Vite paths for writes that arrive after a run is finalized", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as typeof fetch;
    const root = makeTempRoot();
    const filePath = path.join(root, "packages/desktop-ui/src/stale.tsx");
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "export const value = 'stale';\n");
    const controller = createSelfModHmrController({
      enabled: true,
      getDevServerUrl: () => "http://127.0.0.1:57314",
      repoRoot: root,
    });

    try {
      await controller.beginRun("run-a");
      expect(controller.finalize("run-a").appliedRuns).toEqual([]);
      await controller.recordWrite("run-a", [filePath]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]![0])).toContain(
        "/__stella/self-mod/hmr/pause-client-updates",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("tracks restart-required paths without posting them to Vite pinning", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as typeof fetch;
    const root = makeTempRoot();
    const packageJsonPath = path.join(root, "package.json");
    writeFileSync(packageJsonPath, '{"name":"stella-test"}\n');
    const controller = createSelfModHmrController({
      enabled: true,
      getDevServerUrl: () => "http://127.0.0.1:57314",
      repoRoot: root,
    });

    try {
      await controller.beginRun("run-a");
      await controller.recordWrite("run-a", [packageJsonPath]);
      const result = controller.finalize("run-a");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]![0])).toContain(
        "/__stella/self-mod/hmr/pause-client-updates",
      );
      expect(result.appliedRuns).toHaveLength(1);
      expect(result.appliedRuns[0]!.paths).toEqual(["package.json"]);
      expect(result.appliedRuns[0]!.runtimeRestartRelevantPaths).toEqual([]);
      expect(result.appliedRuns[0]!.processRestartRelevantPaths).toEqual([
        "package.json",
      ]);
      expect(result.appliedRuns[0]!.restartRelevantPaths).toEqual([
        "package.json",
      ]);
      expect(result.hasRestartRelevantPaths).toBe(true);
      expect(result.hasRuntimeRestartRelevantPaths).toBe(false);
      expect(result.hasProcessRestartRelevantPaths).toBe(true);
      expect(result.hasFullReloadRelevantPaths).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("separates runtime restarts, process restarts, and browser reloads", async () => {
    const root = makeTempRoot();
    const runtimePath = path.join(root, "packages/runtime/worker/server.ts");
    const electronPath = path.join(root, "packages/desktop/electron/main.ts");
    const metadataPath = path.join(root, "packages/desktop-ui/src/app/example/metadata.ts");
    mkdirSync(path.dirname(runtimePath), { recursive: true });
    mkdirSync(path.dirname(electronPath), { recursive: true });
    mkdirSync(path.dirname(metadataPath), { recursive: true });
    writeFileSync(runtimePath, "export const runtime = 1;\n");
    writeFileSync(electronPath, "export const electron = 1;\n");
    writeFileSync(metadataPath, "export default { id: 'example' };\n");
    const controller = createSelfModHmrController({
      enabled: false,
      getDevServerUrl: () => "http://127.0.0.1:57314",
      repoRoot: root,
    });

    await controller.beginRun("run-a");
    await controller.recordWrite("run-a", [
      runtimePath,
      electronPath,
      metadataPath,
    ]);
    const result = controller.finalize("run-a");

    expect(result.appliedRuns).toHaveLength(1);
    expect(result.appliedRuns[0]!.runtimeRestartRelevantPaths).toEqual([
      "packages/runtime/worker/server.ts",
    ]);
    expect(result.appliedRuns[0]!.processRestartRelevantPaths).toEqual([
      "packages/desktop/electron/main.ts",
    ]);
    expect(result.appliedRuns[0]!.fullReloadRelevantPaths).toEqual([
      "packages/desktop-ui/src/app/example/metadata.ts",
    ]);
    expect(result.hasRuntimeRestartRelevantPaths).toBe(true);
    expect(result.hasProcessRestartRelevantPaths).toBe(true);
    expect(result.hasFullReloadRelevantPaths).toBe(true);
  });

  it("escalates mixed changes to the highest restart tier", () => {
    expect(
      deriveApplyTransitionRequirements({
        hasFullReloadRelevantPaths: false,
        hasRuntimeRestartRelevantPaths: false,
        hasProcessRestartRelevantPaths: false,
      }),
    ).toEqual({
      requiresFullReload: false,
      requiresRuntimeRestart: false,
      requiresProcessRestart: false,
    });
    expect(
      deriveApplyTransitionRequirements({
        hasFullReloadRelevantPaths: true,
        hasRuntimeRestartRelevantPaths: false,
        hasProcessRestartRelevantPaths: false,
      }),
    ).toEqual({
      requiresFullReload: true,
      requiresRuntimeRestart: false,
      requiresProcessRestart: false,
    });
    expect(
      deriveApplyTransitionRequirements({
        hasFullReloadRelevantPaths: true,
        hasRuntimeRestartRelevantPaths: false,
        hasProcessRestartRelevantPaths: true,
      }),
    ).toEqual({
      requiresFullReload: false,
      requiresRuntimeRestart: false,
      requiresProcessRestart: true,
    });
    expect(
      deriveApplyTransitionRequirements({
        hasFullReloadRelevantPaths: true,
        hasRuntimeRestartRelevantPaths: true,
        hasProcessRestartRelevantPaths: false,
      }),
    ).toEqual({
      requiresFullReload: false,
      requiresRuntimeRestart: true,
      requiresProcessRestart: false,
    });
  });

  it("includes the generated route tree when a route file changes", async () => {
    const root = makeTempRoot();
    const routePath = path.join(root, "packages/desktop-ui/src/routes/settings.tsx");
    const routeTreePath = path.join(root, "packages/desktop-ui/src/routeTree.gen.ts");
    mkdirSync(path.dirname(routePath), { recursive: true });
    writeFileSync(routePath, "export const Route = null;\n");
    writeFileSync(routeTreePath, "export const routeTree = 'generated';\n");
    const controller = createSelfModHmrController({
      enabled: false,
      getDevServerUrl: () => "http://127.0.0.1:57314",
      repoRoot: root,
    });

    await controller.beginRun("run-a");
    await controller.recordWrite("run-a", [routePath]);
    const result = controller.finalize("run-a");

    expect(result.appliedRuns).toHaveLength(1);
    expect(result.appliedRuns[0]!.paths).toEqual([
      "packages/desktop-ui/src/routes/settings.tsx",
      "packages/desktop-ui/src/routeTree.gen.ts",
    ]);
    expect(result.appliedRuns[0]!.files).toEqual([
      {
        path: "packages/desktop-ui/src/routes/settings.tsx",
        content: "export const Route = null;\n",
      },
      {
        path: "packages/desktop-ui/src/routeTree.gen.ts",
        content: "export const routeTree = 'generated';\n",
      },
    ]);
  });

  it("marks sidebar app metadata writes as full-window reload relevant", async () => {
    const root = makeTempRoot();
    const metadataPath = path.join(
      root,
      "packages/desktop-ui/src/app/launch-checklist/metadata.ts",
    );
    mkdirSync(path.dirname(metadataPath), { recursive: true });
    writeFileSync(metadataPath, "export default { id: 'launch-checklist' };\n");
    const controller = createSelfModHmrController({
      enabled: false,
      getDevServerUrl: () => "http://127.0.0.1:57314",
      repoRoot: root,
    });

    await controller.beginRun("run-a");
    await controller.recordWrite("run-a", [metadataPath]);
    const result = controller.finalize("run-a");

    expect(result.appliedRuns).toHaveLength(1);
    expect(result.appliedRuns[0]!.paths).toEqual([
      "packages/desktop-ui/src/app/launch-checklist/metadata.ts",
    ]);
    expect(result.appliedRuns[0]!.fullReloadRelevantPaths).toEqual([
      "packages/desktop-ui/src/app/launch-checklist/metadata.ts",
    ]);
    expect(result.hasFullReloadRelevantPaths).toBe(true);
  });

  it("captures the generated route tree at finalize time", async () => {
    const root = makeTempRoot();
    const routePath = path.join(root, "packages/desktop-ui/src/routes/settings.tsx");
    const routeTreePath = path.join(root, "packages/desktop-ui/src/routeTree.gen.ts");
    mkdirSync(path.dirname(routePath), { recursive: true });
    writeFileSync(routePath, "export const Route = null;\n");
    writeFileSync(routeTreePath, "export const routeTree = 'stale';\n");
    const controller = createSelfModHmrController({
      enabled: false,
      getDevServerUrl: () => "http://127.0.0.1:57314",
      repoRoot: root,
    });

    await controller.beginRun("run-a");
    await controller.recordWrite("run-a", [routePath]);
    writeFileSync(routeTreePath, "export const routeTree = 'fresh';\n");
    const result = controller.finalize("run-a");

    expect(result.appliedRuns[0]!.files).toContainEqual({
      path: "packages/desktop-ui/src/routeTree.gen.ts",
      content: "export const routeTree = 'fresh';\n",
    });
  });

  it("untracks a path if the run finalizes while Vite tracking is in flight", async () => {
    const originalFetch = globalThis.fetch;
    const root = makeTempRoot();
    const filePath = path.join(root, "packages/desktop-ui/src/race.tsx");
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "export const value = 'race';\n");
    const requestedPaths: string[] = [];
    // Assigned after the fetch mock closes over it.
    // eslint-disable-next-line prefer-const
    let controller: ReturnType<typeof createSelfModHmrController>;
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      requestedPaths.push(new URL(url).pathname);
      if (url.endsWith("/track-paths")) {
        controller.finalize("run-a");
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    controller = createSelfModHmrController({
      enabled: true,
      getDevServerUrl: () => "http://127.0.0.1:57314",
      repoRoot: root,
    });

    try {
      await controller.beginRun("run-a");
      await controller.recordWrite("run-a", [filePath]);
      expect(requestedPaths).toEqual([
        "/__stella/self-mod/hmr/pause-client-updates",
        "/__stella/self-mod/hmr/track-paths",
        "/__stella/self-mod/hmr/untrack-paths",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("forwards full-reload suppression to the Vite apply endpoint", async () => {
    const originalFetch = globalThis.fetch;
    let body: unknown = null;
    globalThis.fetch = vi.fn(async (_input, init) => {
      body = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    const controller = createSelfModHmrController({
      enabled: true,
      getDevServerUrl: () => "http://127.0.0.1:57314",
      repoRoot: makeTempRoot(),
    });

    try {
      await expect(
        controller.apply(
          [
            {
              runId: "run-a",
              paths: ["packages/desktop-ui/src/foo.tsx"],
              files: [
                { path: "packages/desktop-ui/src/foo.tsx", content: "export const a = 1" },
              ],
              runtimeRestartRelevantPaths: [],
              processRestartRelevantPaths: [],
              restartRelevantPaths: [],
              fullReloadRelevantPaths: ["packages/desktop-ui/src/foo.tsx"],
            },
          ],
          { suppressClientFullReload: true },
        ),
      ).resolves.toEqual({ ok: true });
      expect(body).toMatchObject({
        options: { suppressClientFullReload: true },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("forwards forced client full reload to the Vite apply endpoint", async () => {
    const originalFetch = globalThis.fetch;
    let body: unknown = null;
    globalThis.fetch = vi.fn(async (_input, init) => {
      body = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    const controller = createSelfModHmrController({
      enabled: true,
      getDevServerUrl: () => "http://127.0.0.1:57314",
      repoRoot: makeTempRoot(),
    });

    try {
      await expect(
        controller.apply(
          [
            {
              runId: "run-a",
              paths: ["packages/desktop-ui/index.html"],
              files: [
                { path: "packages/desktop-ui/index.html", content: "<html></html>\n" },
              ],
              runtimeRestartRelevantPaths: [],
              processRestartRelevantPaths: [],
              restartRelevantPaths: [],
              fullReloadRelevantPaths: ["packages/desktop-ui/index.html"],
            },
          ],
          { forceClientFullReload: true },
        ),
      ).resolves.toEqual({ ok: true });
      expect(body).toMatchObject({
        options: { forceClientFullReload: true },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns shell-guard changed paths from the Vite endpoint", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/end-shell-mutation")) {
        return new Response(
          JSON.stringify({
            ok: true,
            changedPaths: ["packages/desktop-ui/src/routeTree.gen.ts"],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    const controller = createSelfModHmrController({
      enabled: true,
      getDevServerUrl: () => "http://127.0.0.1:57314",
      repoRoot: makeTempRoot(),
    });

    try {
      await expect(controller.endShellMutationGuard()).resolves.toEqual({
        ok: true,
        changedPaths: ["packages/desktop-ui/src/routeTree.gen.ts"],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("discards only Vite-trackable paths after a failed apply", async () => {
    const originalFetch = globalThis.fetch;
    let body: unknown = null;
    globalThis.fetch = vi.fn(async (_input, init) => {
      body = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    const controller = createSelfModHmrController({
      enabled: true,
      getDevServerUrl: () => "http://127.0.0.1:57314",
      repoRoot: makeTempRoot(),
    });

    try {
      await expect(
        controller.discard([
          {
            runId: "run-a",
            paths: ["packages/desktop-ui/src/foo.tsx", "package.json"],
            files: [
              { path: "packages/desktop-ui/src/foo.tsx", content: "export const a = 1" },
              { path: "package.json", content: '{"name":"x"}\n' },
            ],
            runtimeRestartRelevantPaths: [],
            processRestartRelevantPaths: ["package.json"],
            restartRelevantPaths: ["package.json"],
            fullReloadRelevantPaths: [],
          },
        ]),
      ).resolves.toBe(true);
      expect(body).toEqual({ paths: ["packages/desktop-ui/src/foo.tsx"] });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not use pre-write tracking content as the applied snapshot", async () => {
    const root = makeTempRoot();
    const filePath = path.join(root, "packages/desktop-ui/src/foo.tsx");
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "export const value = 'before';\n");
    const controller = createSelfModHmrController({
      enabled: false,
      getDevServerUrl: () => "http://127.0.0.1:57314",
      repoRoot: root,
    });

    await controller.beginRun("run-a");
    await controller.recordWrite("run-a", [filePath], {
      captureSnapshot: false,
    });
    writeFileSync(filePath, "export const value = 'after';\n");
    await controller.recordWrite("run-a", [filePath]);
    const result = controller.finalize("run-a");

    expect(result.appliedRuns).toHaveLength(1);
    expect(result.appliedRuns[0]!.files).toEqual([
      {
        path: "packages/desktop-ui/src/foo.tsx",
        content: "export const value = 'after';\n",
      },
    ]);
  });

  it("snapshots already-owned post-write paths before tracking newly owned paths", async () => {
    const originalFetch = globalThis.fetch;
    const root = makeTempRoot();
    const oldPath = path.join(root, "packages/desktop-ui/src/old.tsx");
    const newPath = path.join(root, "packages/desktop-ui/src/new.tsx");
    mkdirSync(path.dirname(oldPath), { recursive: true });
    writeFileSync(oldPath, "export const value = 'before';\n");
    writeFileSync(newPath, "export const value = 'new';\n");
    let mutateDuringTrack = false;
    globalThis.fetch = vi.fn(async () => {
      if (mutateDuringTrack) {
        writeFileSync(oldPath, "export const value = 'overwritten';\n");
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    const controller = createSelfModHmrController({
      enabled: true,
      getDevServerUrl: () => "http://127.0.0.1:57314",
      repoRoot: root,
    });

    try {
      await controller.beginRun("run-a");
      await controller.recordWrite("run-a", [oldPath], {
        captureSnapshot: false,
      });
      writeFileSync(oldPath, "export const value = 'after';\n");
      mutateDuringTrack = true;
      await controller.recordWrite("run-a", [oldPath, newPath]);
      const result = controller.finalize("run-a");

      expect(result.appliedRuns).toHaveLength(1);
      expect(result.appliedRuns[0]!.files).toEqual([
        {
          path: "packages/desktop-ui/src/old.tsx",
          content: "export const value = 'after';\n",
        },
        {
          path: "packages/desktop-ui/src/new.tsx",
          content: "export const value = 'new';\n",
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("applies a held run's finalize-time snapshot when an overlapping run cancels", async () => {
    const root = makeTempRoot();
    const filePath = path.join(root, "packages/desktop-ui/src/foo.tsx");
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "export const value = 'a';\n");

    const controller = createSelfModHmrController({
      enabled: false,
      getDevServerUrl: () => "http://127.0.0.1:57314",
      repoRoot: root,
    });

    await controller.beginRun("run-a");
    await controller.beginRun("run-b");
    await controller.recordWrite("run-a", [filePath]);
    await controller.recordWrite("run-b", [filePath]);

    expect(controller.finalize("run-a").appliedRuns).toEqual([]);

    writeFileSync(filePath, "export const value = 'cancelled-b';\n");
    await controller.recordWrite("run-b", [filePath]);
    const cancelResult = await controller.cancel("run-b");

    expect(cancelResult.appliedRuns).toHaveLength(1);
    expect(cancelResult.appliedRuns[0]!.runId).toBe("run-a");
    expect(cancelResult.appliedRuns[0]!.files).toEqual([
      {
        path: "packages/desktop-ui/src/foo.tsx",
        content: "export const value = 'a';\n",
      },
    ]);
  });

  it("represents finalized deletes as a missing file instead of an empty module", async () => {
    const root = makeTempRoot();
    const filePath = path.join(root, "packages/desktop-ui/src/delete-me.tsx");
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "export const value = 'present';\n");

    const controller = createSelfModHmrController({
      enabled: false,
      getDevServerUrl: () => "http://127.0.0.1:57314",
      repoRoot: root,
    });

    await controller.beginRun("run-a");
    unlinkSync(filePath);
    await controller.recordWrite("run-a", [filePath]);
    const result = controller.finalize("run-a");

    expect(result.appliedRuns).toHaveLength(1);
    expect(result.appliedRuns[0]!.files).toEqual([
      {
        path: "packages/desktop-ui/src/delete-me.tsx",
        deleted: true,
      },
    ]);
  });

  it("does not let a cancelled recreate override a held delete", async () => {
    const root = makeTempRoot();
    const filePath = path.join(root, "packages/desktop-ui/src/delete-held.tsx");
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "export const value = 'present';\n");

    const controller = createSelfModHmrController({
      enabled: false,
      getDevServerUrl: () => "http://127.0.0.1:57314",
      repoRoot: root,
    });

    await controller.beginRun("run-a");
    await controller.beginRun("run-b");
    unlinkSync(filePath);
    await controller.recordWrite("run-a", [filePath]);
    await controller.recordWrite("run-b", [filePath]);

    expect(controller.finalize("run-a").appliedRuns).toEqual([]);

    writeFileSync(filePath, "export const value = 'cancelled-b';\n");
    await controller.recordWrite("run-b", [filePath]);
    const cancelResult = await controller.cancel("run-b");

    expect(cancelResult.appliedRuns).toHaveLength(1);
    expect(cancelResult.appliedRuns[0]!.files).toEqual([
      {
        path: "packages/desktop-ui/src/delete-held.tsx",
        deleted: true,
      },
    ]);
  });

  it("does not let an earlier overlapping cancellation pollute a held run snapshot", async () => {
    const root = makeTempRoot();
    const filePath = path.join(root, "packages/desktop-ui/src/early-overlap.tsx");
    mkdirSync(path.dirname(filePath), { recursive: true });

    const controller = createSelfModHmrController({
      enabled: false,
      getDevServerUrl: () => "http://127.0.0.1:57314",
      repoRoot: root,
    });

    await controller.beginRun("run-a");
    await controller.beginRun("run-b");

    writeFileSync(filePath, "export const value = 'a';\n");
    await controller.recordWrite("run-a", [filePath]);

    writeFileSync(filePath, "export const value = 'b-cancelled';\n");
    await controller.recordWrite("run-b", [filePath]);

    expect(controller.finalize("run-a").appliedRuns).toEqual([]);
    const cancelResult = await controller.cancel("run-b");

    expect(cancelResult.appliedRuns).toHaveLength(1);
    expect(cancelResult.appliedRuns[0]!.files).toEqual([
      {
        path: "packages/desktop-ui/src/early-overlap.tsx",
        content: "export const value = 'a';\n",
      },
    ]);
  });
});
