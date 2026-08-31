import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..", "..");
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

  it("registers every system IPC channel with exactly one function handler", () => {
    const options = new Proxy(
      {
        getStellaAppDir: () => null,
        externalLinkService: { assertPrivilegedSender: vi.fn(() => true) },
      },
      {
        get(target, property) {
          if (property in target) return Reflect.get(target, property);
          return vi.fn();
        },
      },
    );

    expect(() => registerSystemHandlers(options)).not.toThrow();
    expect(ipc.handles.get("customizations:reset")).toBeTypeOf("function");
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

  it("registers and invokes privileged connector credential handlers", async () => {
    const submitConnectorCredential = vi.fn(async () => ({ ok: true }));
    const cancelConnectorCredential = vi.fn(() => ({ ok: true }));
    const assertPrivilegedSender = vi.fn(() => true);
    const options = new Proxy(
      {
        getStellaAppDir: () => null,
        externalLinkService: { assertPrivilegedSender },
        submitConnectorCredential,
        cancelConnectorCredential,
      },
      {
        get(target, property) {
          if (property in target) return Reflect.get(target, property);
          return vi.fn();
        },
      },
    );
    registerSystemHandlers(options);

    const submit = ipc.handles.get("connector-credential:submit");
    const cancel = ipc.handles.get("connector-credential:cancel");
    const submitPayload = {
      requestId: "request-1",
      value: "secret",
      label: "Work",
    };
    const cancelPayload = { requestId: "request-1" };

    await expect(submit?.({}, submitPayload)).resolves.toEqual({ ok: true });
    expect(cancel?.({}, cancelPayload)).toEqual({ ok: true });
    expect(submitConnectorCredential).toHaveBeenCalledWith(submitPayload);
    expect(cancelConnectorCredential).toHaveBeenCalledWith(cancelPayload);
    expect(assertPrivilegedSender).toHaveBeenCalledWith(
      {},
      "connector-credential:submit",
    );
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

  it("loads the device ID on demand and reuses the cached value", async () => {
    let deviceId: string | null = null;
    const loadDeviceId = vi.fn(async () => {
      deviceId = "device-loaded";
      return deviceId;
    });
    const options = new Proxy(
      {
        getStellaAppDir: () => null,
        getDeviceId: vi.fn(() => deviceId),
        loadDeviceId,
        externalLinkService: { assertPrivilegedSender: vi.fn(() => true) },
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
    await expect(getId?.({})).resolves.toBe("device-loaded");
    await expect(getId?.({})).resolves.toBe("device-loaded");

    expect(loadDeviceId).toHaveBeenCalledOnce();
  });

  it("wires the connector credential service into system registration", () => {
    const bootstrap = readFileSync(
      path.join(repoRoot, "packages/desktop/electron/bootstrap/ipc.js"),
      "utf8",
    );
    expect(bootstrap).toContain(
      "services.connectorCredentialService.submitCredential(payload)",
    );
    expect(bootstrap).toContain(
      "services.connectorCredentialService.cancelCredential(payload)",
    );
  });

  it("forwards managed browser recovery through the Electron bootstrap", () => {
    const bootstrap = readFileSync(
      path.join(repoRoot, "packages/desktop/electron/bootstrap/ipc.js"),
      "utf8",
    );
    const routingStart = bootstrap.indexOf(
      "const ensureInAppBrowserAgentRouting",
    );
    const routingEnd = bootstrap.indexOf(
      "const ensureInAppBrowserReady",
      routingStart,
    );
    expect(routingStart).toBeGreaterThan(-1);
    expect(routingEnd).toBeGreaterThan(routingStart);
    expect(bootstrap.slice(routingStart, routingEnd)).toContain(
      "...(capability.recover ? { recover: true } : {})",
    );
  });

  it("constructs the connector credential service and threads it into the connect-card flow", () => {
    // Regression: the local-first port dropped the ConnectorCredentialService
    // instantiation from bootstrap-services.js while ipc.js, host-runner.js,
    // resets.js, and ConnectorConnectService.runConnectFlow all kept consuming
    // `services.connectorCredentialService`. Clicking Connect on an inline
    // connect card then failed with "Cannot read properties of undefined
    // (reading 'requestExternalOAuthApproval')".
    const services = readFileSync(
      path.join(
        repoRoot,
        "packages/desktop/electron/bootstrap/bootstrap-services.js",
      ),
      "utf8",
    );
    expect(services).toContain("new ConnectorCredentialService({");
    const connectOptionsStart = services.indexOf(
      "new ConnectorConnectService({",
    );
    expect(connectOptionsStart).toBeGreaterThan(-1);
    const connectOptions = services.slice(
      connectOptionsStart,
      services.indexOf("});", connectOptionsStart),
    );
    expect(connectOptions).toContain("connectorCredentialService");
    // The external OAuth flow completes via the `stella://oauth/callback/...`
    // deep link, which must be routed to the credential service before the
    // generic auth handler swallows it.
    expect(services).toContain(
      "connectorCredentialService?.handleExternalOAuthCallback(url)",
    );
    // The services object must expose it for ipc.js / host-runner.js /
    // resets.js consumers.
    expect(services).toMatch(/return \{[\s\S]*connectorCredentialService,/);
  });
});
