import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  handle: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: electronMocks.handle,
  },
}));

const { registerStoreHandlers } = await import(
  "@stella/desktop/electron/ipc/store-handlers.js"
);

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const register = (overrides: Record<string, unknown>) => {
  registerStoreHandlers({
    getStellaAppDir: () => null,
    getStellaDataDir: () => null,
    getStellaHostRunner: () => null,
    assertPrivilegedSender: () => true,
    assertStoreWebSender: () => true,
    ...overrides,
  } as never);
};

const invoke = (channel: string, payload?: unknown) => {
  const handler = electronMocks.handlers.get(channel);
  if (!handler) throw new Error(`Missing handler for ${channel}`);
  return handler({ sender: { id: 42 } }, payload);
};

beforeEach(() => {
  electronMocks.handlers.clear();
  electronMocks.handle.mockReset();
  electronMocks.handle.mockImplementation((channel, handler) => {
    electronMocks.handlers.set(channel, handler);
  });
});

describe("Store native integration request lifecycle", () => {
  it("runs native operations in main without the timeout-prone local renderer bridge", async () => {
    const integrations = [{ id: "googlesuper", enabled: false }];
    const connected = { id: "googlesuper", enabled: true };
    const listNativeIntegrations = vi.fn().mockResolvedValue(integrations);
    const connectNativeIntegration = vi.fn().mockResolvedValue(connected);
    const dispatchStoreWebLocalAction = vi.fn();
    register({
      listNativeIntegrations,
      connectNativeIntegration,
      dispatchStoreWebLocalAction,
    });

    await expect(invoke("storeWeb:listNativeIntegrations")).resolves.toEqual(
      integrations,
    );
    await expect(
      invoke("storeWeb:connectNativeIntegration", { id: "googlesuper" }),
    ).resolves.toEqual(connected);
    expect(connectNativeIntegration).toHaveBeenCalledWith({ id: "googlesuper" });
    expect(dispatchStoreWebLocalAction).not.toHaveBeenCalled();
  });

  it("queues concurrent mutations and releases the queue after cancellation", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const connectNativeIntegration = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    register({ connectNativeIntegration });

    const firstResult = Promise.resolve(
      invoke("storeWeb:connectNativeIntegration", { id: "googlesuper" }),
    );
    const secondResult = Promise.resolve(
      invoke("storeWeb:connectNativeIntegration", { id: "outlook" }),
    );
    await vi.waitFor(() => expect(connectNativeIntegration).toHaveBeenCalledTimes(1));

    first.reject(new Error("Could not connect Google Workspace: cancelled"));
    await expect(firstResult).rejects.toThrow(/cancelled/u);
    await vi.waitFor(() => expect(connectNativeIntegration).toHaveBeenCalledTimes(2));

    second.resolve({ id: "outlook", enabled: true });
    await expect(secondResult).resolves.toEqual({
      id: "outlook",
      enabled: true,
    });
    expect(connectNativeIntegration.mock.calls).toEqual([
      [{ id: "googlesuper" }],
      [{ id: "outlook" }],
    ]);
  });

  it("keeps the compatibility bridge alive longer than credential authorization", async () => {
    const dispatchStoreWebLocalAction = vi
      .fn()
      .mockResolvedValue({ id: "googlesuper", enabled: true });
    register({ dispatchStoreWebLocalAction });

    await invoke("storeWeb:connectNativeIntegration", { id: "googlesuper" });
    expect(dispatchStoreWebLocalAction).toHaveBeenCalledWith(
      {
        type: "connectNativeIntegration",
        payload: { id: "googlesuper" },
      },
      { timeoutMs: 6 * 60_000 },
    );
  });
});
