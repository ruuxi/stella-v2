import {
  BRIDGE_CRYPTO_PROTOCOL,
  createBridgeKeyPair,
  decryptBridgeBytes,
  decryptBridgePayload,
  deriveBridgeCryptoSession,
  encryptBridgeBytes,
  encryptBridgePayload,
  isBridgeEncryptedEnvelope,
  base64UrlToBytes,
  bytesToBase64Url,
  type BridgeCryptoSession,
} from "./bridge-crypto";
import {
  BRIDGE_FEATURE_BINARY_FILE,
  BRIDGE_FEATURE_BINARY_UPLOAD,
  BRIDGE_FEATURE_DEFLATE,
  BRIDGE_FEATURE_LOCAL_CHAT_PUSH,
  MOBILE_SUPPORTED_BRIDGE_FEATURES,
  isUnknownBridgeChannelError,
  parseBase64DataUrl,
  standardBase64ToBytes,
} from "./bridge-envelope";
import { fetch as expoFetch } from "expo/fetch";
import {
  clearPersistedBridgeSession,
  loadCachedBridgeBaseUrl,
  loadPersistedBridgeSession,
  savePersistedBridgeSession,
} from "./bridge-session-store";
import { restoredTxSeq } from "./bridge-session-codec";
import {
  buildPhonePairProofHeaders,
  getDesktopBridgeStatus,
  listStoredPairedPhoneAccess,
  requestDesktopConnection,
  type StoredPhoneAccess,
} from "./phone-access";
import { postJson } from "./http";
import type { ChatArtifact, ChatMessage, MobileTask } from "../types";
import type { ToolStep } from "./tool-activity";
import { agentWorkArtifactId, parseChatArtifacts } from "./mobile-artifacts";

const DESKTOP_WAKE_ATTEMPTS = 5;
const DESKTOP_WAKE_RETRY_MS = 3_000;
const BRIDGE_INVOKE_TIMEOUT_MS = 10_000;
const BRIDGE_HEALTH_TIMEOUT_MS = 3_000;
const BRIDGE_SYNC_TIMEOUT_MS = 5_000;
/**
 * Max stretch of silence (no agent events) before we give up on a run. The
 * desktop keeps the run alive across socket drops, so we reset this on every
 * event and on every successful reconnect rather than treating it as a hard
 * wall-clock deadline.
 */
const BRIDGE_RUN_TIMEOUT_MS = 45_000;
const BRIDGE_RECONNECT_MAX_ATTEMPTS = 4;
const BRIDGE_RECONNECT_BASE_DELAY_MS = 400;
const BRIDGE_RECONNECT_MAX_DELAY_MS = 4_000;
const DEFAULT_HISTORY_LIMIT = 100;
const DEVELOPER_RESOURCE_PREVIEWS_KEY = "stella-developer-resource-previews";
const TIME_TAG_PATTERN =
  "(?:1[0-2]|0?[1-9]):[0-5]\\d\\s?(?:AM|PM)(?:,\\s+[A-Za-z]{3}\\s+\\d{1,2})?";
const SYSTEM_REMINDER_OPEN_TAG = "<\\s*system[-_\\s]*reminder\\s*>";
const SYSTEM_REMINDER_CLOSE_TAG = "<\\/\\s*system[-_\\s]*reminder\\s*>";
const SYSTEM_REMINDER_TIME_TAG = `${SYSTEM_REMINDER_OPEN_TAG}\\s*${TIME_TAG_PATTERN}\\s*${SYSTEM_REMINDER_CLOSE_TAG}`;
const FULL_SYSTEM_REMINDER_TAG_RE = new RegExp(
  `^\\s*${SYSTEM_REMINDER_OPEN_TAG}[\\s\\S]*${SYSTEM_REMINDER_CLOSE_TAG}\\s*$`,
  "i",
);
const LEADING_TIME_TAG_RE = new RegExp(
  `^(?:\\[${TIME_TAG_PATTERN}\\]|${SYSTEM_REMINDER_TIME_TAG})\\s*`,
  "i",
);
const TRAILING_TIME_TAG_RE = new RegExp(
  `\\s*\\n\\n(?:\\[${TIME_TAG_PATTERN}\\]|${SYSTEM_REMINDER_TIME_TAG})\\s*$`,
  "i",
);

export type DesktopBridgeConnection = {
  desktopDeviceId: string;
  baseUrl: string;
  headers: Record<string, string>;
  crypto: BridgeCryptoSession;
  includeDeveloperArtifacts: boolean;
  /** Optional features the desktop advertised via `mobile:hello`. */
  features: Set<string>;
  /** False once `mobile:hello` returned "unknown channel" (older desktop). */
  helloSupported: boolean;
};

const bridgeSupportsDeflate = (bridge: DesktopBridgeConnection) =>
  bridge.features.has(BRIDGE_FEATURE_DEFLATE);

export const bridgeSupportsLocalChatPush = (bridge: DesktopBridgeConnection) =>
  bridge.features.has(BRIDGE_FEATURE_LOCAL_CHAT_PUSH);

/** Coarse send progress surfaced in the working indicator. */
export type DesktopBridgeSendStatus = "connecting" | "waking" | "running";

export type DesktopBridgeAttachment = {
  /** Data URL (`data:image/jpeg;base64,…`) — same shape the desktop composer sends. */
  url: string;
  mimeType?: string;
};

/**
 * Live working-indicator inputs derived from the run's agent events, mirroring
 * the desktop streaming store. Emitted on every tool-start / tool-end / status
 * / first answer-text chunk so the mobile indicator can reflect the current
 * activity and step aside once the reply starts streaming.
 */
export type DesktopBridgeActivity = {
  toolName?: string;
  toolCallId?: string;
  statusText?: string;
  isStreamingText: boolean;
  hasToolActivity: boolean;
};

type DesktopBridgeChatArgs = {
  access: StoredPhoneAccess;
  message: string;
  model?: string | null;
  attachments?: DesktopBridgeAttachment[];
  signal?: AbortSignal;
  onStatus?: (status: DesktopBridgeSendStatus) => void;
  onTextDelta?: (delta: string) => void;
  onActivity?: (activity: DesktopBridgeActivity) => void;
  onArtifacts?: (artifacts: ChatArtifact[]) => void;
};

type DesktopBridgeChatResult = {
  text: string;
  artifacts: ChatArtifact[];
  /**
   * Canonical desktop id of the user message this turn submitted (empty if the
   * bridge never reported it). Canonical assistant rows carry it as their
   * `requestId`, so it links both rows of the turn precisely.
   */
  userMessageId: string;
};

type DesktopBridgeMessage = ChatMessage & {
  requestId?: string;
  timestamp?: number;
};

export type DesktopBridgeChatSyncResult = {
  conversationId: string;
  conversationChanged: boolean;
  cursor: string | null;
  messages: ChatMessage[];
};

type PendingResponse = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

type DesktopBridgeChallenge = {
  challengeId: string;
  challenge: string;
  desktopDeviceId: string;
  desktopPublicKey: string;
  protocol: string;
};

type DesktopBridgeSessionResponse = {
  sessionId: string;
  sessionSecret: string;
  expiresAt: number;
  desktopPublicKey: string;
  protocol: string;
};

class BridgeAbortError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortError";
  }
}

/** The paired desktop never came online — wake attempts all missed. */
export class DesktopOfflineError extends Error {
  constructor() {
    super(
      "Your desktop is offline right now. Open Stella on your desktop and try again.",
    );
    this.name = "DesktopOfflineError";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, "");

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;

const asString = (value: unknown): string =>
  typeof value === "string" ? value : "";

const isNetworkFailure = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  return (
    lower.includes("network") ||
    lower.includes("fetch") ||
    lower.includes("failed to connect")
  );
};

export const normalizeDesktopChatMessageText = (text: string) =>
  FULL_SYSTEM_REMINDER_TAG_RE.test(text)
    ? ""
    : text
        .replace(TRAILING_TIME_TAG_RE, "")
        .replace(LEADING_TIME_TAG_RE, "")
        .trim();

const readBridgeError = async (response: Response) => {
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    // use fallback below
  }
  const record = asRecord(parsed);
  const error = asString(record?.error).trim();
  return error || "Desktop bridge request failed.";
};

const readBridgeChallenge = async (
  baseUrl: string,
  desktopDeviceId: string,
): Promise<DesktopBridgeChallenge> => {
  // Presenting the expected device id proves we already know it, so the
  // desktop doesn't have to leak it (or its public key) to bare scanners —
  // and mismatches fail here instead of after the fetch.
  const response = await fetch(
    `${baseUrl}/bridge/challenge?d=${encodeURIComponent(desktopDeviceId)}`,
    {
      method: "GET",
    },
  );
  if (!response.ok) {
    throw new Error(await readBridgeError(response));
  }
  const record = asRecord(await response.json());
  const challenge = {
    challengeId: asString(record?.challengeId).trim(),
    challenge: asString(record?.challenge).trim(),
    desktopDeviceId: asString(record?.desktopDeviceId).trim(),
    desktopPublicKey: asString(record?.desktopPublicKey).trim(),
    protocol: asString(record?.protocol).trim(),
  };
  if (
    !challenge.challengeId ||
    !challenge.challenge ||
    !challenge.desktopDeviceId ||
    !challenge.desktopPublicKey ||
    challenge.protocol !== BRIDGE_CRYPTO_PROTOCOL
  ) {
    throw new Error("Desktop bridge did not provide a secure challenge.");
  }
  return challenge;
};

const readBridgeSessionResponse = (
  value: unknown,
): DesktopBridgeSessionResponse => {
  const record = asRecord(value);
  const session = {
    sessionId: asString(record?.sessionId).trim(),
    sessionSecret: asString(record?.sessionSecret).trim(),
    expiresAt:
      typeof record?.expiresAt === "number" ? record.expiresAt : Number.NaN,
    desktopPublicKey: asString(record?.desktopPublicKey).trim(),
    protocol: asString(record?.protocol).trim(),
  };
  if (
    !session.sessionId ||
    !session.sessionSecret ||
    !Number.isFinite(session.expiresAt) ||
    !session.desktopPublicKey ||
    session.protocol !== BRIDGE_CRYPTO_PROTOCOL
  ) {
    throw new Error("Desktop bridge session response was invalid.");
  }
  return session;
};

export const createDesktopBridgeSession = async (
  access: StoredPhoneAccess,
  baseUrl: string,
) => {
  const challenge = await readBridgeChallenge(baseUrl, access.desktopDeviceId);
  if (challenge.desktopDeviceId !== access.desktopDeviceId) {
    throw new Error("Desktop bridge challenge was for a different computer.");
  }
  const keyPair = createBridgeKeyPair();
  const session = readBridgeSessionResponse(
    await postJson(
      "/api/mobile/desktop-bridge/session",
      {
        desktopDeviceId: access.desktopDeviceId,
        desktopChallenge: challenge.challenge,
        mobilePublicKey: keyPair.publicKey,
      },
      {
        headers: buildPhonePairProofHeaders(
          access,
          challenge.challenge,
          keyPair.publicKey,
        ),
      },
    ),
  );
  if (
    session.desktopPublicKey !== challenge.desktopPublicKey ||
    session.desktopPublicKey.trim().length === 0
  ) {
    throw new Error("Desktop bridge public key did not match Convex.");
  }
  return {
    session,
    headers: {
      "X-Stella-Bridge-Session-Id": session.sessionId,
      "X-Stella-Bridge-Session-Secret": session.sessionSecret,
      "X-Stella-Bridge-Challenge-Id": challenge.challengeId,
      "X-Stella-Bridge-Encrypted": BRIDGE_CRYPTO_PROTOCOL,
      // Advertise the phone's optional receive-features (e.g. envelope
      // deflate) so the desktop can gate response-side encoding. Old desktops
      // ignore the header.
      "X-Stella-Bridge-Features": MOBILE_SUPPORTED_BRIDGE_FEATURES.join(","),
    },
    crypto: deriveBridgeCryptoSession({
      sessionId: session.sessionId,
      secretKey: keyPair.secretKey,
      peerPublicKey: session.desktopPublicKey,
      mobilePublicKey: keyPair.publicKey,
      desktopPublicKey: session.desktopPublicKey,
    }),
  };
};

const toWebSocketUrl = (baseUrl: string) => {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/bridge/ws`;
  url.search = "";
  url.hash = "";
  return url.toString();
};

const canReachBridgeHealth = async (baseUrl: string) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BRIDGE_HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/bridge/health`, {
      method: "GET",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

const readDesktopDeveloperArtifactsEnabled = async (
  baseUrl: string,
  headers: Record<string, string>,
) => {
  try {
    const response = await fetch(`${baseUrl}/bridge/bootstrap`, { headers });
    if (!response.ok) return false;
    const parsed = asRecord(await response.json());
    const localStorage = asRecord(parsed?.localStorage);
    return asString(localStorage?.[DEVELOPER_RESOURCE_PREVIEWS_KEY]) === "true";
  } catch {
    return false;
  }
};

const filterDesktopBridgeArtifacts = (
  artifacts: ChatArtifact[],
  includeDeveloperArtifacts: boolean,
) =>
  includeDeveloperArtifacts
    ? artifacts
    : artifacts.filter((artifact) => artifact.payload.kind !== "source-diff");

type CachedDesktopBridge = {
  connection: DesktopBridgeConnection;
  expiresAt: number;
};

/**
 * One encrypted bridge session is reused across sends/loads instead of being
 * re-handshaked per message. The desktop caps sessions at 15 minutes; we
 * refresh a minute early, and before reusing we probe an authenticated
 * endpoint so a session the desktop has forgotten (it slept, restarted, or
 * rotated its tunnel) triggers a fresh handshake rather than a 401.
 */
const desktopBridgeCache = new Map<string, CachedDesktopBridge>();
const inflightBridgeResolves = new Map<
  string,
  Promise<DesktopBridgeConnection>
>();
const BRIDGE_SESSION_REFRESH_MARGIN_MS = 60_000;

const getCachedDesktopBridge = (
  desktopDeviceId: string,
): DesktopBridgeConnection | null => {
  const entry = desktopBridgeCache.get(desktopDeviceId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now() + BRIDGE_SESSION_REFRESH_MARGIN_MS) {
    desktopBridgeCache.delete(desktopDeviceId);
    return null;
  }
  return entry.connection;
};

/**
 * Forget cached bridge sessions. Call on sign-out / unpair so a signed-out
 * phone can't keep talking to the desktop on a still-valid cached session.
 * Sign-out/unpair also wipes the persisted copy (and the cached tunnel URL
 * that rides in the same record); internal cache invalidation keeps it so the
 * next handshake can still fast-probe the last-known URL.
 */
export const clearCachedDesktopBridge = (
  desktopDeviceId?: string,
  options?: { keepPersisted?: boolean },
) => {
  if (desktopDeviceId) {
    desktopBridgeCache.delete(desktopDeviceId);
    if (!options?.keepPersisted) {
      void clearPersistedBridgeSession(desktopDeviceId);
    }
  } else {
    desktopBridgeCache.clear();
    if (!options?.keepPersisted) {
      void listStoredPairedPhoneAccess()
        .then((all) =>
          Promise.all(
            all.map((entry) =>
              clearPersistedBridgeSession(entry.desktopDeviceId),
            ),
          ),
        )
        .catch(() => {});
    }
  }
};

/** Persist the session so an app restart can skip the full handshake. */
const persistDesktopBridge = (
  connection: DesktopBridgeConnection,
  expiresAt: number,
) => {
  void savePersistedBridgeSession(connection.desktopDeviceId, {
    v: 1,
    baseUrl: connection.baseUrl,
    sessionId: connection.crypto.sessionId,
    headers: connection.headers,
    keyB64: bytesToBase64Url(connection.crypto.key),
    txSeq: connection.crypto.txSeq,
    expiresAt,
    features: [...connection.features],
    helloSupported: connection.helloSupported,
    includeDeveloperArtifacts: connection.includeDeveloperArtifacts,
  });
};

/**
 * Rebuild a connection from the persisted session (app cold start). The tx
 * seq restarts with slack so the desktop's anti-replay window never sees a
 * reused seq; the caller still liveness-probes before trusting it.
 */
const restorePersistedDesktopBridge = async (
  desktopDeviceId: string,
): Promise<DesktopBridgeConnection | null> => {
  const persisted = await loadPersistedBridgeSession(desktopDeviceId);
  if (!persisted) return null;
  let key: Uint8Array;
  try {
    key = base64UrlToBytes(persisted.keyB64);
  } catch {
    return null;
  }
  if (key.length !== 32) return null;
  const connection: DesktopBridgeConnection = {
    desktopDeviceId,
    baseUrl: persisted.baseUrl,
    headers: persisted.headers,
    crypto: {
      sessionId: persisted.sessionId,
      key,
      txSeq: restoredTxSeq(persisted.txSeq),
    },
    includeDeveloperArtifacts: persisted.includeDeveloperArtifacts,
    features: new Set(persisted.features),
    helloSupported: persisted.helloSupported,
  };
  desktopBridgeCache.set(desktopDeviceId, {
    connection,
    expiresAt: persisted.expiresAt,
  });
  // Re-persist immediately so the next restore's slack stacks on this one's.
  persistDesktopBridge(connection, persisted.expiresAt);
  return getCachedDesktopBridge(desktopDeviceId);
};

/** Authenticated liveness probe — confirms the desktop still honors this session. */
const isCachedBridgeAlive = async (
  connection: DesktopBridgeConnection,
): Promise<boolean> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BRIDGE_HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(`${connection.baseUrl}/bridge/bootstrap`, {
      headers: connection.headers,
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

export async function resolveDesktopBridge(
  access: StoredPhoneAccess,
  onStatus?: (status: DesktopBridgeSendStatus) => void,
  opts?: { forceRefresh?: boolean },
): Promise<DesktopBridgeConnection> {
  const desktopDeviceId = access.desktopDeviceId;

  if (opts?.forceRefresh) {
    clearCachedDesktopBridge(desktopDeviceId, { keepPersisted: true });
  } else {
    const cached =
      getCachedDesktopBridge(desktopDeviceId) ??
      (await restorePersistedDesktopBridge(desktopDeviceId));
    if (cached && (await isCachedBridgeAlive(cached))) {
      onStatus?.("connecting");
      return cached;
    }
    if (cached) {
      clearCachedDesktopBridge(desktopDeviceId, { keepPersisted: true });
    }
    const inflight = inflightBridgeResolves.get(desktopDeviceId);
    if (inflight) return inflight;
  }

  const promise = handshakeDesktopBridge(access, onStatus).finally(() => {
    if (inflightBridgeResolves.get(desktopDeviceId) === promise) {
      inflightBridgeResolves.delete(desktopDeviceId);
    }
  });
  inflightBridgeResolves.set(desktopDeviceId, promise);
  return promise;
}

async function handshakeDesktopBridge(
  access: StoredPhoneAccess,
  onStatus?: (status: DesktopBridgeSendStatus) => void,
): Promise<DesktopBridgeConnection> {
  onStatus?.("connecting");

  // The tunnel hostname is stable per desktop, so probe the last-known URL
  // directly *in parallel with* the wake intent. When the desktop is already
  // up this removes the Convex status round-trips (and their 3s poll
  // granularity) from the connect path entirely; the wake intent still lands
  // either way and re-arms the desktop's idle timer.
  const cachedBaseUrl = await loadCachedBridgeBaseUrl(access.desktopDeviceId);
  const wakePromise = requestDesktopConnection(access).then(
    () => null,
    (error: unknown) => error ?? new Error("Wake request failed"),
  );

  let baseUrl = "";
  if (cachedBaseUrl && (await canReachBridgeHealth(cachedBaseUrl))) {
    baseUrl = cachedBaseUrl;
  } else {
    // Slow path: the cached URL missed (asleep desktop, rotated tunnel, or
    // first connect). Preserve the original behavior — a failed wake request
    // is fatal here — then poll Convex for the advertised URL.
    const wakeError = await wakePromise;
    if (wakeError) throw wakeError;
  }

  let lastCandidateUrl = "";
  for (
    let attempt = 0;
    !baseUrl && attempt < DESKTOP_WAKE_ATTEMPTS;
    attempt += 1
  ) {
    const status = await getDesktopBridgeStatus(access.desktopDeviceId);
    const firstUrl = status.baseUrls.find((url) => url.trim().length > 0);
    if (status.available && firstUrl) {
      const candidateUrl = trimTrailingSlash(firstUrl);
      lastCandidateUrl = candidateUrl;
      if (await canReachBridgeHealth(candidateUrl)) {
        baseUrl = candidateUrl;
        break;
      }
    }
    if (attempt < DESKTOP_WAKE_ATTEMPTS - 1) {
      // First probe missed — the desktop is likely asleep and being woken by
      // the connection request above. Tell the UI we're waking it.
      onStatus?.("waking");
      await sleep(DESKTOP_WAKE_RETRY_MS);
    }
  }

  // Prefer a health-confirmed URL, but if the desktop advertised one and the
  // probe never passed (e.g. an older desktop without /bridge/health, or a slow
  // edge), try it anyway rather than blocking the user.
  if (!baseUrl && lastCandidateUrl) {
    baseUrl = lastCandidateUrl;
  }

  if (!baseUrl) {
    throw new DesktopOfflineError();
  }
  onStatus?.("connecting");

  const bridgeSession = await createDesktopBridgeSession(access, baseUrl);
  const connection: DesktopBridgeConnection = {
    desktopDeviceId: access.desktopDeviceId,
    baseUrl,
    headers: bridgeSession.headers,
    crypto: bridgeSession.crypto,
    includeDeveloperArtifacts: false,
    features: new Set<string>(),
    helloSupported: true,
  };
  // One `mobile:hello` learns the desktop's feature set + developer-artifacts
  // flag (replacing the legacy `/bridge/bootstrap` read). Older desktops
  // reject the channel; fall back to the bootstrap fetch for the flag.
  try {
    const hello = asRecord(
      await invokeDesktopBridge(connection, "mobile:hello", [
        { maxMessages: 1 },
      ]),
    );
    connection.features = new Set(
      Array.isArray(hello?.features)
        ? hello.features.filter((f): f is string => typeof f === "string")
        : [],
    );
    connection.includeDeveloperArtifacts =
      hello?.developerArtifactsEnabled === true;
  } catch (error) {
    if (!isUnknownBridgeChannelError(error)) throw error;
    connection.helloSupported = false;
    connection.includeDeveloperArtifacts =
      await readDesktopDeveloperArtifactsEnabled(
        baseUrl,
        bridgeSession.headers,
      );
  }
  desktopBridgeCache.set(access.desktopDeviceId, {
    connection,
    expiresAt: bridgeSession.session.expiresAt,
  });
  persistDesktopBridge(connection, bridgeSession.session.expiresAt);
  return connection;
}

export async function invokeDesktopBridge<T>(
  bridge: DesktopBridgeConnection,
  channel: string,
  args: unknown[] = [],
  timeoutMs = BRIDGE_INVOKE_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const encryptedBody = encryptBridgePayload(bridge.crypto, "m2d", { args });
    const response = await fetch(
      `${bridge.baseUrl}/bridge/ipc/${encodeURIComponent(channel)}`,
      {
        method: "POST",
        headers: {
          ...bridge.headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ envelope: encryptedBody }),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      throw new Error(await readBridgeError(response));
    }
    const responseRecord = asRecord(await response.json());
    if (!isBridgeEncryptedEnvelope(responseRecord?.envelope)) {
      throw new Error("Desktop bridge returned an unencrypted response.");
    }
    const decoded = decryptBridgePayload(
      bridge.crypto,
      "d2m",
      responseRecord.envelope,
    ) as { result?: T };
    return decoded.result as T;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("Desktop bridge request timed out.");
    }
    if (isNetworkFailure(error)) {
      throw new Error(
        "Could not reach your desktop tunnel. Keep Stella open on your desktop and try again.",
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Encrypted-binary file download (`POST /bridge/file`). Ships raw AES-GCM
 * ciphertext (~1.0x file size) instead of the legacy JSON-serialized byte
 * array (~8-10x). Returns null when the desktop doesn't support the lane so
 * the caller can fall back to `display:readFile`.
 */
export async function fetchDesktopBridgeFileBytes(
  bridge: DesktopBridgeConnection,
  conversationId: string,
  filePath: string,
): Promise<
  | { missing: false; bytes: Uint8Array; sizeBytes: number; mimeType: string }
  | { missing: true; mimeType: string; path: string }
  | null
> {
  if (!bridge.features.has("binary-file-lane")) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BRIDGE_INVOKE_TIMEOUT_MS);
  try {
    const envelope = encryptBridgePayload(
      bridge.crypto,
      "m2d",
      { filePath, conversationId },
      { compress: bridgeSupportsDeflate(bridge) },
    );
    const response = await fetch(`${bridge.baseUrl}/bridge/file`, {
      method: "POST",
      headers: { ...bridge.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ envelope }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(await readBridgeError(response));
    }
    if (response.headers.get("x-stella-bridge-bin") === "1") {
      const seq = Number(response.headers.get("x-stella-bridge-bin-seq"));
      const iv = response.headers.get("x-stella-bridge-bin-iv") ?? "";
      const mimeType =
        response.headers.get("x-stella-bridge-bin-mime") ??
        "application/octet-stream";
      const ciphertext = new Uint8Array(await response.arrayBuffer());
      const bytes = decryptBridgeBytes(bridge.crypto, "d2m", {
        seq,
        iv,
        ciphertext,
      });
      return {
        missing: false,
        bytes,
        sizeBytes:
          Number(response.headers.get("x-stella-bridge-bin-size")) ||
          bytes.byteLength,
        mimeType,
      };
    }
    // JSON (encrypted) response — the missing-file case.
    const record = asRecord(await response.json());
    if (!isBridgeEncryptedEnvelope(record?.envelope)) {
      throw new Error("Desktop bridge returned an unencrypted response.");
    }
    const decoded = asRecord(
      decryptBridgePayload(bridge.crypto, "d2m", record.envelope),
    );
    const result = asRecord(decoded?.result);
    return {
      missing: true,
      mimeType: asString(result?.mimeType) || "application/octet-stream",
      path: asString(result?.path) || filePath,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stage attachments through the encrypted-binary upload lane
 * (`POST /bridge/upload`) and return `{ uploadId, mimeType }` references for
 * `agent:startChat`. Raw ciphertext bodies cost ~1.0x the file size (the
 * legacy base64-in-encrypted-JSON path costs ~1.78x), which also raises the
 * effective attachment ceiling under the desktop's 5 MB body cap from
 * ~2.6 MB to ~5 MB. Returns null (caller keeps inline data URLs) when the
 * lane is unsupported or any upload fails.
 */
async function stageBridgeAttachments(
  bridge: DesktopBridgeConnection,
  attachments: DesktopBridgeAttachment[],
): Promise<{ uploadId: string; mimeType: string }[] | null> {
  if (!bridge.features.has(BRIDGE_FEATURE_BINARY_UPLOAD)) return null;
  try {
    const staged: { uploadId: string; mimeType: string }[] = [];
    for (const attachment of attachments) {
      const parsed = parseBase64DataUrl(attachment.url);
      if (!parsed) return null;
      const bytes = standardBase64ToBytes(parsed.base64);
      const frame = encryptBridgeBytes(bridge.crypto, "m2d", bytes);
      const mimeType = attachment.mimeType ?? parsed.mimeType;
      const response = await expoFetch(`${bridge.baseUrl}/bridge/upload`, {
        method: "POST",
        headers: {
          ...bridge.headers,
          "Content-Type": "application/octet-stream",
          "X-Stella-Bridge-Bin-Seq": String(frame.seq),
          "X-Stella-Bridge-Bin-Iv": frame.iv,
          "X-Stella-Bridge-Bin-Mime": mimeType,
        },
        // Copy into a standalone ArrayBuffer — expo/fetch's BodyInit typing
        // doesn't name Uint8Array, though the runtime normalizes both.
        body: frame.ciphertext.buffer.slice(
          frame.ciphertext.byteOffset,
          frame.ciphertext.byteOffset + frame.ciphertext.byteLength,
        ) as ArrayBuffer,
      });
      if (!response.ok) return null;
      const record = asRecord(await response.json());
      if (!isBridgeEncryptedEnvelope(record?.envelope)) return null;
      const decoded = asRecord(
        decryptBridgePayload(bridge.crypto, "d2m", record.envelope),
      );
      const uploadId = asString(asRecord(decoded?.result)?.uploadId).trim();
      if (!uploadId) return null;
      staged.push({ uploadId, mimeType });
    }
    return staged;
  } catch {
    return null;
  }
}

async function getDesktopBridgeConversationId(
  bridge: DesktopBridgeConnection,
  timeoutMs = BRIDGE_INVOKE_TIMEOUT_MS,
): Promise<string> {
  const uiState = asRecord(
    await invokeDesktopBridge(bridge, "ui:getState", [], timeoutMs),
  );
  const activeConversationId = asString(uiState?.conversationId).trim();
  if (activeConversationId) {
    return activeConversationId;
  }

  const fallbackConversationId = asString(
    await invokeDesktopBridge(
      bridge,
      "localChat:getOrCreateDefaultConversationId",
      [],
      timeoutMs,
    ),
  ).trim();
  if (!fallbackConversationId) {
    throw new Error("Could not find your desktop chat.");
  }
  return fallbackConversationId;
}

async function listDesktopBridgeMessages(
  bridge: DesktopBridgeConnection,
  conversationId: string,
  maxMessages: number,
): Promise<DesktopBridgeMessage[]> {
  const rows = await invokeDesktopBridge<unknown[]>(
    bridge,
    "localChat:listSyncMessages",
    [
      {
        conversationId,
        maxMessages,
        includeDeveloperArtifacts: bridge.includeDeveloperArtifacts,
      },
    ],
  );
  return parseDesktopBridgeMessageRows(rows, conversationId);
}

function parseToolSteps(value: unknown): ToolStep[] {
  if (!Array.isArray(value)) return [];
  const steps: ToolStep[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    const id = asString(record.id).trim();
    const toolName = asString(record.toolName).trim();
    const status = record.status;
    if (!id || !toolName || (status !== "completed" && status !== "error")) {
      continue;
    }
    const argsRecord = asRecord(record.args);
    let args: Record<string, string> | undefined;
    if (argsRecord) {
      const collected: Record<string, string> = {};
      for (const [key, raw] of Object.entries(argsRecord)) {
        if (typeof raw === "string") collected[key] = raw;
      }
      if (Object.keys(collected).length > 0) args = collected;
    }
    steps.push({ id, toolName, status, ...(args ? { args } : {}) });
  }
  return steps;
}

const TASK_STATUSES = new Set(["running", "completed", "error", "canceled"]);

function parseTasks(value: unknown): MobileTask[] {
  if (!Array.isArray(value)) return [];
  const tasks: MobileTask[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    const id = asString(record.id).trim();
    const title = asString(record.title).trim();
    const status = record.status;
    if (!id || !title || typeof status !== "string" || !TASK_STATUSES.has(status)) {
      continue;
    }
    const statusText = asString(record.statusText).trim();
    const reasoningSummaries = Array.isArray(record.reasoningSummaries)
      ? record.reasoningSummaries
          .map((summary) => asString(summary).trim())
          .filter((summary) => summary.length > 0)
      : [];
    const createdAt =
      typeof record.createdAt === "number" && Number.isFinite(record.createdAt)
        ? record.createdAt
        : 0;
    const completedAt =
      typeof record.completedAt === "number" &&
      Number.isFinite(record.completedAt)
        ? record.completedAt
        : undefined;
    tasks.push({
      id,
      title,
      status: status as MobileTask["status"],
      ...(statusText ? { statusText } : {}),
      ...(reasoningSummaries.length > 0 ? { reasoningSummaries } : {}),
      createdAt,
      ...(completedAt !== undefined ? { completedAt } : {}),
    });
  }
  return tasks;
}

function parseDesktopBridgeMessageRows(
  rows: unknown[],
  conversationId: string,
): DesktopBridgeMessage[] {
  return rows
    .filter((row): row is Record<string, unknown> => Boolean(asRecord(row)))
    .map((row) => {
      const record = row as Record<string, unknown>;
      const id = asString(record.localMessageId).trim();
      const role = record.role;
      const text = normalizeDesktopChatMessageText(asString(record.text));
      const artifacts = parseChatArtifacts(record.artifacts, conversationId);
      const toolSteps = parseToolSteps(record.toolSteps);
      const tasks = parseTasks(record.tasks);
      const requestId = asString(record.requestId).trim();
      const timestamp =
        typeof record.timestamp === "number" &&
        Number.isFinite(record.timestamp)
          ? record.timestamp
          : undefined;
      if (
        !id ||
        (role !== "user" && role !== "assistant") ||
        (!text &&
          artifacts.length === 0 &&
          toolSteps.length === 0 &&
          tasks.length === 0)
      ) {
        return null;
      }
      return {
        id,
        role,
        text,
        ...(requestId ? { requestId } : {}),
        ...(timestamp !== undefined ? { timestamp, createdAt: timestamp } : {}),
        ...(artifacts.length > 0 ? { artifacts } : {}),
        ...(toolSteps.length > 0 ? { toolSteps } : {}),
        ...(tasks.length > 0 ? { tasks } : {}),
      };
    })
    .filter((message): message is ChatMessage => Boolean(message));
}

export async function loadDesktopBridgeChatMessages(
  access: StoredPhoneAccess,
  maxMessages = DEFAULT_HISTORY_LIMIT,
): Promise<ChatMessage[]> {
  const bridge = await resolveDesktopBridge(access);
  const conversationId = await getDesktopBridgeConversationId(bridge);
  return await listDesktopBridgeMessages(bridge, conversationId, maxMessages);
}

export async function syncDesktopBridgeChatMessages({
  access,
  expectedConversationId,
  sinceCursor,
  maxMessages = DEFAULT_HISTORY_LIMIT,
}: {
  access: StoredPhoneAccess;
  expectedConversationId?: string | null;
  sinceCursor?: string | null;
  maxMessages?: number;
}): Promise<DesktopBridgeChatSyncResult> {
  const bridge = await resolveDesktopBridge(access);
  const expected = expectedConversationId?.trim() || null;

  // Fast path: `mobile:hello` folds conversation-id resolution, the developer
  // flag and the message delta into one round-trip. Falls back to the legacy
  // multi-invoke path against older desktops (and demotes the flag so we
  // don't retry hello on every sync).
  if (bridge.helloSupported) {
    try {
      const hello = asRecord(
        await invokeDesktopBridge(
          bridge,
          "mobile:hello",
          [
            {
              expectedConversationId: expected,
              sinceCursor: sinceCursor ?? null,
              maxMessages,
            },
          ],
          BRIDGE_SYNC_TIMEOUT_MS,
        ),
      );
      const conversationId = asString(hello?.conversationId).trim();
      if (conversationId) {
        bridge.includeDeveloperArtifacts =
          hello?.developerArtifactsEnabled === true;
        if (Array.isArray(hello?.features)) {
          bridge.features = new Set(
            hello.features.filter((f): f is string => typeof f === "string"),
          );
        }
        const conversationChanged =
          hello?.conversationChanged === true ||
          Boolean(expected && expected !== conversationId);
        const effectiveCursor = conversationChanged ? null : sinceCursor;
        const rows = Array.isArray(hello?.messages) ? hello.messages : [];
        const cursor =
          asString(hello?.cursor).trim() || effectiveCursor || null;
        return {
          conversationId,
          conversationChanged,
          cursor,
          messages: parseDesktopBridgeMessageRows(rows, conversationId),
        };
      }
    } catch (error) {
      if (!isUnknownBridgeChannelError(error)) throw error;
      bridge.helloSupported = false;
    }
  }

  const conversationId = await getDesktopBridgeConversationId(
    bridge,
    BRIDGE_SYNC_TIMEOUT_MS,
  );
  const conversationChanged = Boolean(expected && expected !== conversationId);
  const effectiveCursor = conversationChanged ? null : sinceCursor;
  const result = asRecord(
    await invokeDesktopBridge(
      bridge,
      "localChat:syncMessages",
      [
        {
          conversationId,
          sinceCursor: effectiveCursor ?? null,
          maxMessages,
          includeDeveloperArtifacts: bridge.includeDeveloperArtifacts,
        },
      ],
      BRIDGE_SYNC_TIMEOUT_MS,
    ),
  );
  const rows = Array.isArray(result?.messages) ? result.messages : [];
  const cursor = asString(result?.cursor).trim() || effectiveCursor || null;
  return {
    conversationId,
    conversationChanged,
    cursor,
    messages: parseDesktopBridgeMessageRows(rows, conversationId),
  };
}

type HeaderWebSocketConstructor = new (
  url: string,
  protocols?: string | string[] | null,
  options?: { headers?: Record<string, string> },
) => WebSocket;

function openBridgeWebSocket(
  bridge: DesktopBridgeConnection,
  signal?: AbortSignal,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new BridgeAbortError());
      return;
    }

    const WebSocketWithHeaders =
      WebSocket as unknown as HeaderWebSocketConstructor;
    const ws = new WebSocketWithHeaders(toWebSocketUrl(bridge.baseUrl), null, {
      headers: bridge.headers,
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("Could not connect to your desktop."));
      ws.close();
    }, BRIDGE_INVOKE_TIMEOUT_MS);

    let onAbort = () => {};
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
      ws.close();
    };
    onAbort = () => fail(new BridgeAbortError());

    signal?.addEventListener("abort", onAbort);

    ws.onopen = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(ws);
    };
    ws.onerror = () => fail(new Error("Could not connect to your desktop."));
    ws.onclose = () => fail(new Error("Desktop bridge disconnected."));
  });
}

function createBridgeSocketClient(
  ws: WebSocket,
  cryptoSession: BridgeCryptoSession,
  onEvent: (channel: string, data: unknown) => void,
  onClose?: () => void,
  options?: { compress?: boolean },
) {
  const pending = new Map<string, PendingResponse>();

  ws.onmessage = (event) => {
    let message: unknown = null;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const outerRecord = asRecord(message);
    const record = isBridgeEncryptedEnvelope(outerRecord?.envelope)
      ? asRecord(
          decryptBridgePayload(cryptoSession, "d2m", outerRecord.envelope),
        )
      : outerRecord;
    if (!record) return;

    if (record.type === "event") {
      const channel = asString(record.channel);
      if (channel) {
        onEvent(channel, record.data);
      }
      return;
    }

    if (record.type !== "response") return;
    const id = asString(record.id);
    if (!id) return;
    const callback = pending.get(id);
    if (!callback) return;
    pending.delete(id);
    clearTimeout(callback.timer);
    const error = asString(record.error).trim();
    if (error) {
      callback.reject(new Error(error));
      return;
    }
    callback.resolve(record.result);
  };

  ws.onclose = () => {
    for (const callback of pending.values()) {
      clearTimeout(callback.timer);
      callback.reject(new Error("Desktop bridge disconnected."));
    }
    pending.clear();
    onClose?.();
  };

  const send = (payload: unknown) => {
    if (ws.readyState !== WebSocket.OPEN) {
      throw new Error("Desktop bridge disconnected.");
    }
    ws.send(
      JSON.stringify({
        envelope: encryptBridgePayload(cryptoSession, "m2d", payload),
      }),
    );
  };

  return {
    subscribe(channel: string) {
      send({ type: "subscribe", channel });
    },
    invoke<T>(
      channel: string,
      args: unknown[] = [],
      timeoutMs = BRIDGE_INVOKE_TIMEOUT_MS,
    ): Promise<T> {
      const id = `mobile:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Desktop bridge request timed out."));
        }, timeoutMs);
        pending.set(id, {
          resolve: (value) => resolve(value as T),
          reject,
          timer,
        });
        try {
          send({ type: "invoke", id, channel, args });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },
    close() {
      ws.close();
    },
  };
}

/**
 * Open a lightweight event-subscription socket on an existing bridge
 * connection. Used by the localChat push channel (desktop broadcasts
 * `localChat:updated` on every persisted event); the send path keeps its own
 * socket. The returned handle must be closed by the caller.
 */
export async function openDesktopBridgeEventSocket(
  bridge: DesktopBridgeConnection,
  options: {
    channels: string[];
    onEvent: (channel: string, data: unknown) => void;
    onClose: () => void;
  },
): Promise<{ close: () => void }> {
  const ws = await openBridgeWebSocket(bridge);
  const client = createBridgeSocketClient(
    ws,
    bridge.crypto,
    options.onEvent,
    options.onClose,
    { compress: bridgeSupportsDeflate(bridge) },
  );
  for (const channel of options.channels) {
    client.subscribe(channel);
  }
  return { close: () => client.close() };
}

async function readLatestAssistantMessage(
  bridge: DesktopBridgeConnection,
  conversationId: string,
): Promise<DesktopBridgeMessage | null> {
  const messages = await listDesktopBridgeMessages(
    bridge,
    conversationId,
    DEFAULT_HISTORY_LIMIT,
  );
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message?.role === "assistant" &&
      (message.text.trim() || (message.artifacts?.length ?? 0) > 0)
    ) {
      return message;
    }
  }
  return null;
}

async function readAssistantMessageForTurn(
  bridge: DesktopBridgeConnection,
  conversationId: string,
  userMessageId: string,
): Promise<DesktopBridgeMessage | null> {
  const expectedRequestId = userMessageId.trim();
  if (!expectedRequestId) return null;
  const messages = await listDesktopBridgeMessages(
    bridge,
    conversationId,
    DEFAULT_HISTORY_LIMIT,
  );
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message?.role === "assistant" &&
      message.requestId === expectedRequestId &&
      (message.text.trim() || (message.artifacts?.length ?? 0) > 0)
    ) {
      return message;
    }
  }
  return null;
}

const createClientRequestId = (conversationId: string) => {
  const random =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `mobile:${conversationId}:${random}`;
};

type ConnectionOutcome =
  | { kind: "finished" }
  | { kind: "aborted" }
  | { kind: "timeout" }
  | { kind: "disconnected" }
  | { kind: "fatal"; error: unknown };

const isDisconnectError = (error: unknown) => {
  if (isNetworkFailure(error)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /disconnect|timed out|could not connect|connect to your desktop/i.test(
    message,
  );
};

export async function sendDesktopBridgeChat({
  access,
  message,
  model,
  attachments,
  signal,
  onStatus,
  onTextDelta,
  onActivity,
  onArtifacts,
}: DesktopBridgeChatArgs): Promise<DesktopBridgeChatResult> {
  const text = message.trim();
  if (!text && !attachments?.length) {
    throw new Error("Message is required.");
  }
  if (signal?.aborted) {
    throw new BridgeAbortError();
  }

  let activeBridge = await resolveDesktopBridge(access, onStatus);
  const conversationId = await getDesktopBridgeConversationId(activeBridge);
  // Prefer the encrypted-binary upload lane for attachments (~1.0x wire cost
  // vs ~1.78x inline, and a ~5 MB ceiling instead of ~2.6 MB). Falls back to
  // inline data URLs when the desktop lacks the lane or an upload fails.
  const stagedAttachments = attachments?.length
    ? await stageBridgeAttachments(activeBridge, attachments)
    : null;
  // Stable idempotency key: the desktop dedupes retries of this exact send, so
  // reconnecting and re-issuing startChat can never spawn a duplicate run.
  const clientRequestId = createClientRequestId(conversationId);
  const startChatArgs = {
    conversationId,
    userPrompt: text || "See the attached image.",
    deviceId: access.mobileDeviceId,
    platform: "mobile",
    mode: "computer",
    storageMode: "local",
    clientRequestId,
    ...(attachments?.length
      ? { attachments: stagedAttachments ?? attachments }
      : {}),
    messageMetadata: {
      source: "stella_mobile",
      ...(model?.trim() ? { mobileModelPreference: model.trim() } : {}),
    },
  };

  // ── Run state shared across reconnect attempts ──────────────────────────
  let lastSeq = 0;
  let runId = "";
  let requestId = "";
  let submittedUserMessageId = "";
  let startIssued = false;
  let runStarted = false;
  let settled = false;
  let finalResult: DesktopBridgeChatResult | null = null;
  let finalError: unknown = null;

  // ── Live working-indicator activity (mirrors the desktop streaming store) ─
  // `activeToolCalls` is insertion-ordered so the "last" entry is the most
  // recent in-flight tool, matching the desktop's `Object.entries(...).at(-1)`.
  const activeToolCalls = new Map<string, { toolName: string }>();
  let activityStatusText: string | undefined;
  let activityStreamingText = false;
  let activityHasToolActivity = false;

  const emitActivity = () => {
    const lastEntry = [...activeToolCalls.entries()].at(-1);
    onActivity?.({
      ...(lastEntry ? { toolName: lastEntry[1].toolName } : {}),
      ...(lastEntry ? { toolCallId: lastEntry[0] } : {}),
      ...(activityStatusText ? { statusText: activityStatusText } : {}),
      isStreamingText: activityStreamingText,
      hasToolActivity: activityHasToolActivity,
    });
  };

  const artifactById = new Map<string, ChatArtifact>();
  const parseAgentWorkArtifactId = (id: string): Set<string> | null => {
    if (!id.startsWith("agent-work:")) return null;
    const agentIds = id
      .slice("agent-work:".length)
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    return agentIds.length > 0 ? new Set(agentIds) : null;
  };
  const isSubset = (candidate: Set<string>, target: Set<string>) => {
    for (const value of candidate) {
      if (!target.has(value)) return false;
    }
    return true;
  };
  const mergeArtifacts = (artifacts: ChatArtifact[]) => {
    let changed = false;
    for (const artifact of artifacts) {
      const nextAgentIds =
        artifact.payload.kind === "agent-work"
          ? parseAgentWorkArtifactId(artifact.id)
          : null;
      if (nextAgentIds) {
        let coveredByExistingGroup = false;
        for (const existing of artifactById.values()) {
          if (existing.id === artifact.id) continue;
          if (existing.payload.kind !== "agent-work") continue;
          const existingAgentIds = parseAgentWorkArtifactId(existing.id);
          if (!existingAgentIds) continue;
          if (isSubset(nextAgentIds, existingAgentIds)) {
            coveredByExistingGroup = true;
            break;
          }
          if (isSubset(existingAgentIds, nextAgentIds)) {
            artifactById.delete(existing.id);
            changed = true;
          }
        }
        if (coveredByExistingGroup) continue;
      }
      const existing = artifactById.get(artifact.id);
      if (
        existing &&
        JSON.stringify(existing.payload) === JSON.stringify(artifact.payload)
      ) {
        continue;
      }
      artifactById.set(artifact.id, artifact);
      changed = true;
    }
    if (changed) {
      onArtifacts?.([...artifactById.values()]);
    }
  };

  const buildResult = (finalText: string): DesktopBridgeChatResult => ({
    text:
      finalText ||
      (artifactById.size > 0
        ? ""
        : "Stella finished, but did not return a message. Check the desktop app."),
    artifacts: [...artifactById.values()],
    userMessageId: submittedUserMessageId,
  });

  const finalizeSuccess = (result: DesktopBridgeChatResult) => {
    if (settled) return;
    settled = true;
    finalResult = result;
  };
  const finalizeError = (error: unknown) => {
    if (settled) return;
    settled = true;
    finalError = error;
  };

  const eventMatchesRun = (event: Record<string, unknown>) => {
    const eventConversationId = asString(event.conversationId);
    if (eventConversationId && eventConversationId !== conversationId) {
      return false;
    }
    const eventRequestId = asString(event.requestId);
    const eventRunId = asString(event.runId);
    if (requestId && eventRequestId && eventRequestId !== requestId) {
      return false;
    }
    if (runId && eventRunId && eventRunId !== runId) {
      return false;
    }
    return true;
  };

  const completeFromFinishedEvent = async (event: Record<string, unknown>) => {
    if (settled) return;
    const outcome = asString(event.outcome);
    const error = asString(event.error).trim() || asString(event.reason).trim();
    if (outcome === "canceled") {
      finalizeError(new BridgeAbortError());
      return;
    }
    if (error) {
      finalizeError(new Error(error));
      return;
    }
    let finalText = asString(event.finalText).trim();
    if (!finalText || artifactById.size === 0) {
      const latest = submittedUserMessageId
        ? await readAssistantMessageForTurn(
            activeBridge,
            conversationId,
            submittedUserMessageId,
          ).catch(() => null)
        : await readLatestAssistantMessage(activeBridge, conversationId).catch(
            () => null,
          );
      if (!finalText) {
        finalText = latest?.text.trim() ?? "";
      }
      mergeArtifacts(latest?.artifacts ?? []);
    }
    finalizeSuccess(buildResult(normalizeDesktopChatMessageText(finalText)));
  };

  // Process one agent event (live broadcast or replayed via agent:resume).
  // Resolves to true once the run reaches a terminal state. Seq-gating makes
  // replay idempotent against events we already saw live.
  const processAgentEvent = async (data: unknown): Promise<boolean> => {
    const event = asRecord(data);
    if (!event || !eventMatchesRun(event)) {
      return false;
    }
    const eventRequestId = asString(event.requestId);
    const eventRunId = asString(event.runId);
    const eventUserMessageId = asString(event.userMessageId);
    if (!requestId && eventRequestId) requestId = eventRequestId;
    if (!runId && eventRunId) runId = eventRunId;
    if (!submittedUserMessageId && eventUserMessageId) {
      submittedUserMessageId = eventUserMessageId;
    }
    if (eventRunId) runStarted = true;

    const seq = typeof event.seq === "number" ? event.seq : null;
    if (seq !== null) {
      if (seq <= lastSeq) return false;
      lastSeq = seq;
    }

    if (event.type === "agent-started") {
      const agentId = asString(event.agentId).trim();
      if (agentId) {
        const title =
          asString(event.description).trim() ||
          asString(event.groupLabel).trim() ||
          "Background work";
        mergeArtifacts([
          {
            id: agentWorkArtifactId([agentId]),
            conversationId,
            payload: {
              kind: "agent-work",
              state: "running",
              total: 1,
              completed: 0,
              title,
              subtitle: "Working in background",
              createdAt: Date.now(),
            },
          },
        ]);
      }
      return false;
    }

    if (event.type === "stream") {
      const chunk = asString(event.chunk);
      if (chunk) {
        onTextDelta?.(chunk);
        // Mark the run as streaming answer text so the indicator steps aside,
        // and clear any lingering run-level status (mirrors the desktop
        // `run-status: null` on STREAM).
        if (/\S/.test(chunk)) {
          activityStreamingText = true;
          activityStatusText = undefined;
          emitActivity();
        }
      }
      return false;
    }
    if (event.type === "tool-start") {
      const toolName = asString(event.toolName).trim() || "tool";
      const toolCallId = asString(event.toolCallId).trim();
      const statusText = asString(event.statusText).trim();
      const key = toolCallId || toolName;
      activityHasToolActivity = true;
      // The model stopped emitting text to run a tool; clear the streaming-text
      // flag so the post-tool reasoning gap shows the indicator again.
      activityStreamingText = false;
      if (statusText) activityStatusText = statusText;
      activeToolCalls.set(key, { toolName });
      emitActivity();
      return false;
    }
    if (event.type === "tool-end") {
      const toolName = asString(event.toolName).trim();
      const toolCallId = asString(event.toolCallId).trim();
      activityHasToolActivity = true;
      // Resolve the entry this end refers to, tolerant of a missing/renamed
      // id, so a phantom entry can't pin a tool active forever.
      let key = toolCallId && activeToolCalls.has(toolCallId)
        ? toolCallId
        : undefined;
      if (!key && toolName) {
        for (const [k, v] of activeToolCalls) {
          if (v.toolName === toolName) key = k;
        }
      }
      if (!key) key = [...activeToolCalls.keys()].at(-1);
      if (key) activeToolCalls.delete(key);
      if (activeToolCalls.size === 0) activityStatusText = undefined;
      emitActivity();
      return false;
    }
    if (event.type === "status") {
      // `provider-retry` is a transient reconnect notice on the desktop; don't
      // surface it as a working-indicator label.
      if (asString(event.statusState) !== "provider-retry") {
        const statusText = asString(event.statusText).trim();
        activityStatusText = statusText || undefined;
        emitActivity();
      }
      return false;
    }
    if (event.type === "run-finished") {
      await completeFromFinishedEvent(event);
      return true;
    }
    return false;
  };

  // Recover the final reply when the run completed while we were disconnected
  // and the desktop's event buffer no longer holds the terminal event.
  const recoverFinalFromDesktop = async (): Promise<boolean> => {
    if (settled) return true;
    if (!submittedUserMessageId) return false;
    const latest = await readAssistantMessageForTurn(
      activeBridge,
      conversationId,
      submittedUserMessageId,
    ).catch(() => null);
    if (!latest) return false;
    mergeArtifacts(latest?.artifacts ?? []);
    finalizeSuccess(
      buildResult(normalizeDesktopChatMessageText(latest?.text.trim() ?? "")),
    );
    return true;
  };

  const runConnection = async (
    isReconnect: boolean,
  ): Promise<ConnectionOutcome> => {
    let ws: WebSocket;
    try {
      ws = await openBridgeWebSocket(activeBridge, signal);
    } catch (error) {
      if (signal?.aborted) return { kind: "aborted" };
      return { kind: "disconnected" };
    }

    return await new Promise<ConnectionOutcome>((resolve) => {
      let outcomeSettled = false;
      let resuming = isReconnect;
      const pendingLive: unknown[] = [];
      let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
      let client: ReturnType<typeof createBridgeSocketClient>;

      const onAbort = () => finish({ kind: "aborted" });

      const finish = (outcome: ConnectionOutcome) => {
        if (outcomeSettled) return;
        outcomeSettled = true;
        if (inactivityTimer) clearTimeout(inactivityTimer);
        signal?.removeEventListener("abort", onAbort);
        if (
          (outcome.kind === "aborted" || outcome.kind === "timeout") &&
          runId
        ) {
          try {
            void client.invoke("agent:cancelChat", [runId]).catch(() => {});
          } catch {
            // best-effort cancellation
          }
        }
        client.close();
        resolve(outcome);
      };

      const bumpInactivity = () => {
        if (inactivityTimer) clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(
          () => finish({ kind: "timeout" }),
          BRIDGE_RUN_TIMEOUT_MS,
        );
      };

      const handleLiveAgentEvent = (data: unknown) => {
        bumpInactivity();
        if (resuming) {
          pendingLive.push(data);
          return;
        }
        void processAgentEvent(data).then((finished) => {
          if (finished) finish({ kind: "finished" });
        });
      };

      client = createBridgeSocketClient(
        ws,
        activeBridge.crypto,
        (channel, data) => {
          if (channel === "display:update") {
            mergeArtifacts(
              filterDesktopBridgeArtifacts(
                parseChatArtifacts([data], conversationId),
                activeBridge.includeDeveloperArtifacts,
              ),
            );
            return;
          }
          if (channel === "agent:event") {
            handleLiveAgentEvent(data);
          }
        },
        () => finish({ kind: "disconnected" }),
        { compress: bridgeSupportsDeflate(activeBridge) },
      );

      client.subscribe("agent:event");
      client.subscribe("display:update");
      signal?.addEventListener("abort", onAbort);
      bumpInactivity();

      void (async () => {
        try {
          if (!runStarted) {
            const startResult = asRecord(
              await client.invoke(
                "agent:startChat",
                [startChatArgs],
                BRIDGE_INVOKE_TIMEOUT_MS,
              ),
            );
            const startedRequestId = asString(startResult?.requestId).trim();
            if (startedRequestId) {
              requestId = requestId || startedRequestId;
              startIssued = true;
            }
            onStatus?.("running");
          }

          let activeRunId = "";
          if (isReconnect) {
            const resume = asRecord(
              await client.invoke(
                "agent:resume",
                [{ conversationId, lastSeq }],
                BRIDGE_SYNC_TIMEOUT_MS,
              ),
            );
            const activeRun = asRecord(resume?.activeRun);
            activeRunId = asString(activeRun?.runId).trim();
            if (activeRunId) {
              runId = runId || activeRunId;
              runStarted = true;
              const activeUserMessageId = asString(
                activeRun?.userMessageId,
              ).trim();
              if (!submittedUserMessageId && activeUserMessageId) {
                submittedUserMessageId = activeUserMessageId;
              }
            }
            const replayEvents = Array.isArray(resume?.events)
              ? resume.events
              : [];
            for (const replayEvent of replayEvents) {
              if (await processAgentEvent(replayEvent)) {
                finish({ kind: "finished" });
                return;
              }
            }
          }

          // Drain anything that arrived live while we were priming, in order,
          // before switching to direct live handling. Done inside the resuming
          // guard so no event can slip past unprocessed.
          while (pendingLive.length > 0) {
            const next = pendingLive.shift();
            if (await processAgentEvent(next)) {
              finish({ kind: "finished" });
              return;
            }
          }
          resuming = false;

          // On reconnect, if the desktop reports no active run and never
          // replayed a terminal event, the run finished while we were away.
          if (
            isReconnect &&
            !settled &&
            (runStarted || startIssued) &&
            !activeRunId
          ) {
            if (await recoverFinalFromDesktop()) {
              finish({ kind: "finished" });
              return;
            }
          }
        } catch (error) {
          if (signal?.aborted) {
            finish({ kind: "aborted" });
            return;
          }
          if (isDisconnectError(error)) {
            finish({ kind: "disconnected" });
            return;
          }
          finalizeError(error);
          finish({ kind: "fatal", error });
        }
      })();
    });
  };

  let attempt = 0;
  let isReconnect = false;
  while (!settled) {
    const outcome = await runConnection(isReconnect);
    if (settled || outcome.kind === "finished") {
      break;
    }
    if (outcome.kind === "aborted") {
      throw new BridgeAbortError();
    }
    if (outcome.kind === "fatal") {
      throw finalError ?? outcome.error;
    }
    if (outcome.kind === "timeout") {
      throw new Error("Stella did not reply in time. Try again in a moment.");
    }
    // disconnected → try to re-attach to the still-running desktop run.
    if (attempt >= BRIDGE_RECONNECT_MAX_ATTEMPTS) {
      await recoverFinalFromDesktop().catch(() => false);
      if (settled) break;
      throw new Error(
        "Lost the connection to your desktop. Keep Stella open and try again.",
      );
    }
    attempt += 1;
    isReconnect = true;
    const delay = Math.min(
      BRIDGE_RECONNECT_MAX_DELAY_MS,
      BRIDGE_RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1),
    );
    await sleep(delay);
    if (signal?.aborted) {
      throw new BridgeAbortError();
    }
    // Re-resolve in case the desktop rotated its tunnel URL or token while we
    // were away; force a fresh handshake so we never re-attach with a session
    // the desktop has already dropped. Fall back to the last good bridge if
    // discovery hiccups.
    activeBridge = await resolveDesktopBridge(access, undefined, {
      forceRefresh: true,
    }).catch(() => activeBridge);
  }

  if (finalError) {
    throw finalError;
  }
  if (!finalResult) {
    throw new Error("Stella did not return a response.");
  }
  return finalResult;
}
