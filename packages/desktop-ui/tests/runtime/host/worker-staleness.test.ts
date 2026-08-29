import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isWorkerBusyForRestart,
  StellaRuntimeHost,
} from "@stella/runtime/host";
import { computeRuntimeBuildStamp } from "@stella/runtime/worker/runtime-build-stamp";
import { resolveRuntimePaths } from "@stella/runtime/worker/runtime-paths";

const tempDirs: string[] = [];
const runtimeRootDirs: string[] = [];
const hosts: StellaRuntimeHost[] = [];

const IDLE_HEALTH = {
  health: { ok: true },
  activeRun: null,
  activeAgentCount: 0,
  pid: 4242,
  deviceId: "dev-device",
};

const BUSY_HEALTH = {
  ...IDLE_HEALTH,
  activeRun: { runId: "run-busy", conversationId: "conv-1" },
};

const makeWorkerEntryTree = () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "stella-staleness-tree-"));
  tempDirs.push(base);
  const treeRoot = path.join(base, "runtime");
  mkdirSync(path.join(treeRoot, "worker"), { recursive: true });
  const entryPath = path.join(treeRoot, "worker", "entry.js");
  writeFileSync(entryPath, "// worker entry\n");
  return entryPath;
};

const createHost = (args: {
  stellaAppDir: string;
  workerEntryPath: string;
}) => {
  const host = new StellaRuntimeHost({
    workerEntryPath: args.workerEntryPath,
    hostHandlers: {
      getDeviceIdentity: async () => ({
        deviceId: "dev-device",
        publicKey: "pub",
      }),
      requestCredential: async () => ({
        secretId: "secret",
        provider: "test",
        label: "Test",
      }),
      displayUpdate: () => undefined,
    },
    initializeParams: {
      clientName: "test-client",
      clientVersion: "0.0.0",
      isDev: false,
      platform: process.platform,
      stellaAppDir: args.stellaAppDir,
      stellaDataDirPath: args.stellaAppDir,
      stellaWorkspacePath: args.stellaAppDir,
    },
  });
  hosts.push(host);
  const anyHost = host as any;
  anyHost.started = true;
  anyHost.restartWorker = vi.fn().mockResolvedValue({ ok: true });
  anyHost.getWorkerHealth = vi.fn().mockResolvedValue(IDLE_HEALTH);
  return anyHost;
};

const setupRoot = () => {
  const stellaAppDir = mkdtempSync(
    path.join(os.tmpdir(), "stella-staleness-root-"),
  );
  tempDirs.push(stellaAppDir);
  const paths = resolveRuntimePaths(stellaAppDir);
  mkdirSync(paths.rootDir, { recursive: true });
  runtimeRootDirs.push(paths.rootDir);
  return { stellaAppDir, paths };
};

const drain = async (anyHost: any) => {
  await anyHost.reloadQueue;

  await Promise.resolve();
  await anyHost.reloadQueue;
};

afterEach(async () => {
  for (const host of hosts.splice(0)) {
    (host as any).stopStaleWorkerQuiescencePoll?.();
  }
  for (const dir of runtimeRootDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.useRealTimers();
});

describe("isWorkerBusyForRestart", () => {
  it("treats an unreachable worker as not busy", () => {
    expect(isWorkerBusyForRestart(null)).toBe(false);
  });

  it("flags active runs, spawned agents, and voice work as busy", () => {
    expect(
      isWorkerBusyForRestart({ activeRun: null, activeAgentCount: 0 } as any),
    ).toBe(false);
    expect(
      isWorkerBusyForRestart({
        activeRun: { runId: "r" },
        activeAgentCount: 0,
      } as any),
    ).toBe(true);
    expect(
      isWorkerBusyForRestart({ activeRun: null, activeAgentCount: 2 } as any),
    ).toBe(true);
    expect(
      isWorkerBusyForRestart({
        activeRun: null,
        activeAgentCount: 0,
        voiceBusy: true,
      } as any),
    ).toBe(true);
    expect(
      isWorkerBusyForRestart({
        activeRun: null,
        activeAgentCount: 0,
        pendingVoiceRequestCount: 1,
      } as any),
    ).toBe(true);
  });
});

describe("stale worker staleness handshake", () => {
  it("detects a build-stamp mismatch on reattach and restarts an idle worker", async () => {
    const { stellaAppDir, paths } = setupRoot();
    const workerEntryPath = makeWorkerEntryTree();
    writeFileSync(paths.buildStampFile, "stamp-from-an-older-build\n");
    const anyHost = createHost({ stellaAppDir, workerEntryPath });
    anyHost.workerHealthCache = IDLE_HEALTH;

    await anyHost.evaluateWorkerStalenessOnConnect({
      pid: 4242,
      attachedToExistingWorker: true,
    });

    expect(anyHost.pendingStaleWorkerRestart?.reason).toBe(
      "build-stamp-mismatch",
    );
    expect(existsSync(paths.pendingWorkerRestartFile)).toBe(true);

    await anyHost.flushWorkerRestart();
    await drain(anyHost);
    expect(anyHost.restartWorker).toHaveBeenCalledTimes(1);
  });

  it("treats a missing worker stamp (pre-stamp worker) as stale", async () => {
    const { stellaAppDir } = setupRoot();
    const workerEntryPath = makeWorkerEntryTree();
    const anyHost = createHost({ stellaAppDir, workerEntryPath });
    anyHost.workerHealthCache = IDLE_HEALTH;

    await anyHost.evaluateWorkerStalenessOnConnect({
      pid: 4242,
      attachedToExistingWorker: true,
    });

    expect(anyHost.pendingStaleWorkerRestart?.reason).toBe(
      "worker-stamp-missing",
    );
  });

  it("does not flag a reattached worker whose stamp matches the on-disk tree", async () => {
    const { stellaAppDir, paths } = setupRoot();
    const workerEntryPath = makeWorkerEntryTree();
    writeFileSync(
      paths.buildStampFile,
      `${computeRuntimeBuildStamp(workerEntryPath)}\n`,
    );
    const anyHost = createHost({ stellaAppDir, workerEntryPath });
    anyHost.workerHealthCache = IDLE_HEALTH;

    await anyHost.evaluateWorkerStalenessOnConnect({
      pid: 4242,
      attachedToExistingWorker: true,
    });

    expect(anyHost.pendingStaleWorkerRestart).toBeNull();
    expect(existsSync(paths.pendingWorkerRestartFile)).toBe(false);
    await drain(anyHost);
    expect(anyHost.restartWorker).not.toHaveBeenCalled();
  });

  it("defers the restart while busy and restarts once the worker goes quiescent", async () => {
    const { stellaAppDir, paths } = setupRoot();
    const workerEntryPath = makeWorkerEntryTree();
    writeFileSync(paths.buildStampFile, "stale-stamp\n");
    const anyHost = createHost({ stellaAppDir, workerEntryPath });
    anyHost.workerHealthCache = BUSY_HEALTH;
    anyHost.getWorkerHealth = vi.fn().mockResolvedValue(BUSY_HEALTH);

    await anyHost.evaluateWorkerStalenessOnConnect({
      pid: 4242,
      attachedToExistingWorker: true,
    });

    expect(anyHost.pendingStaleWorkerRestart?.reason).toBe(
      "build-stamp-mismatch",
    );

    await anyHost.flushWorkerRestart();
    await drain(anyHost);
    expect(anyHost.restartWorker).not.toHaveBeenCalled();

    anyHost.getWorkerHealth = vi.fn().mockResolvedValue(IDLE_HEALTH);
    await anyHost.flushWorkerRestart();
    await drain(anyHost);
    expect(anyHost.restartWorker).toHaveBeenCalledTimes(1);
  });

  it("re-checks busy-ness immediately before killing so a fresh run is never cut down", async () => {
    const { stellaAppDir, paths } = setupRoot();
    const workerEntryPath = makeWorkerEntryTree();
    writeFileSync(paths.buildStampFile, "stale-stamp\n");
    const anyHost = createHost({ stellaAppDir, workerEntryPath });
    anyHost.workerHealthCache = IDLE_HEALTH;

    await anyHost.evaluateWorkerStalenessOnConnect({
      pid: 4242,
      attachedToExistingWorker: true,
    });

    anyHost.getWorkerHealth = vi
      .fn()
      .mockResolvedValueOnce(IDLE_HEALTH)
      .mockResolvedValue(BUSY_HEALTH);
    await anyHost.flushWorkerRestart();
    await drain(anyHost);
    expect(anyHost.restartWorker).not.toHaveBeenCalled();

    expect(anyHost.pendingStaleWorkerRestart).not.toBeNull();
  });

  it("persists the pending flag so a new host (post Electron restart) picks it up", async () => {
    const { stellaAppDir, paths } = setupRoot();
    const workerEntryPath = makeWorkerEntryTree();
    const anyHostA = createHost({ stellaAppDir, workerEntryPath });
    anyHostA.getWorkerHealth = vi.fn().mockResolvedValue(BUSY_HEALTH);
    await anyHostA.markPendingWorkerRestart("runtime-update");
    expect(existsSync(paths.pendingWorkerRestartFile)).toBe(true);

    writeFileSync(
      paths.buildStampFile,
      `${computeRuntimeBuildStamp(workerEntryPath)}\n`,
    );
    const anyHostB = createHost({ stellaAppDir, workerEntryPath });
    anyHostB.workerHealthCache = IDLE_HEALTH;
    await anyHostB.evaluateWorkerStalenessOnConnect({
      pid: 4242,
      attachedToExistingWorker: true,
    });
    expect(anyHostB.pendingStaleWorkerRestart?.reason).toBe(
      "pending-restart-flag",
    );
    await anyHostB.flushWorkerRestart();
    await drain(anyHostB);
    expect(anyHostB.restartWorker).toHaveBeenCalledTimes(1);
  });

  it("clears the pending flag when a freshly spawned worker connects", async () => {
    const { stellaAppDir, paths } = setupRoot();
    const workerEntryPath = makeWorkerEntryTree();
    const anyHost = createHost({ stellaAppDir, workerEntryPath });
    anyHost.getWorkerHealth = vi.fn().mockResolvedValue(BUSY_HEALTH);
    await anyHost.markPendingWorkerRestart("runtime-update");
    expect(existsSync(paths.pendingWorkerRestartFile)).toBe(true);

    await anyHost.evaluateWorkerStalenessOnConnect({
      pid: 4243,
      attachedToExistingWorker: false,
    });

    expect(anyHost.pendingStaleWorkerRestart).toBeNull();
    expect(existsSync(paths.pendingWorkerRestartFile)).toBe(false);
  });

  it("marks pending and restarts immediately for an idle runtime update", async () => {
    const { stellaAppDir, paths } = setupRoot();
    const workerEntryPath = makeWorkerEntryTree();
    const anyHost = createHost({ stellaAppDir, workerEntryPath });

    vi.useFakeTimers();
    await anyHost.markPendingWorkerRestart("runtime-update");
    expect(existsSync(paths.pendingWorkerRestartFile)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_100);
    vi.useRealTimers();
    await drain(anyHost);
    expect(anyHost.restartWorker).toHaveBeenCalledTimes(1);
  });

  it("reports pendingWorkerRestart in the health snapshot", async () => {
    const { stellaAppDir } = setupRoot();
    const workerEntryPath = makeWorkerEntryTree();
    const anyHost = createHost({ stellaAppDir, workerEntryPath });
    anyHost.getWorkerHealth = vi.fn().mockResolvedValue(BUSY_HEALTH);

    expect((await anyHost.health()).pendingWorkerRestart).toBeUndefined();
    await anyHost.markPendingWorkerRestart("runtime-update");
    expect((await anyHost.health()).pendingWorkerRestart).toBe(true);
  });
});
