import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));

import {
  closeConnectorBridgeSessions,
  listConnectorBridgeTools,
} from "@stella/runtime/kernel/connectors/connector-bridge";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await closeConnectorBridgeSessions(root, ["broken-pipe"]);
      rmSync(root, { recursive: true, force: true });
    }),
  );
  vi.clearAllMocks();
});

describe("stdio connector bridge pipe handling", () => {
  it("registers pending requests before a synchronous connector response", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "stella-connector-fast-"));
    roots.push(root);
    const stdout = new PassThrough();
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        const message = JSON.parse(String(chunk)) as {
          id?: string;
          method?: string;
        };
        if (message.id) {
          stdout.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: message.method === "tools/list" ? { tools: [] } : {},
            })}\n`,
          );
        }
        callback();
      },
    });
    const child = Object.assign(new EventEmitter(), {
      pid: 2_147_483_647,
      stdin,
      stdout,
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
    });
    mocks.spawn.mockReturnValue(child);

    await expect(
      listConnectorBridgeTools(root, {
        id: "broken-pipe",
        displayName: "Fast Connector",
        transport: "stdio",
        command: "fake-connector",
      }),
    ).resolves.toEqual([]);
  });

  it("rejects an MCP request when connector stdin emits EPIPE", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "stella-connector-pipe-"));
    roots.push(root);
    const pipeError = Object.assign(new Error("broken pipe"), {
      code: "EPIPE",
    });
    const stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback(pipeError);
      },
    });
    const child = Object.assign(new EventEmitter(), {
      pid: 123_456,
      stdin,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
    });
    mocks.spawn.mockReturnValue(child);

    await expect(
      listConnectorBridgeTools(root, {
        id: "broken-pipe",
        displayName: "Broken Pipe",
        transport: "stdio",
        command: "fake-connector",
      }),
    ).rejects.toMatchObject({ code: "EPIPE" });
    expect(child.kill).toHaveBeenCalledOnce();
  });
});
