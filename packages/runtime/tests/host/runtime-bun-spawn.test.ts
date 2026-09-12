import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { startOrAttachWorker } from "@stella/runtime/host/lifecycle";
import { resolveRuntimePaths } from "@stella/runtime/worker/runtime-paths";

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const target of cleanupPaths.splice(0)) {
    rmSync(target, { recursive: true, force: true });
  }
});

describe("runtime Bun launch failures", () => {
  it("rejects a missing runtime executable immediately instead of emitting an uncaught child error", async () => {
    const stellaAppDir = mkdtempSync(path.join(os.tmpdir(), "stella-bun-spawn-"));
    const runtimePaths = resolveRuntimePaths(stellaAppDir);
    cleanupPaths.push(stellaAppDir, runtimePaths.rootDir, runtimePaths.logDir);
    const missingBun = path.join(stellaAppDir, "missing-bun");
    const startedAt = Date.now();

    await expect(
      startOrAttachWorker({
        stellaAppDir,
        workerEntryPath: path.join(stellaAppDir, "worker.js"),
        bunBinaryPath: missingBun,
      }),
    ).rejects.toThrow(
      `Failed to launch Stella's bundled runtime at ${missingBun}`,
    );

    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});
