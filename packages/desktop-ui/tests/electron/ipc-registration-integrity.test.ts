import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_MEDIA_SAVE_OUTPUT } from "@stella/contracts/desktop/ipc-channels";

const ipc = vi.hoisted(() => ({
  handles: new Map<string, (...args: unknown[]) => unknown>(),
  on: vi.fn(),
}));

const imageValidation = vi.hoisted(() => ({
  decodeAndValidateImage: vi.fn(async () => ({
    mimeType: "image/png",
    width: 1,
    height: 1,
  })),
  decodeBase64ImageBounded: vi.fn((encoded: string) =>
    Buffer.from(encoded, "base64"),
  ),
  readResponseBodyBounded: vi.fn(async () => Buffer.from("png-bytes")),
  validateDecodedImageFile: vi.fn(async () => true),
}));

const mediaStore = vi.hoisted(() => ({
  materializeMediaArtifact: vi.fn(
    async (args: {
      filePath: string;
      validateExisting?: (filePath: string) => Promise<boolean>;
      producer: () => Promise<Buffer>;
    }) => {
      await args.validateExisting?.(`${args.filePath}.candidate`);
      const bytes = await args.producer();
      return { path: args.filePath, sizeBytes: bytes.length, created: true };
    },
  ),
}));

vi.mock("electron", () => {
  const base = {
    app: { quit: vi.fn() },
    BrowserWindow: { fromWebContents: vi.fn(), getAllWindows: vi.fn(() => []) },
    clipboard: {
      availableFormats: vi.fn(() => []),
      clear: vi.fn(),
      readBuffer: vi.fn(),
      readText: vi.fn(() => ""),
      writeBuffer: vi.fn(),
      writeImage: vi.fn(),
      writeText: vi.fn(),
    },
    contentTracing: {},
    dialog: {},
    globalShortcut: {
      isRegistered: vi.fn(() => false),
      register: vi.fn(() => true),
      unregister: vi.fn(),
    },
    ipcMain: {
      handle: vi.fn((...args: unknown[]) => {
        if (args.length !== 2 || typeof args[1] !== "function") {
          throw new TypeError(
            `Expected ipcMain.handle(channel, handler), received ${args.length} arguments with handler type ${typeof args[1]}`,
          );
        }
        ipc.handles.set(
          args[0] as string,
          args[1] as (...handlerArgs: unknown[]) => unknown,
        );
      }),
      on: ipc.on,
    },
    nativeImage: { createFromBuffer: vi.fn() },
    powerSaveBlocker: {},
    screen: {},
    session: {},
    shell: { openExternal: vi.fn() },
    systemPreferences: {},
  };
  return base;
});

vi.mock(
  "@stella/runtime/kernel/tools/image-decode-validation",
  () => imageValidation,
);
vi.mock("@stella/runtime/kernel/tools/media-artifact-store", () => mediaStore);
vi.mock("../../../desktop/electron/ipc/browser-fetch-session.js", () => ({
  getBrowserCookieHeader: vi.fn(async () => ""),
}));
vi.mock("../../../desktop/electron/ipc/renderer-safe-url.js", () => ({
  normalizeUrlForPrivilegedRendererFetch: vi.fn(async (url: string) => url),
  PRIVILEGED_RENDERER_FETCH_TIMEOUT_MS: 5_000,
}));

const { registerBrowserHandlers } = await import(
  "../../../desktop/electron/ipc/browser-handlers.js"
);
const { registerSystemHandlers } = await import(
  "../../../desktop/electron/ipc/system-handlers.js"
);

const tempRoots: string[] = [];

describe("Electron IPC registration integrity", () => {
  beforeEach(() => {
    ipc.handles.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("executes both media materialization paths with all validation helpers bound", async () => {
    const stellaDataDir = mkdtempSync(
      path.join(os.tmpdir(), "stella-ipc-integrity-"),
    );
    tempRoots.push(stellaDataDir);
    registerBrowserHandlers({
      getStellaAppDir: () => "/tmp/stella-app",
      getStellaDataDir: () => stellaDataDir,
      assertPrivilegedSender: () => true,
    });
    const saveOutput = ipc.handles.get(IPC_MEDIA_SAVE_OUTPUT);
    expect(saveOutput).toBeTypeOf("function");

    const inline = await saveOutput?.(
      {},
      {
        fileName: "inline.png",
        kind: "image",
        url: "data:image/png;base64,cG5nLWJ5dGVz",
      },
    );
    expect(inline).toMatchObject({ ok: true });
    expect(imageValidation.decodeBase64ImageBounded).toHaveBeenCalledOnce();
    expect(imageValidation.validateDecodedImageFile).toHaveBeenCalled();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "image/png" }),
      })),
    );
    const remote = await saveOutput?.(
      {},
      {
        fileName: "remote.png",
        kind: "image",
        url: "https://example.com/image.png",
      },
    );
    expect(remote).toMatchObject({ ok: true });
    expect(imageValidation.readResponseBodyBounded).toHaveBeenCalledOnce();
    expect(imageValidation.decodeAndValidateImage).toHaveBeenCalledTimes(2);
    expect(mediaStore.materializeMediaArtifact).toHaveBeenCalledTimes(2);
  });

  it("gates previously ungated device and permission reads", async () => {
    const assertPrivilegedSender = vi.fn(() => false);
    const options = new Proxy(
      {
        getStellaAppDir: () => null,
        getDeviceId: vi.fn(() => "device-1"),
        externalLinkService: { assertPrivilegedSender },
      },
      {
        get(target, property) {
          if (property in target) return Reflect.get(target, property);
          return vi.fn();
        },
      },
    );
    registerSystemHandlers(options);

    const getId = ipc.handles.get("device:getId");
    const getStatus = ipc.handles.get("permissions:getStatus");
    await expect(getId?.({})).rejects.toThrow("Blocked untrusted device:getId");
    expect(() => getStatus?.({})).toThrow(
      "Blocked untrusted permissions:getStatus",
    );
    expect(options.getDeviceId).not.toHaveBeenCalled();
  });

  it("keeps device signing in the privileged Electron main process", async () => {
    const sign = vi.fn(async () => "device-signature");
    const loadDeviceSigner = vi.fn(async () => ({
      alg: "ed25519" as const,
      rawPublicKey: Uint8Array.from({ length: 32 }, (_, index) => index),
      sign,
    }));
    const assertPrivilegedSender = vi.fn(() => true);
    const options = new Proxy(
      {
        getStellaAppDir: () => null,
        externalLinkService: { assertPrivilegedSender },
        loadDeviceSigner,
      },
      {
        get(target, property) {
          if (property in target) return Reflect.get(target, property);
          return vi.fn();
        },
      },
    );
    registerSystemHandlers(options);

    const signDevice = ipc.handles.get("auth:signDevice");
    const canonicalInput =
      "stella-dpop\nPOST\n/api/gateway\ntoken-id\nrequest-id\n1700000000000";
    await expect(signDevice?.({}, canonicalInput)).resolves.toEqual({
      alg: "ed25519",
      rawPublicKey: Array.from({ length: 32 }, (_, index) => index),
      signature: "device-signature",
    });
    expect(assertPrivilegedSender).toHaveBeenCalledWith({}, "auth:signDevice");
    expect(loadDeviceSigner).toHaveBeenCalledOnce();
    expect(sign).toHaveBeenCalledWith(canonicalInput);

    await expect(signDevice?.({}, "canonical-input")).rejects.toThrow(
      "outside the DPoP contract",
    );
    expect(loadDeviceSigner).toHaveBeenCalledOnce();
    expect(sign).toHaveBeenCalledOnce();

    assertPrivilegedSender.mockReturnValue(false);
    await expect(signDevice?.({}, canonicalInput)).rejects.toThrow(
      "Blocked untrusted device-signing request",
    );
    expect(sign).toHaveBeenCalledOnce();
  });
});
