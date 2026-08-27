import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IPC_CLOUD_HOME_BEGIN_MEMORY_EXPORT,
  IPC_CLOUD_HOME_CANCEL_MEMORY_EXPORT,
  IPC_CLOUD_HOME_COMMIT_MEMORY_EXPORT,
} from "@stella/contracts/desktop/ipc-channels";

const electron = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  fromWebContents: vi.fn(),
  handles: new Map<string, (...args: unknown[]) => unknown>(),
  invoke: vi.fn(),
  sendSync: vi.fn(() => ({})),
  showSaveDialog: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: electron.fromWebContents,
  },
  dialog: {
    showSaveDialog: electron.showSaveDialog,
  },
  contextBridge: {
    exposeInMainWorld: vi.fn((name: string, value: unknown) => {
      electron.exposed.set(name, value);
    }),
  },
  ipcMain: {
    handle: vi.fn(
      (channel: string, handler: (...args: unknown[]) => unknown): void => {
        electron.handles.set(channel, handler);
      },
    ),
  },
  ipcRenderer: {
    invoke: electron.invoke,
    on: vi.fn(),
    removeListener: vi.fn(),
    send: vi.fn(),
    sendSync: electron.sendSync,
  },
  webUtils: {
    getPathForFile: vi.fn(() => ""),
  },
}));

const { createCloudHomeMemoryExportService } =
  await import("@stella/desktop/electron/services/cloud-home-memory-export.js");
const { registerCloudHomeSyncHandlers } =
  await import("@stella/desktop/electron/ipc/cloud-home-sync-handlers.js");
const { isMobileBridgeRequestChannel } =
  await import("@stella/desktop/electron/services/mobile-bridge/bridge-policy.js");
await import("@stella/desktop/electron/preload.js");

const fixtures: string[] = [];

const makeFixture = async (): Promise<string> => {
  const fixture = await fs.mkdtemp(
    path.join(os.tmpdir(), "stella-cloud-memory-export-"),
  );
  fixtures.push(fixture);
  return fixture;
};

const authority = {
  expectedSubject: "https://site.example|owner+tag@example.com=tenant",
  ownerGeneration: "generation-1",
  memoryEpoch: "memory-epoch-1",
  lifecycleState: "open" as const,
};

const beginPayload = {
  suggestedName: "memory.md",
  ...authority,
};

const sender = (id: number) => ({
  id,
  once: vi.fn(),
  isDestroyed: vi.fn(() => false),
});

beforeEach(() => {
  electron.handles.clear();
  vi.clearAllMocks();
  electron.fromWebContents.mockReturnValue(null);
  electron.showSaveDialog.mockResolvedValue({ canceled: true });
});

afterEach(async () => {
  await Promise.all(
    fixtures
      .splice(0)
      .map((fixture) => fs.rm(fixture, { recursive: true, force: true })),
  );
});

describe("Cloud Home memory export", () => {
  it("keeps the native destination opaque until an exact-authority commit", async () => {
    const fixture = await makeFixture();
    const destination = path.join(fixture, "saved-profile.md");
    const service = createCloudHomeMemoryExportService({
      createId: () => "opaque-export-1",
    });

    const selection = await service.begin({
      senderId: 7,
      payload: beginPayload,
      showSaveDialog: async (options) => {
        expect(options).toEqual({
          defaultPath: "memory.md",
          filters: [{ name: "Markdown", extensions: ["md"] }],
          properties: ["createDirectory", "showOverwriteConfirmation"],
        });
        return { canceled: false, filePath: destination };
      },
    });

    expect(selection).toEqual({ ok: true, exportId: "opaque-export-1" });
    expect(selection).not.toHaveProperty("path");
    await expect(fs.stat(destination)).rejects.toMatchObject({
      code: "ENOENT",
    });

    await expect(
      service.commit({
        senderId: 7,
        payload: {
          exportId: "opaque-export-1",
          content: "# Memory\n",
          ...authority,
        },
      }),
    ).resolves.toEqual({ ok: true });
    expect(await fs.readFile(destination, "utf8")).toBe("# Memory\n");
  });

  it("cancels without writing and never returns a selected path", async () => {
    const fixture = await makeFixture();
    const destination = path.join(fixture, "must-not-exist.md");
    const service = createCloudHomeMemoryExportService();

    await expect(
      service.begin({
        senderId: 1,
        payload: beginPayload,
        showSaveDialog: async () => ({
          canceled: true,
          filePath: destination,
        }),
      }),
    ).resolves.toEqual({ ok: false, canceled: true });
    await expect(fs.stat(destination)).rejects.toMatchObject({
      code: "ENOENT",
    });

    await expect(
      service.begin({
        senderId: 1,
        payload: beginPayload,
        showSaveDialog: async () => ({ canceled: false }),
      }),
    ).resolves.toEqual({ ok: false, canceled: true });
  });

  it.each([
    ["subject", { expectedSubject: "https://site.example|owner-b" }],
    ["generation", { ownerGeneration: "generation-2" }],
    ["epoch", { memoryEpoch: "memory-epoch-2" }],
  ])(
    "consumes the operation without writing on a mismatched %s",
    async (_label, mismatch) => {
      const write = vi.fn();
      const service = createCloudHomeMemoryExportService({
        createId: () => `opaque-${String(_label)}`,
        write,
      });
      const selection = await service.begin({
        senderId: 3,
        payload: beginPayload,
        showSaveDialog: async () => ({
          canceled: false,
          filePath: "/native-only/memory.md",
        }),
      });
      expect(selection.ok).toBe(true);
      const exportId = selection.ok ? selection.exportId : "unreachable";

      await expect(
        service.commit({
          senderId: 3,
          payload: {
            exportId,
            content: "# Memory\n",
            ...authority,
            ...mismatch,
          },
        }),
      ).resolves.toEqual({ ok: false, canceled: true });
      await expect(
        service.commit({
          senderId: 3,
          payload: { exportId, content: "# Memory\n", ...authority },
        }),
      ).resolves.toEqual({ ok: false, canceled: true });
      expect(write).not.toHaveBeenCalled();
    },
  );

  it("binds operations to the initiating renderer and makes them single-use", async () => {
    const write = vi.fn(async () => undefined);
    const service = createCloudHomeMemoryExportService({
      createId: () => "sender-bound-export",
      write: write as unknown as typeof fs.writeFile,
    });
    const selection = await service.begin({
      senderId: 4,
      payload: beginPayload,
      showSaveDialog: async () => ({
        canceled: false,
        filePath: "/native-only/memory.md",
      }),
    });
    const exportId = selection.ok ? selection.exportId : "unreachable";

    await expect(
      service.commit({
        senderId: 5,
        payload: { exportId, content: "# Memory\n", ...authority },
      }),
    ).resolves.toEqual({ ok: false, canceled: true });
    await expect(
      service.commit({
        senderId: 4,
        payload: { exportId, content: "# Memory\n", ...authority },
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      service.commit({
        senderId: 4,
        payload: { exportId, content: "# Memory\n", ...authority },
      }),
    ).resolves.toEqual({ ok: false, canceled: true });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("expires and explicitly cancels pending operations without writing", async () => {
    let now = 10;
    let sequence = 0;
    const write = vi.fn();
    const service = createCloudHomeMemoryExportService({
      now: () => now,
      ttlMs: 100,
      createId: () => `expiry-${++sequence}`,
      write,
    });
    const select = async () => ({
      canceled: false,
      filePath: "/native-only/memory.md",
    });
    const first = await service.begin({
      senderId: 1,
      payload: beginPayload,
      showSaveDialog: select,
    });
    const firstId = first.ok ? first.exportId : "unreachable";
    now = 111;
    await expect(
      service.commit({
        senderId: 1,
        payload: { exportId: firstId, content: "# Memory\n", ...authority },
      }),
    ).resolves.toEqual({ ok: false, canceled: true });

    const second = await service.begin({
      senderId: 1,
      payload: beginPayload,
      showSaveDialog: select,
    });
    const secondId = second.ok ? second.exportId : "unreachable";
    expect(
      service.cancel({ senderId: 1, payload: { exportId: secondId } }),
    ).toEqual({
      ok: true,
    });
    await expect(
      service.commit({
        senderId: 1,
        payload: { exportId: secondId, content: "# Memory\n", ...authority },
      }),
    ).resolves.toEqual({ ok: false, canceled: true });
    expect(write).not.toHaveBeenCalled();
  });

  it("rejects renderer paths, extra fields, and unsafe basenames before opening the picker", async () => {
    const service = createCloudHomeMemoryExportService();
    const showSaveDialog = vi.fn(async () => ({ canceled: true }));
    const invalidPayloads: unknown[] = [
      { ...beginPayload, sourcePath: "/tmp/source.md" },
      { ...beginPayload, destinationPath: "/tmp/destination.md" },
      { ...beginPayload, r2Key: "owners/private/memory.md" },
      { ...beginPayload, suggestedName: "../memory.md" },
      { ...beginPayload, suggestedName: "/tmp/memory.md" },
      { ...beginPayload, suggestedName: "memory.txt" },
      { ...beginPayload, suggestedName: ".md" },
      { ...beginPayload, suggestedName: " memory.md" },
      { ...beginPayload, lifecycleState: "wiping" },
    ];

    for (const payload of invalidPayloads) {
      await expect(
        service.begin({ senderId: 1, payload, showSaveDialog }),
      ).rejects.toThrow();
    }
    expect(showSaveDialog).not.toHaveBeenCalled();
  });

  it("enforces the 512 KiB UTF-8 limit only at the post-authority commit", async () => {
    let sequence = 0;
    const write = vi.fn(async () => undefined);
    const service = createCloudHomeMemoryExportService({
      createId: () => `limit-${++sequence}`,
      write: write as unknown as typeof fs.writeFile,
    });
    const select = async () => ({
      canceled: false,
      filePath: "/native-only/memory.md",
    });
    const exact = await service.begin({
      senderId: 1,
      payload: beginPayload,
      showSaveDialog: select,
    });
    await expect(
      service.commit({
        senderId: 1,
        payload: {
          exportId: exact.ok ? exact.exportId : "unreachable",
          content: "é".repeat(256 * 1024),
          ...authority,
        },
      }),
    ).resolves.toEqual({ ok: true });

    for (const content of ["", `${"é".repeat(256 * 1024)}é`]) {
      const operation = await service.begin({
        senderId: 1,
        payload: beginPayload,
        showSaveDialog: select,
      });
      await expect(
        service.commit({
          senderId: 1,
          payload: {
            exportId: operation.ok ? operation.exportId : "unreachable",
            content,
            ...authority,
          },
        }),
      ).rejects.toThrow("outside its size limit");
      service.cancel({
        senderId: 1,
        payload: {
          exportId: operation.ok ? operation.exportId : "unreachable",
        },
      });
    }
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("exposes the three typed phases through preload without a path-bearing result", async () => {
    const api = electron.exposed.get("electronAPI") as {
      cloudHome: {
        beginMemoryExport: (payload: unknown) => Promise<unknown>;
        commitMemoryExport: (payload: unknown) => Promise<unknown>;
        cancelMemoryExport: (exportId: string) => Promise<unknown>;
      };
    };
    electron.invoke
      .mockResolvedValueOnce({ ok: true, exportId: "opaque" })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true });
    const begin = { suggestedName: "memory.md", ...authority };
    const commit = { exportId: "opaque", content: "# Memory\n", ...authority };

    await expect(api.cloudHome.beginMemoryExport(begin)).resolves.toEqual({
      ok: true,
      exportId: "opaque",
    });
    await expect(api.cloudHome.commitMemoryExport(commit)).resolves.toEqual({
      ok: true,
    });
    await expect(api.cloudHome.cancelMemoryExport("opaque")).resolves.toEqual({
      ok: true,
    });
    expect(electron.invoke.mock.calls.slice(-3)).toEqual([
      [IPC_CLOUD_HOME_BEGIN_MEMORY_EXPORT, begin],
      [IPC_CLOUD_HOME_COMMIT_MEMORY_EXPORT, commit],
      [IPC_CLOUD_HOME_CANCEL_MEMORY_EXPORT, { exportId: "opaque" }],
    ]);
  });

  it("does not grant any native export phase to the mobile bridge", () => {
    expect(
      isMobileBridgeRequestChannel(IPC_CLOUD_HOME_BEGIN_MEMORY_EXPORT),
    ).toBe(false);
    expect(
      isMobileBridgeRequestChannel(IPC_CLOUD_HOME_COMMIT_MEMORY_EXPORT),
    ).toBe(false);
    expect(
      isMobileBridgeRequestChannel(IPC_CLOUD_HOME_CANCEL_MEMORY_EXPORT),
    ).toBe(false);
  });

  it("registers privileged handlers and parents only the native picker", async () => {
    const fixture = await makeFixture();
    const destination = path.join(fixture, "handler-memory.md");
    const owner = { id: "owner-window" };
    const webContents = sender(44);
    const event = { sender: webContents };
    const assertPrivilegedSender = vi.fn(() => true);
    electron.fromWebContents.mockReturnValue(owner);
    electron.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: destination,
    });
    registerCloudHomeSyncHandlers({
      getStellaDataDir: () => null,
      assertPrivilegedSender,
    });

    const begin = electron.handles.get(IPC_CLOUD_HOME_BEGIN_MEMORY_EXPORT);
    const commit = electron.handles.get(IPC_CLOUD_HOME_COMMIT_MEMORY_EXPORT);
    const cancel = electron.handles.get(IPC_CLOUD_HOME_CANCEL_MEMORY_EXPORT);
    expect(begin).toBeTypeOf("function");
    expect(commit).toBeTypeOf("function");
    expect(cancel).toBeTypeOf("function");
    const selected = (await begin?.(event, beginPayload)) as {
      ok: true;
      exportId: string;
    };
    expect(selected).toMatchObject({ ok: true });
    expect(selected).not.toHaveProperty("path");
    expect(electron.showSaveDialog).toHaveBeenCalledWith(
      owner,
      expect.objectContaining({ defaultPath: "memory.md" }),
    );
    await expect(
      commit?.(event, {
        exportId: selected.exportId,
        content: "# Memory\n",
        ...authority,
      }),
    ).resolves.toEqual({ ok: true });
    expect(await fs.readFile(destination, "utf8")).toBe("# Memory\n");
    expect(assertPrivilegedSender).toHaveBeenCalledWith(
      event,
      IPC_CLOUD_HOME_BEGIN_MEMORY_EXPORT,
    );
    expect(assertPrivilegedSender).toHaveBeenCalledWith(
      event,
      IPC_CLOUD_HOME_COMMIT_MEMORY_EXPORT,
    );
    expect(webContents.once).toHaveBeenCalledWith(
      "destroyed",
      expect.any(Function),
    );
  });

  it("rejects an untrusted sender before opening the native dialog", async () => {
    registerCloudHomeSyncHandlers({
      getStellaDataDir: () => null,
      assertPrivilegedSender: () => false,
    });
    const begin = electron.handles.get(IPC_CLOUD_HOME_BEGIN_MEMORY_EXPORT);

    await expect(begin?.({ sender: sender(1) }, beginPayload)).rejects.toThrow(
      `Blocked untrusted ${IPC_CLOUD_HOME_BEGIN_MEMORY_EXPORT}`,
    );
    expect(electron.fromWebContents).not.toHaveBeenCalled();
    expect(electron.showSaveDialog).not.toHaveBeenCalled();
  });

  it("does not mint an operation when the renderer dies inside the native picker", async () => {
    let resolveDialog!: (value: {
      canceled: boolean;
      filePath: string;
    }) => void;
    electron.showSaveDialog.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveDialog = resolve;
      }),
    );
    registerCloudHomeSyncHandlers({
      getStellaDataDir: () => null,
      assertPrivilegedSender: () => true,
    });
    const begin = electron.handles.get(IPC_CLOUD_HOME_BEGIN_MEMORY_EXPORT);
    const webContents = sender(55);
    const result = begin?.({ sender: webContents }, beginPayload);
    await Promise.resolve();
    webContents.isDestroyed.mockReturnValue(true);
    const destroyed = webContents.once.mock.calls.find(
      ([event]) => event === "destroyed",
    )?.[1] as (() => void) | undefined;
    destroyed?.();
    resolveDialog({
      canceled: false,
      filePath: "/native-only/dead-renderer.md",
    });

    await expect(result).resolves.toEqual({ ok: false, canceled: true });
  });

  it("uses the native unparented fallback when no BrowserWindow owns the sender", async () => {
    electron.fromWebContents.mockReturnValue(null);
    electron.showSaveDialog.mockResolvedValue({ canceled: true });
    registerCloudHomeSyncHandlers({
      getStellaDataDir: () => null,
      assertPrivilegedSender: () => true,
    });
    const begin = electron.handles.get(IPC_CLOUD_HOME_BEGIN_MEMORY_EXPORT);

    await expect(begin?.({ sender: sender(2) }, beginPayload)).resolves.toEqual(
      {
        ok: false,
        canceled: true,
      },
    );
    expect(electron.showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "memory.md" }),
    );
  });
});
