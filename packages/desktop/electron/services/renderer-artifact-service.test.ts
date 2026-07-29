import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { STELLA_RENDERER_CSP_META } from "@stella/contracts/desktop/renderer-security";
import {
  assertRendererEntrypointCsp,
  computeRendererArtifactSha256,
  computeRendererManifestSha256,
  parseRendererArtifactManifest,
  RendererArtifactService,
  type RendererArtifactFetcher,
  type RendererArtifactFile,
  type RendererArtifactManifest,
  type RendererEntryName,
} from "./renderer-artifact-service.js";
import { RendererDeploymentSyncService } from "./renderer-deployment-sync-service.js";

const fsPromises = fs.promises;
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((temporaryRoot) =>
      fsPromises.rm(temporaryRoot, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

const digest = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

const createManifest = (
  buildId: string,
  marker: string,
): {
  manifest: RendererArtifactManifest;
  manifestJson: string;
  downloads: Map<string, Buffer>;
  manifestSha256: string;
} => {
  const entryFiles: Record<RendererEntryName, string> = {
    full: "index.html",
    mini: "mini.html",
    overlay: "overlay.html",
    pet: "pet.html",
  };
  const downloads = new Map<string, Buffer>();
  const files: RendererArtifactFile[] = [
    ...Object.values(entryFiles).map((filePath) => {
      const bytes = Buffer.from(
        `<!doctype html><html><head>${STELLA_RENDERER_CSP_META}</head><body>${marker}:${filePath}</body></html>`,
      );
      const url = `https://artifacts.example.test/${buildId}/${filePath}`;
      downloads.set(url, bytes);
      return {
        path: filePath,
        url,
        size: bytes.byteLength,
        sha256: digest(bytes),
        contentType: "text/html; charset=utf-8",
      };
    }),
    (() => {
      const bytes = Buffer.from(`console.log(${JSON.stringify(marker)})`);
      const url = `https://artifacts.example.test/${buildId}/assets/main.js`;
      downloads.set(url, bytes);
      return {
        path: "assets/main.js",
        url,
        size: bytes.byteLength,
        sha256: digest(bytes),
        contentType: "application/javascript; charset=utf-8",
      };
    })(),
  ];
  const manifest: RendererArtifactManifest = {
    schemaVersion: 1,
    buildId,
    version: buildId,
    artifactPrefix: `interiors/owner/${buildId}`,
    bridgeAbi: 1,
    minShellVersion: "0.0.0",
    entries: entryFiles,
    files,
    artifactSha256: computeRendererArtifactSha256(files),
    size: files.reduce((total, file) => total + file.size, 0),
  };
  const manifestJson = JSON.stringify(manifest);
  return {
    manifest,
    manifestJson,
    downloads,
    manifestSha256: `sha256:${computeRendererManifestSha256(manifestJson)}`,
  };
};

const createFetcher =
  (downloads: Map<string, Buffer>): RendererArtifactFetcher =>
  async (url) => {
    const bytes = downloads.get(url);
    if (!bytes) {
      return {
        ok: false,
        status: 404,
        url,
        body: null,
      };
    }
    return {
      ok: true,
      status: 200,
      url,
      headers: {
        get: (name) =>
          name.toLowerCase() === "content-length"
            ? String(bytes.byteLength)
            : null,
      },
      body: (async function* () {
        const midpoint = Math.max(1, Math.floor(bytes.byteLength / 2));
        yield bytes.subarray(0, midpoint);
        yield bytes.subarray(midpoint);
      })(),
    };
  };

const createHarness = async (
  downloads: Map<string, Buffer>,
  now: () => Date = () => new Date("2026-07-28T12:00:00.000Z"),
) => {
  const temporaryRoot = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "stella-renderer-artifacts-"),
  );
  temporaryRoots.push(temporaryRoot);
  const userDataDir = path.join(temporaryRoot, "user-data");
  const bundledRendererRoot = path.join(temporaryRoot, "bundled");
  await fsPromises.mkdir(bundledRendererRoot, { recursive: true });
  for (const fileName of [
    "index.html",
    "mini.html",
    "overlay.html",
    "pet.html",
  ]) {
    await fsPromises.writeFile(
      path.join(bundledRendererRoot, fileName),
      `<html>bundled:${fileName}</html>`,
    );
  }
  return {
    temporaryRoot,
    service: new RendererArtifactService({
      userDataDir,
      bundledRendererRoot,
      shellVersion: "0.0.0",
      supportedBridgeAbi: 1,
      fetcher: createFetcher(downloads),
      now,
    }),
  };
};

describe("renderer artifact manifest validation", () => {
  test("requires the immutable CSP as the first head child", () => {
    expect(() =>
      assertRendererEntrypointCsp(
        `<!doctype html><html><head>${STELLA_RENDERER_CSP_META}<script src="/assets/main.js"></script></head></html>`,
        "entry",
      ),
    ).not.toThrow();
    expect(() =>
      assertRendererEntrypointCsp(
        `<!doctype html><html><head><script src="https://example.test/x.js"></script>${STELLA_RENDERER_CSP_META}</head></html>`,
        "entry",
      ),
    ).toThrow("canonical first-child");
  });

  test("rejects traversal, portable path collisions, and aggregate digest drift", () => {
    const fixture = createManifest("build-a", "alpha");

    const traversal = structuredClone(fixture.manifest) as unknown as Record<
      string,
      unknown
    >;
    const traversalFiles = traversal.files as Record<string, unknown>[];
    traversalFiles[0] = {
      ...traversalFiles[0],
      path: "../index.html",
    };
    expect(() => parseRendererArtifactManifest(traversal)).toThrow(
      "safe relative artifact path",
    );

    const collision = structuredClone(fixture.manifest);
    collision.files[1] = {
      ...collision.files[1],
      path: collision.files[0].path.toUpperCase(),
    };
    expect(() => parseRendererArtifactManifest(collision)).toThrow(
      "case-colliding",
    );

    const digestDrift = structuredClone(fixture.manifest);
    digestDrift.files[0] = {
      ...digestDrift.files[0],
      size: digestDrift.files[0].size + 1,
    };
    expect(() => parseRendererArtifactManifest(digestDrift)).toThrow(
      "artifactSha256",
    );
  });

  test("requires the exact manifest schema and HTTPS download URLs", () => {
    const fixture = createManifest("build-a", "alpha");
    expect(() =>
      parseRendererArtifactManifest({
        ...fixture.manifest,
        unexpected: true,
      }),
    ).toThrow("unsupported or missing fields");

    const insecure = structuredClone(fixture.manifest);
    insecure.files[0] = {
      ...insecure.files[0],
      url: "http://artifacts.example.test/index.html",
    };
    expect(() => parseRendererArtifactManifest(insecure)).toThrow(
      "credential-free HTTPS URL",
    );

    const reserved = structuredClone(fixture.manifest);
    reserved.files[reserved.files.length - 1] = {
      ...reserved.files[reserved.files.length - 1],
      path: "manifest.json",
    };
    expect(() => parseRendererArtifactManifest(reserved)).toThrow(
      "reserved by the desktop shell",
    );
  });
});

describe("RendererArtifactService", () => {
  test("stages a fully verified immutable candidate and persists state atomically", async () => {
    const fixture = createManifest("build-a", "alpha");
    const { service } = await createHarness(fixture.downloads);

    const candidate = await service.stage({
      manifestJson: fixture.manifestJson,
      expectedManifestSha256: fixture.manifestSha256,
    });

    expect(candidate.artifactSha256).toBe(fixture.manifest.artifactSha256);
    expect((await service.getState()).candidate).toEqual(candidate);
    const installedIndex = path.join(
      service.versionsDir,
      candidate.manifestSha256,
      "index.html",
    );
    expect(await fsPromises.readFile(installedIndex, "utf8")).toContain(
      "alpha",
    );
    expect(await fsPromises.readdir(service.stagingDir)).toEqual([]);
    expect(
      (await fsPromises.readdir(service.rootDir)).filter((entry) =>
        entry.endsWith(".tmp"),
      ),
    ).toEqual([]);
  });

  test("rejects an untrusted manifest digest before downloading", async () => {
    const fixture = createManifest("build-a", "alpha");
    let fetchCount = 0;
    const { temporaryRoot, service } = await createHarness(fixture.downloads);
    const countingService = new RendererArtifactService({
      userDataDir: path.join(temporaryRoot, "other-user-data"),
      bundledRendererRoot: path.join(temporaryRoot, "bundled"),
      shellVersion: "0.0.0",
      supportedBridgeAbi: 1,
      fetcher: async (...args) => {
        fetchCount += 1;
        return createFetcher(fixture.downloads)(...args);
      },
    });

    await expect(
      countingService.stage({
        manifestJson: fixture.manifestJson,
        expectedManifestSha256: "0".repeat(64),
      }),
    ).rejects.toThrow("control plane");
    expect(fetchCount).toBe(0);
    expect((await service.getState()).candidate).toBeUndefined();
  });

  test("rejects artifacts that require a different bridge or newer shell", async () => {
    const fixture = createManifest("build-a", "alpha");
    const { service } = await createHarness(fixture.downloads);
    const wrongBridge = {
      ...fixture.manifest,
      bridgeAbi: 2,
    };
    const wrongBridgeJson = JSON.stringify(wrongBridge);
    await expect(
      service.stage({
        manifestJson: wrongBridgeJson,
        expectedManifestSha256: computeRendererManifestSha256(wrongBridgeJson),
      }),
    ).rejects.toThrow("bridge ABI");

    const newerShell = {
      ...fixture.manifest,
      minShellVersion: "1.0.0",
    };
    const newerShellJson = JSON.stringify(newerShell);
    await expect(
      service.stage({
        manifestJson: newerShellJson,
        expectedManifestSha256: computeRendererManifestSha256(newerShellJson),
      }),
    ).rejects.toThrow("newer desktop shell");
  });

  test("rejects hash mismatches and removes the partial staging tree", async () => {
    const fixture = createManifest("build-a", "alpha");
    const badDownloads = new Map(fixture.downloads);
    const firstFile = fixture.manifest.files[0];
    badDownloads.set(firstFile.url, Buffer.alloc(firstFile.size, 0x78));
    const { service } = await createHarness(badDownloads);

    await expect(
      service.stage({
        manifestJson: fixture.manifestJson,
        expectedManifestSha256: fixture.manifestSha256,
      }),
    ).rejects.toThrow("hash did not match");
    expect(await fsPromises.readdir(service.stagingDir)).toEqual([]);
    expect((await service.getState()).candidate).toBeUndefined();
  });

  test("rejects downloads that report a redirected final URL", async () => {
    const fixture = createManifest("build-a", "alpha");
    const { temporaryRoot } = await createHarness(fixture.downloads);
    const service = new RendererArtifactService({
      userDataDir: path.join(temporaryRoot, "redirect-user-data"),
      bundledRendererRoot: path.join(temporaryRoot, "bundled"),
      shellVersion: "0.0.0",
      supportedBridgeAbi: 1,
      fetcher: async (url) => {
        const bytes = fixture.downloads.get(url);
        if (!bytes) return { ok: false, status: 404, body: null };
        return {
          ok: true,
          status: 200,
          url: "https://redirected.example.test/unexpected",
          body: (async function* () {
            yield bytes;
          })(),
        };
      },
    });

    await expect(
      service.stage({
        manifestJson: fixture.manifestJson,
        expectedManifestSha256: fixture.manifestSha256,
      }),
    ).rejects.toThrow("redirected");
  });

  test("activates, marks healthy, rolls back, and quarantines a failed candidate", async () => {
    const first = createManifest("build-a", "alpha");
    const second = createManifest("build-b", "beta");
    const downloads = new Map([...first.downloads, ...second.downloads]);
    let tick = 0;
    const { service } = await createHarness(
      downloads,
      () => new Date(1_722_165_600_000 + tick++ * 1_000),
    );

    const firstRef = await service.stage({
      manifestJson: first.manifestJson,
      expectedManifestSha256: first.manifestSha256,
    });
    await service.activate();
    await service.markHealthy();

    const secondRef = await service.stage({
      manifestJson: second.manifestJson,
      expectedManifestSha256: second.manifestSha256,
    });
    await service.activate();
    expect((await service.getState()).previous).toEqual(firstRef);

    const rolledBack = await service.rollback();
    expect(rolledBack).toEqual(firstRef);

    await service.stage({
      manifestJson: second.manifestJson,
      expectedManifestSha256: second.manifestSha256,
    });
    await service.activate(secondRef.artifactSha256);
    const quarantineFallback = await service.quarantine(
      secondRef.artifactSha256,
      "renderer failed its readiness probe",
    );
    expect(quarantineFallback).toEqual(firstRef);
    const state = await service.getState();
    expect(state.active).toEqual(firstRef);
    expect(state.lastKnownGood).toEqual(firstRef);
    expect(state.quarantined).toEqual([
      expect.objectContaining({
        artifactSha256: secondRef.artifactSha256,
        reason: "renderer failed its readiness probe",
      }),
    ]);
    const resolved = await service.resolveEntrypoint("full");
    expect(resolved.source).toBe("installed");
    expect(await fsPromises.readFile(resolved.filePath, "utf8")).toContain(
      "alpha",
    );
  });

  test("falls back to the bundled renderer when state is corrupt", async () => {
    const fixture = createManifest("build-a", "alpha");
    const { service } = await createHarness(fixture.downloads);
    await fsPromises.mkdir(service.rootDir, { recursive: true });
    await fsPromises.writeFile(service.statePath, '{"schemaVersion":999}');

    const resolved = await service.resolveEntrypoint("pet");

    expect(resolved.source).toBe("bundled");
    expect(path.basename(resolved.filePath)).toBe("pet.html");
  });

  test("does not boot an activated artifact that was never marked healthy", async () => {
    const fixture = createManifest("build-a", "alpha");
    const { temporaryRoot, service } = await createHarness(fixture.downloads);
    await service.stage({
      manifestJson: fixture.manifestJson,
      expectedManifestSha256: fixture.manifestSha256,
    });
    await service.activate();
    expect((await service.resolveEntrypoint("full")).source).toBe("installed");

    const restartedService = new RendererArtifactService({
      userDataDir: path.join(temporaryRoot, "user-data"),
      bundledRendererRoot: path.join(temporaryRoot, "bundled"),
      shellVersion: "0.0.0",
      supportedBridgeAbi: 1,
      fetcher: createFetcher(fixture.downloads),
    });
    expect((await restartedService.resolveEntrypoint("full")).source).toBe(
      "bundled",
    );

    await service.markHealthy();
    const healthyRestart = new RendererArtifactService({
      userDataDir: path.join(temporaryRoot, "user-data"),
      bundledRendererRoot: path.join(temporaryRoot, "bundled"),
      shellVersion: "0.0.0",
      supportedBridgeAbi: 1,
      fetcher: createFetcher(fixture.downloads),
    });
    expect((await healthyRestart.resolveEntrypoint("full")).source).toBe(
      "installed",
    );
  });

  test("keeps distinct manifests when separate build IDs produce identical files", async () => {
    const first = createManifest("build-a", "same-output");
    const second = createManifest("build-b", "same-output");
    expect(first.manifest.artifactSha256).toBe(second.manifest.artifactSha256);
    expect(first.manifestSha256).not.toBe(second.manifestSha256);
    const { service } = await createHarness(
      new Map([...first.downloads, ...second.downloads]),
    );

    await service.stage({
      manifestJson: first.manifestJson,
      expectedManifestSha256: first.manifestSha256,
    });
    await service.activate();
    await service.markHealthy();
    await service.stage({
      manifestJson: second.manifestJson,
      expectedManifestSha256: second.manifestSha256,
    });
    const activated = await service.activate();

    expect(activated.buildId).toBe("build-b");
    expect(activated.manifestSha256).toBe(
      second.manifestSha256.slice("sha256:".length),
    );
    expect((await service.resolveEntrypoint("full")).artifact?.buildId).toBe(
      "build-b",
    );
  });
});

describe("RendererDeploymentSyncService", () => {
  test("skips an already verified route and repairs a corrupt installed copy", async () => {
    const fixture = createManifest("build-a", "alpha");
    const { service } = await createHarness(fixture.downloads);
    let activationCount = 0;
    const sync = new RendererDeploymentSyncService({
      artifactService: service,
      getConvexUrl: () => null,
      getAuthToken: async () => null,
      onArtifactActivated: async () => {
        activationCount += 1;
      },
      onArtifactRolledBack: async () => {
        throw new Error("rollback should not run");
      },
    });
    const snapshot = {
      deployableId: "owner-interior",
      routeRevision: 1,
      previousBuildId: null,
      build: {
        buildId: fixture.manifest.buildId,
        artifactPrefix: fixture.manifest.artifactPrefix,
        artifactManifestJson: fixture.manifestJson,
        manifestSha256: fixture.manifestSha256,
        artifactDigest: `sha256:${fixture.manifest.artifactSha256}`,
        artifactSizeBytes: fixture.manifest.size,
        bridgeAbi: fixture.manifest.bridgeAbi,
        minShellVersion: fixture.manifest.minShellVersion,
      },
    };

    await sync.applyDeploymentSnapshot(snapshot);
    await sync.applyDeploymentSnapshot(snapshot);

    const restartedSync = new RendererDeploymentSyncService({
      artifactService: service,
      getConvexUrl: () => null,
      getAuthToken: async () => null,
      onArtifactActivated: async () => {
        activationCount += 1;
      },
      onArtifactRolledBack: async () => {
        throw new Error("rollback should not run");
      },
    });
    await restartedSync.applyDeploymentSnapshot(snapshot);

    const installed = await service.resolveEntrypoint("full");
    expect(installed.source).toBe("installed");
    await fsPromises.writeFile(installed.filePath, "corrupt");
    const repairSync = new RendererDeploymentSyncService({
      artifactService: service,
      getConvexUrl: () => null,
      getAuthToken: async () => null,
      onArtifactActivated: async () => {
        activationCount += 1;
      },
      onArtifactRolledBack: async () => {
        throw new Error("rollback should not run");
      },
    });
    await repairSync.applyDeploymentSnapshot(snapshot);

    const state = await service.getState();
    expect(activationCount).toBe(2);
    expect(state.active?.buildId).toBe("build-a");
    expect(state.lastKnownGood).toEqual(state.active);
    expect(await fsPromises.readFile(installed.filePath, "utf8")).toContain(
      "alpha",
    );
  });

  test("recovers a corrupt durable state file before applying the active route", async () => {
    const fixture = createManifest("build-a", "alpha");
    const { service } = await createHarness(fixture.downloads);
    await fsPromises.mkdir(service.rootDir, { recursive: true });
    await fsPromises.writeFile(service.statePath, '{"schemaVersion":999}');
    let activationCount = 0;
    const sync = new RendererDeploymentSyncService({
      artifactService: service,
      getConvexUrl: () => null,
      getAuthToken: async () => null,
      onArtifactActivated: async () => {
        activationCount += 1;
      },
      onArtifactRolledBack: async () => undefined,
    });

    await sync.applyDeploymentSnapshot({
      deployableId: "owner-interior",
      routeRevision: 1,
      previousBuildId: null,
      build: {
        buildId: fixture.manifest.buildId,
        artifactPrefix: fixture.manifest.artifactPrefix,
        artifactManifestJson: fixture.manifestJson,
        manifestSha256: fixture.manifestSha256,
        artifactDigest: `sha256:${fixture.manifest.artifactSha256}`,
        artifactSizeBytes: fixture.manifest.size,
        bridgeAbi: fixture.manifest.bridgeAbi,
        minShellVersion: fixture.manifest.minShellVersion,
      },
    });

    expect(activationCount).toBe(1);
    expect((await service.getState()).active?.buildId).toBe("build-a");
    expect(
      (await fsPromises.readdir(service.rootDir)).some((name) =>
        name.startsWith("state.corrupt."),
      ),
    ).toBe(true);
  });

  test("quarantines a renderer that fails stabilization and reloads fallback", async () => {
    const fixture = createManifest("build-a", "alpha");
    const { service } = await createHarness(fixture.downloads);
    let rollbackCount = 0;
    const sync = new RendererDeploymentSyncService({
      artifactService: service,
      getConvexUrl: () => null,
      getAuthToken: async () => null,
      onArtifactActivated: async () => {
        throw new Error("renderer crashed during readiness probe");
      },
      onArtifactRolledBack: async () => {
        rollbackCount += 1;
      },
    });
    let controlPlaneRollbackCount = 0;
    (
      sync as unknown as {
        client: {
          mutation: () => Promise<null>;
        };
      }
    ).client = {
      mutation: async () => {
        controlPlaneRollbackCount += 1;
        return null;
      },
    };

    await sync.applyDeploymentSnapshot({
      deployableId: "owner-interior",
      routeRevision: 1,
      previousBuildId: null,
      build: {
        buildId: fixture.manifest.buildId,
        artifactPrefix: fixture.manifest.artifactPrefix,
        artifactManifestJson: fixture.manifestJson,
        manifestSha256: fixture.manifestSha256,
        artifactDigest: `sha256:${fixture.manifest.artifactSha256}`,
        artifactSizeBytes: fixture.manifest.size,
        bridgeAbi: fixture.manifest.bridgeAbi,
        minShellVersion: fixture.manifest.minShellVersion,
      },
    });

    const state = await service.getState();
    expect(rollbackCount).toBe(1);
    expect(controlPlaneRollbackCount).toBe(1);
    expect(state.active).toBeUndefined();
    expect(state.quarantined).toEqual([
      expect.objectContaining({
        buildId: "build-a",
        reason: "renderer crashed during readiness probe",
      }),
    ]);
    expect((await service.resolveEntrypoint("full")).source).toBe("bundled");
  });

  test("rejects a control-plane build ID that differs from the signed manifest", async () => {
    const fixture = createManifest("build-a", "alpha");
    const { service } = await createHarness(fixture.downloads);
    let activationCount = 0;
    const sync = new RendererDeploymentSyncService({
      artifactService: service,
      getConvexUrl: () => null,
      getAuthToken: async () => null,
      onArtifactActivated: async () => {
        activationCount += 1;
      },
      onArtifactRolledBack: async () => undefined,
    });

    const mismatchedSnapshot = {
      deployableId: "owner-interior",
      routeRevision: 1,
      previousBuildId: null,
      build: {
        buildId: "different-build",
        artifactPrefix: fixture.manifest.artifactPrefix,
        artifactManifestJson: fixture.manifestJson,
        manifestSha256: fixture.manifestSha256,
        artifactDigest: `sha256:${fixture.manifest.artifactSha256}`,
        artifactSizeBytes: fixture.manifest.size,
        bridgeAbi: fixture.manifest.bridgeAbi,
        minShellVersion: fixture.manifest.minShellVersion,
      },
    };
    await expect(
      sync.applyDeploymentSnapshot(mismatchedSnapshot),
    ).rejects.toThrow("build ID");
    // A failed rollback transport must not mark the rejected route as handled.
    await expect(
      sync.applyDeploymentSnapshot(mismatchedSnapshot),
    ).rejects.toThrow("build ID");
    expect(activationCount).toBe(0);
    expect((await service.getState()).active).toBeUndefined();
  });

  test("rolls back a route whose manifest digest is invalid without activating it", async () => {
    const fixture = createManifest("build-a", "alpha");
    const { service } = await createHarness(fixture.downloads);
    let controlPlaneRollbackCount = 0;
    let activationCount = 0;
    const sync = new RendererDeploymentSyncService({
      artifactService: service,
      getConvexUrl: () => null,
      getAuthToken: async () => null,
      onArtifactActivated: async () => {
        activationCount += 1;
      },
      onArtifactRolledBack: async () => undefined,
    });
    (
      sync as unknown as {
        client: { mutation: () => Promise<null> };
      }
    ).client = {
      mutation: async () => {
        controlPlaneRollbackCount += 1;
        return null;
      },
    };

    await sync.applyDeploymentSnapshot({
      deployableId: "owner-interior",
      routeRevision: 1,
      previousBuildId: null,
      build: {
        buildId: fixture.manifest.buildId,
        artifactPrefix: fixture.manifest.artifactPrefix,
        artifactManifestJson: fixture.manifestJson,
        manifestSha256: `sha256:${"0".repeat(64)}`,
        artifactDigest: `sha256:${fixture.manifest.artifactSha256}`,
        artifactSizeBytes: fixture.manifest.size,
        bridgeAbi: fixture.manifest.bridgeAbi,
        minShellVersion: fixture.manifest.minShellVersion,
      },
    });

    expect(controlPlaneRollbackCount).toBe(1);
    expect(activationCount).toBe(0);
    expect((await service.getState()).active).toBeUndefined();
  });
});
