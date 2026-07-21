import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { StellaRuntimeHost } from "@stella/runtime/host";
import {
  RESTART_CONTINUATION_DISABLE_ENV,
  peekRestartShutdownRecord,
} from "@stella/runtime/kernel/restart-continuation";

const roots: string[] = [];

const createHost = (root: string) =>
  new StellaRuntimeHost({
    hostHandlers: {
      getDeviceIdentity: async () => ({ deviceId: "device", publicKey: "pub" }),
      signHeartbeatPayload: async () => ({
        publicKey: "pub",
        signature: "sig",
      }),
      requestCredential: async () => ({
        secretId: "secret",
        provider: "test",
        label: "Test",
      }),
      displayUpdate: () => undefined,
    },
    initializeParams: {
      clientName: "restart-continuation-test",
      clientVersion: "0.0.0",
      isDev: false,
      platform: process.platform,
      stellaAppDir: root,
      stellaDataDirPath: root,
      stellaWorkspacePath: root,
    },
  });

afterEach(() => {
  delete process.env[RESTART_CONTINUATION_DISABLE_ENV];
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("runtime host restart authorization", () => {
  it("writes the episode before a worker-owning app shutdown", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "stella-host-restart-"));
    roots.push(root);
    await createHost(root).stop({ killWorker: true });
    expect(peekRestartShutdownRecord(root)).toMatchObject({
      version: 1,
      reason: "app-shutdown",
    });
  });

  it("does not authorize continuation when the host only detaches", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "stella-host-detach-"));
    roots.push(root);
    await createHost(root).stop();
    expect(peekRestartShutdownRecord(root)).toBeNull();
  });
});
