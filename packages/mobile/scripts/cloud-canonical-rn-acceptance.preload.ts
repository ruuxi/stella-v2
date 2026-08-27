/// <reference types="bun-types" />

import { mock } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
// The root workspace owns this test-only dependency. The production mobile
// bundle does not ship jsdom.
// @ts-expect-error jsdom intentionally has no installed declaration package.
import { JSDOM } from "jsdom";

const required = (key: string): string => {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`${key} is required.`);
  return value;
};

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const harnessRoot = realpathSync(
  required("STELLA_MOBILE_ACCEPTANCE_HARNESS_ROOT"),
);
const storageDirectory = path.resolve(
  required("STELLA_MOBILE_RN_ACCEPTANCE_STORAGE_DIRECTORY"),
);
const relativeStorage = path.relative(harnessRoot, storageDirectory);
if (
  relativeStorage === "" ||
  relativeStorage.startsWith("..") ||
  path.isAbsolute(relativeStorage)
) {
  throw new Error(
    "RN acceptance storage must be inside the isolated harness root.",
  );
}
mkdirSync(storageDirectory, { recursive: true, mode: 0o700 });
if (!realpathSync(storageDirectory).startsWith(`${harnessRoot}${path.sep}`)) {
  throw new Error("RN acceptance storage escaped the isolated harness root.");
}

type StorageObservation = Readonly<{
  ordinal: number;
  operation: "set" | "remove" | "clear";
  keySha256: string;
  valueSha256?: string;
}>;

const observations = {
  ordinal: 0,
  storage: [] as StorageObservation[],
  asyncStorageCompletions: [] as Array<{
    ordinal: number;
    operation: "set" | "remove" | "clear";
    keySha256: string;
    valueSha256?: string;
  }>,
  fetches: [] as Array<{
    ordinal: number;
    phase:
      | "start"
      | "server-response"
      | "response-withheld"
      | "response-released"
      | "status-terminal";
    operation: string;
    status?: number;
    requestIdSha256?: string;
    resourceIdSha256?: string;
    responseSha256?: string;
  }>,
  socketUrls: [] as string[],
  socketSends: [] as Array<{
    ordinal: number;
    payloadSha256: string;
    ping: boolean;
  }>,
  appStateChanges: [] as Array<{
    ordinal: number;
    state: "active" | "background";
  }>,
};

const nextOrdinal = () => {
  observations.ordinal += 1;
  return observations.ordinal;
};

/**
 * A generic synchronous Web Storage implementation. Each key is an opaque,
 * atomically replaced binary record; it knows nothing about Stella's outbox
 * format. AsyncStorage's real web implementation remains the only product
 * layer that reads and writes the outbox.
 */
class DurableWebStorage implements Storage {
  private readonly values = new Map<string, string>();

  constructor(private readonly directory: string) {
    for (const name of readdirSync(directory)) {
      if (!/^[a-f0-9]{64}\.bin$/u.test(name)) continue;
      const bytes = readFileSync(path.join(directory, name));
      if (bytes.byteLength < 4) continue;
      const keyBytes = bytes.readUInt32BE(0);
      if (keyBytes > bytes.byteLength - 4) continue;
      const key = bytes.subarray(4, 4 + keyBytes).toString("utf8");
      const value = bytes.subarray(4 + keyBytes).toString("utf8");
      if (`${sha256(key)}.bin` === name) this.values.set(key, value);
    }
  }

  get length(): number {
    return this.values.size;
  }

  key(index: number): string | null {
    return [...this.values.keys()].sort()[index] ?? null;
  }

  getItem(key: string): string | null {
    return this.values.get(String(key)) ?? null;
  }

  setItem(key: string, value: string): void {
    const normalizedKey = String(key);
    const normalizedValue = String(value);
    const keyBuffer = Buffer.from(normalizedKey, "utf8");
    const valueBuffer = Buffer.from(normalizedValue, "utf8");
    const bytes = Buffer.allocUnsafe(4 + keyBuffer.length + valueBuffer.length);
    bytes.writeUInt32BE(keyBuffer.length, 0);
    keyBuffer.copy(bytes, 4);
    valueBuffer.copy(bytes, 4 + keyBuffer.length);
    const destination = path.join(
      this.directory,
      `${sha256(normalizedKey)}.bin`,
    );
    const temporary = `${destination}.${process.pid}.tmp`;
    writeFileSync(temporary, bytes, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, destination);
    this.values.set(normalizedKey, normalizedValue);
    observations.storage.push({
      ordinal: nextOrdinal(),
      operation: "set",
      keySha256: sha256(normalizedKey),
      valueSha256: sha256(normalizedValue),
    });
  }

  removeItem(key: string): void {
    const normalizedKey = String(key);
    const destination = path.join(
      this.directory,
      `${sha256(normalizedKey)}.bin`,
    );
    if (existsSync(destination)) unlinkSync(destination);
    this.values.delete(normalizedKey);
    observations.storage.push({
      ordinal: nextOrdinal(),
      operation: "remove",
      keySha256: sha256(normalizedKey),
    });
  }

  clear(): void {
    for (const key of [...this.values.keys()]) {
      const destination = path.join(this.directory, `${sha256(key)}.bin`);
      if (existsSync(destination)) unlinkSync(destination);
    }
    this.values.clear();
    observations.storage.push({
      ordinal: nextOrdinal(),
      operation: "clear",
      keySha256: sha256("*"),
    });
  }

  stateSha256(): string {
    return sha256(
      JSON.stringify(
        [...this.values.entries()].sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    );
  }
}

const storage = new DurableWebStorage(storageDirectory);
const dom = new JSDOM(
  '<!doctype html><html><body><div id="root"></div></body></html>',
  { url: "https://stella-mobile-acceptance.invalid/", pretendToBeVisual: true },
);
Object.defineProperty(dom.window, "localStorage", {
  configurable: true,
  value: storage,
});

let visibilityState: "visible" | "hidden" = "visible";
Object.defineProperty(dom.window.document, "visibilityState", {
  configurable: true,
  get: () => visibilityState,
});
Object.defineProperty(dom.window.document, "hidden", {
  configurable: true,
  get: () => visibilityState === "hidden",
});

Object.assign(globalThis, {
  __DEV__: false,
  IS_REACT_ACT_ENVIRONMENT: true,
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  localStorage: storage,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  ShadowRoot: dom.window.ShadowRoot,
  MutationObserver: dom.window.MutationObserver,
  Event: dom.window.Event,
  MessageEvent: dom.window.MessageEvent,
  MouseEvent: dom.window.MouseEvent,
  InputEvent: dom.window.InputEvent,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
});

let activeJwt = required("STELLA_MOBILE_RN_ACCEPTANCE_JWT");
let activeSubject = required("STELLA_MOBILE_RN_ACCEPTANCE_SESSION_SUBJECT");
let activeSessionId = required("STELLA_MOBILE_RN_ACCEPTANCE_SESSION_ID");
let withholdNextAdmissionResponse = false;
let holdNextAdmissionResponse = false;
let releaseHeldAdmission: (() => void) | null = null;

const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === "string" || input instanceof URL
      ? String(input)
      : input.url;
  const parsedUrl = new URL(url);
  const isSubmit = parsedUrl.pathname === "/api/mobile/execution/submit";
  const isStatus = parsedUrl.pathname === "/api/mobile/execution/status";
  let requestIdSha256: string | undefined;
  if (isSubmit && typeof init?.body === "string") {
    try {
      const body = JSON.parse(init.body) as { idempotencyKey?: unknown };
      if (typeof body.idempotencyKey === "string") {
        requestIdSha256 = sha256(body.idempotencyKey);
      }
    } catch {
      // The real product parser owns malformed-body behavior.
    }
  }
  if (isSubmit) {
    observations.fetches.push({
      ordinal: nextOrdinal(),
      phase: "start",
      operation: "mobile.execution.submit",
      ...(requestIdSha256 ? { requestIdSha256 } : {}),
    });
  }
  const response = await realFetch(input, init);
  if (isStatus) {
    const text = await response.clone().text();
    try {
      const value = JSON.parse(text) as { state?: unknown };
      if (
        typeof value.state === "string" &&
        ["completed", "failed", "canceled"].includes(value.state)
      ) {
        const dispatchId = parsedUrl.searchParams.get("dispatchId")?.trim();
        observations.fetches.push({
          ordinal: nextOrdinal(),
          phase: "status-terminal",
          operation: "mobile.execution.status",
          status: response.status,
          ...(dispatchId ? { resourceIdSha256: sha256(dispatchId) } : {}),
          responseSha256: sha256(text),
        });
      }
    } catch {
      // The real product response decoder owns malformed status behavior.
    }
    return response;
  }
  if (!isSubmit) return response;
  const text = await response.clone().text();
  let resourceIdSha256: string | undefined;
  try {
    const value = JSON.parse(text) as { dispatchId?: unknown };
    if (typeof value.dispatchId === "string") {
      resourceIdSha256 = sha256(value.dispatchId);
    }
  } catch {
    // The real product response decoder will reject this response.
  }
  observations.fetches.push({
    ordinal: nextOrdinal(),
    phase: "server-response",
    operation: "mobile.execution.submit",
    status: response.status,
    ...(requestIdSha256 ? { requestIdSha256 } : {}),
    ...(resourceIdSha256 ? { resourceIdSha256 } : {}),
    responseSha256: sha256(text),
  });
  if (withholdNextAdmissionResponse && response.ok) {
    withholdNextAdmissionResponse = false;
    observations.fetches.push({
      ordinal: nextOrdinal(),
      phase: "response-withheld",
      operation: "mobile.execution.submit",
      status: response.status,
      ...(requestIdSha256 ? { requestIdSha256 } : {}),
      ...(resourceIdSha256 ? { resourceIdSha256 } : {}),
      responseSha256: sha256(text),
    });
    throw new TypeError("Acceptance response withheld after server commit.");
  }
  if (holdNextAdmissionResponse && response.ok) {
    holdNextAdmissionResponse = false;
    await new Promise<void>((resolve) => {
      releaseHeldAdmission = resolve;
    });
    releaseHeldAdmission = null;
    observations.fetches.push({
      ordinal: nextOrdinal(),
      phase: "response-released",
      operation: "mobile.execution.submit",
      status: response.status,
      ...(requestIdSha256 ? { requestIdSha256 } : {}),
      ...(resourceIdSha256 ? { resourceIdSha256 } : {}),
      responseSha256: sha256(text),
    });
  }
  return response;
}) as typeof fetch;

const RealWebSocket = globalThis.WebSocket;
if (typeof RealWebSocket !== "function") {
  throw new Error("Bun WebSocket support is required.");
}

class DelegatingWebSocket {
  static readonly CONNECTING = RealWebSocket.CONNECTING;
  static readonly OPEN = RealWebSocket.OPEN;
  static readonly CLOSING = RealWebSocket.CLOSING;
  static readonly CLOSED = RealWebSocket.CLOSED;
  readonly inner: WebSocket;
  readonly url: string;

  constructor(url: string | URL, protocols?: string | string[]) {
    this.url = String(url);
    observations.socketUrls.push(this.url);
    this.inner = new RealWebSocket(url, protocols);
    sockets.push(this);
  }

  get readyState(): number {
    return this.inner.readyState;
  }

  get protocol(): string {
    return this.inner.protocol;
  }

  get onopen(): WebSocket["onopen"] {
    return this.inner.onopen;
  }
  set onopen(value: WebSocket["onopen"]) {
    this.inner.onopen = value;
  }
  get onmessage(): WebSocket["onmessage"] {
    return this.inner.onmessage;
  }
  set onmessage(value: WebSocket["onmessage"]) {
    this.inner.onmessage = value;
  }
  get onerror(): WebSocket["onerror"] {
    return this.inner.onerror;
  }
  set onerror(value: WebSocket["onerror"]) {
    this.inner.onerror = value;
  }
  get onclose(): WebSocket["onclose"] {
    return this.inner.onclose;
  }
  set onclose(value: WebSocket["onclose"]) {
    this.inner.onclose = value;
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    const text = typeof data === "string" ? data : "[binary]";
    observations.socketSends.push({
      ordinal: nextOrdinal(),
      payloadSha256: sha256(text),
      ping: text === "ping",
    });
    this.inner.send(data as string | ArrayBuffer | ArrayBufferView | Blob);
  }

  close(code?: number, reason?: string): void {
    this.inner.close(code, reason);
  }

  addEventListener(...args: Parameters<WebSocket["addEventListener"]>): void {
    (this.inner.addEventListener as (...values: unknown[]) => void)(...args);
  }

  removeEventListener(
    ...args: Parameters<WebSocket["removeEventListener"]>
  ): void {
    (this.inner.removeEventListener as (...values: unknown[]) => void)(...args);
  }
}

const sockets: DelegatingWebSocket[] = [];
Object.defineProperty(globalThis, "WebSocket", {
  configurable: true,
  writable: true,
  value: DelegatingWebSocket,
});

const mobileRoot = path.resolve(import.meta.dir, "..");
const authClientPath = path.join(mobileRoot, "src/lib/auth-client.ts");
const rnAdapterPath = path.join(
  import.meta.dir,
  "cloud-canonical-rn-web-adapter.ts",
);
const ReactNativeWebAdapter = await import(rnAdapterPath);

mock.module("react-native", () => ReactNativeWebAdapter);
mock.module(authClientPath, () => ({
  authClient: {
    useSession: () => ({
      data: { user: { id: activeSubject }, session: { id: activeSessionId } },
      isPending: false,
    }),
    convex: {
      token: async () => ({ data: { token: activeJwt } }),
    },
  },
}));
mock.module("expo-image-picker", () => ({}));
mock.module("expo-file-system", () => ({
  Paths: { cache: storageDirectory, document: storageDirectory },
  File: class File {
    readonly uri: string;
    constructor(...parts: unknown[]) {
      this.uri = parts.map(String).join("/");
    }
    async base64(): Promise<string> {
      throw new Error(
        "Attachment reads are outside this text-only acceptance.",
      );
    }
  },
}));
mock.module("expo-haptics", () => ({
  ImpactFeedbackStyle: { Light: "light", Medium: "medium" },
  NotificationFeedbackType: { Success: "success", Error: "error" },
  impactAsync: async () => undefined,
  notificationAsync: async () => undefined,
}));
mock.module("expo-crypto", () => ({
  getRandomBytes: (length: number) =>
    globalThis.crypto.getRandomValues(new Uint8Array(length)),
  randomUUID: () => globalThis.crypto.randomUUID(),
}));
mock.module("expo-secure-store", () => ({
  getItemAsync: async (key: string) => storage.getItem(`secure:${key}`),
  setItemAsync: async (key: string, value: string) =>
    storage.setItem(`secure:${key}`, value),
  deleteItemAsync: async (key: string) => storage.removeItem(`secure:${key}`),
}));
mock.module("expo/fetch", () => ({
  fetch: globalThis.fetch,
  Headers: globalThis.Headers,
  Request: globalThis.Request,
  Response: globalThis.Response,
}));

const setVisibility = (next: "visible" | "hidden") => {
  visibilityState = next;
  observations.appStateChanges.push({
    ordinal: nextOrdinal(),
    state: next === "visible" ? "active" : "background",
  });
  document.dispatchEvent(new dom.window.Event("visibilitychange"));
};

Object.assign(globalThis, {
  __STELLA_MOBILE_RN_ACCEPTANCE__: {
    observations,
    storage,
    sha256,
    armResponseLoss: () => {
      withholdNextAdmissionResponse = true;
    },
    holdNextAdmissionResponse: () => {
      holdNextAdmissionResponse = true;
    },
    releaseHeldAdmissionResponse: () => {
      releaseHeldAdmission?.();
    },
    setIdentity: (jwt: string, subject: string, sessionId: string) => {
      activeJwt = jwt;
      activeSubject = subject;
      activeSessionId = sessionId;
    },
    setVisibility,
    recordAsyncStorageCompletion: (
      operation: "set" | "remove" | "clear",
      key: string,
      value?: string,
    ) => {
      observations.asyncStorageCompletions.push({
        ordinal: nextOrdinal(),
        operation,
        keySha256: sha256(key),
        ...(value === undefined ? {} : { valueSha256: sha256(value) }),
      });
    },
    dropLatestSocket: () => {
      const socket = [...sockets]
        .reverse()
        .find((candidate) => candidate.readyState === RealWebSocket.OPEN);
      if (!socket) throw new Error("No live WebSocket is available to drop.");
      socket.close(1012, "acceptance reconnect");
    },
    closeAllSockets: () => {
      for (const socket of sockets) {
        if (
          socket.readyState === RealWebSocket.OPEN ||
          socket.readyState === RealWebSocket.CONNECTING
        ) {
          socket.close(1000, "acceptance cleanup");
        }
      }
    },
  },
});
