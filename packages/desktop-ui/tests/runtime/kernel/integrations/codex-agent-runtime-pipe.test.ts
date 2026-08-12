import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));

describe("Codex app-server pipe handling", () => {
  afterEach(async () => {
    const { shutdownCodexAppServerRuntime } = await import(
      "@stella/runtime/kernel/integrations/codex-agent-runtime"
    );
    shutdownCodexAppServerRuntime();
    vi.clearAllMocks();
  });

  it("rejects the turn when app-server stdin emits EPIPE", async () => {
    const pipeError = Object.assign(new Error("broken pipe"), {
      code: "EPIPE",
    });
    const stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback(pipeError);
      },
    });
    const child = Object.assign(new EventEmitter(), {
      pid: 123_457,
      killed: false,
      exitCode: null,
      signalCode: null,
      stdin,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
    });
    mocks.spawn.mockReturnValue(child);
    const previousPath = process.env.STELLA_CODEX_CLI_PATH;
    process.env.STELLA_CODEX_CLI_PATH = process.execPath;

    try {
      const { runCodexAgentTurn } = await import(
        "@stella/runtime/kernel/integrations/codex-agent-runtime"
      );
      await expect(
        runCodexAgentTurn({
          runId: "run-broken-pipe",
          prompt: "hello",
        }),
      ).rejects.toThrow("Codex app-server write failed: broken pipe");
    } finally {
      if (previousPath === undefined) {
        delete process.env.STELLA_CODEX_CLI_PATH;
      } else {
        process.env.STELLA_CODEX_CLI_PATH = previousPath;
      }
    }
  });
});
