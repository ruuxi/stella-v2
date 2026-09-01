import type {
  BrowserBackend,
  BrowserHandoff,
  HandoffState,
  SafeObservation,
  SafeTab,
  TrustedVerification,
  TrustedVerificationState,
} from "../src/browser-provider.js";
import { GatewayError } from "../src/errors.js";

export const TEST_KEK = btoa(String.fromCharCode(...new Uint8Array(32)))
  .replace(/\+/gu, "-")
  .replace(/\//gu, "_")
  .replace(/=+$/gu, "");

export class MemoryR2 {
  readonly objects = new Map<
    string,
    { bytes: Uint8Array; customMetadata?: Record<string, string> }
  >();

  async put(
    key: string,
    value: Uint8Array | ArrayBuffer | string,
    options?: { customMetadata?: Record<string, string> },
  ) {
    const bytes =
      typeof value === "string"
        ? new TextEncoder().encode(value)
        : value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : new Uint8Array(value);
    this.objects.set(key, {
      bytes: new Uint8Array(bytes),
      customMetadata: options?.customMetadata,
    });
    return { key, size: bytes.byteLength };
  }

  async get(key: string) {
    const value = this.objects.get(key);
    if (!value) return null;
    return {
      key,
      size: value.bytes.byteLength,
      customMetadata: value.customMetadata,
      arrayBuffer: async () => value.bytes.slice().buffer,
    };
  }

  async delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.objects.delete(key);
    }
  }

  async list(
    options: { prefix?: string; cursor?: string; limit?: number } = {},
  ) {
    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(options.prefix ?? ""))
      .sort();
    const offset = options.cursor ? Number(options.cursor) : 0;
    const limit = options.limit ?? 1_000;
    const page = keys.slice(offset, offset + limit);
    const next = offset + page.length;
    return {
      objects: page.map((key) => ({ key })),
      truncated: next < keys.length,
      ...(next < keys.length ? { cursor: String(next) } : {}),
    };
  }

  asBucket(): R2Bucket {
    return this as unknown as R2Bucket;
  }
}

export class FakeBrowser implements BrowserBackend {
  ensureCount = 0;
  closeCount = 0;
  contextCloseCount = 0;
  checkpointCount = 0;
  verifyCount = 0;
  handoffCount = 0;
  verificationStates: TrustedVerificationState[] = [];
  completeHandoffCalls: boolean[] = [];
  restoredStates: unknown[] = [];
  currentSession: string | undefined;
  currentPolicy: string | undefined;
  activeHandoff = true;
  verificationResult = true;
  closeFailuresRemaining = 0;
  currentUrl = "https://app.example/";
  readonly storageMarker = "cookie-private-marker-do-not-expose";

  async ensure(args: {
    sessionId?: string;
    storageState?: unknown;
    allowedOrigins: readonly string[];
    onSessionAcquired: (sessionId: string, policyDigest: string) => void;
  }): Promise<void> {
    this.ensureCount += 1;
    if (args.storageState)
      this.restoredStates.push(structuredClone(args.storageState));
    if (!this.currentSession) {
      this.currentSession = `session-${this.ensureCount}`;
      this.currentPolicy = `policy-${args.allowedOrigins.join(",")}`;
      args.onSessionAcquired(this.currentSession, this.currentPolicy);
    }
  }
  sessionId(): string | undefined {
    return this.currentSession;
  }
  policyDigest(): string | undefined {
    return this.currentPolicy;
  }
  async navigate(url: string): Promise<SafeObservation> {
    this.currentUrl = url;
    return this.observe();
  }
  async observe(): Promise<SafeObservation> {
    return { url: this.currentUrl, title: "Safe page", text: "Safe body" };
  }
  async click(_selector: string): Promise<void> {}
  async fillNonSecret(_selector: string, _value: string): Promise<void> {}
  async press(_selector: string, _key: string): Promise<void> {}
  async select(_selector: string, _value: string): Promise<void> {}
  async wait(_selector: string, _timeoutMs: number): Promise<void> {}
  async tabs(): Promise<readonly SafeTab[]> {
    return [
      {
        tabId: "0",
        url: this.currentUrl,
        title: "Safe page",
        active: true,
      },
    ];
  }
  async focusTab(_tabId: string): Promise<void> {}
  async storageState(): Promise<unknown> {
    this.checkpointCount += 1;
    return {
      cookies: [
        {
          name: "session",
          value: this.storageMarker,
          domain: "app.example",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        },
      ],
      origins: [
        {
          origin: "https://app.example",
          localStorage: [{ name: "safe", value: "one" }],
          indexedDB: [{ name: "auth", data: [{ token: this.storageMarker }] }],
        },
      ],
    };
  }
  async verifyImportedStorageState(args: {
    storageState: unknown;
    allowedOrigins: readonly string[];
    verification: TrustedVerification;
  }): Promise<void> {
    this.restoredStates.push(structuredClone(args.storageState));
    this.verificationStates.push("authenticated");
    if (!this.verificationResult) {
      throw new GatewayError("verification_failed", 409);
    }
  }
  async startHandoff(_args: {
    handoffTimeoutMs: number;
    expectedOrigin: string;
  }): Promise<BrowserHandoff> {
    this.handoffCount += 1;
    this.activeHandoff = true;
    return { handoffId: "handoff-1", targetId: "target-1" };
  }
  async renewLiveView(
    _liveViewTtlMs: number,
    _targetId?: string,
  ): Promise<string> {
    return "https://live.browser.run/jit-capability";
  }
  async handoffState(): Promise<HandoffState> {
    return { active: this.activeHandoff, handoffId: "handoff-1" };
  }
  async completeHandoff(success: boolean): Promise<void> {
    this.completeHandoffCalls.push(success);
    this.activeHandoff = false;
  }
  async trustedVerify(
    _verification: TrustedVerification,
    expectedState: TrustedVerificationState,
  ): Promise<boolean> {
    this.verifyCount += 1;
    this.verificationStates.push(expectedState);
    return this.verificationResult;
  }
  async closeContext(): Promise<void> {
    this.contextCloseCount += 1;
  }
  async closeRemote(_sessionId?: string): Promise<void> {
    if (this.closeFailuresRemaining > 0) {
      this.closeFailuresRemaining -= 1;
      throw new Error("injected remote browser close failure");
    }
    this.closeCount += 1;
    this.currentSession = undefined;
    this.currentPolicy = undefined;
  }
}

export const AUTHORITY = {
  ownerId: "https://auth.example|user-1",
  ownerGeneration: "owner-generation-1",
  conversationId: "conversation-1",
  threadId: "thread-1",
  turnId: "turn-1",
  attemptGeneration: 1,
} as const;

export const uuid = (suffix: number): string =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
