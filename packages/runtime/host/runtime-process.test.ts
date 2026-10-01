import { afterAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRuntimePaths } from "../worker/runtime-paths.js";
import { probeRunningWorker } from "../worker/lifecycle-server.js";
import { RemoteRuntimeHost } from "./remote.js";

/**
 * The runtime process end to end: a real runtime spawned from source, with
 * the host running inside it. An app detaching and a new one attaching is an
 * Electron restart; the runtime must be the same process with the same host.
 */

const workerEntryPath = fileURLToPath(new URL("../worker/entry.ts", import.meta.url));
const stellaAppDir = mkdtempSync(path.join(os.tmpdir(), "stella-runtime-process-"));
const stellaDataDirPath = path.join(stellaAppDir, "data");
const stellaWorkspacePath = path.join(stellaAppDir, "workspace");
mkdirSync(stellaDataDirPath, { recursive: true });
mkdirSync(stellaWorkspacePath, { recursive: true });

const { publicKey } = generateKeyPairSync("ed25519");
const deviceIdentity = {
  deviceId: "runtime-process-test-device",
  publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
};

const app = (activeConversationId: string) => {
  const host = new RemoteRuntimeHost({
    initializeParams: {
      clientName: "runtime-process-test",
      clientVersion: "0.0.0",
      platform: process.platform,
      isDev: false,
      stellaAppDir,
      stellaDataDirPath,
      stellaWorkspacePath,
    },
    disableLocalScheduler: true,
    workerEntryPath,
    bunBinaryPath: process.execPath,
    hostHandlers: {
      getDeviceIdentity: async () => deviceIdentity,
      getActiveConversationId: () => activeConversationId,
      requestLlmCredentials: async () => ({
        ok: true,
        apiKeyProviders: [],
        oauthProviders: [],
      }),
    },
  });
  return host;
};

afterAll(() => {
  const paths = resolveRuntimePaths(stellaAppDir);
  for (const target of [stellaAppDir, paths.rootDir, paths.logDir]) {
    rmSync(target, { recursive: true, force: true });
  }
});

describe("the runtime process", () => {
  test(
    "keeps its host across an app restart and exits on request",
    async () => {
      const first = app("conversation-a");
      const connected: unknown[] = [];
      first.on("runtime-connected", () => connected.push(true));
      await first.start();
      const before = await first.health();
      expect(before.hostPid).toBeGreaterThan(0);
      expect(before.hostPid).not.toBe(process.pid);
      expect(before.workerPid).toBe(before.hostPid);
      expect(before.deviceId).toBe(deviceIdentity.deviceId);
      expect(connected.length).toBeGreaterThan(0);

      // The app goes away; the runtime stays.
      await first.stop();
      expect(await probeRunningWorker(stellaAppDir)).toBe(before.hostPid);

      const second = app("conversation-b");
      await second.start();
      const after = await second.health();
      expect(after.hostPid).toBe(before.hostPid);
      expect(after.workerGeneration).toBe(before.workerGeneration);

      await second.stop({ shutdownRuntime: true });
      expect(await probeRunningWorker(stellaAppDir)).toBeNull();
    },
    60_000,
  );
});
