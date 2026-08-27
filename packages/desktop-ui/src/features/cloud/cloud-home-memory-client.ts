import type {
  CloudMemoryDocument,
  CloudMemoryKind,
  CloudMemorySnapshot,
} from "@stella/contracts/cloud-home-sync";

const HTTP_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_MEMORY_DOCUMENTS = 100;
const MAX_MEMORY_EXPORT_BYTES = 2 * 1024 * 1024;
const MAX_TOKEN_CHARS = 16 * 1024;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const OWNER_GENERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u;
const SOURCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]+$/u;
const MEMORY_KINDS = [
  "memory",
  "profile",
  "memory_map",
  "core_memory",
  "personality",
  "imported_markdown",
  "user_markdown",
  "archive",
] as const;

export type DesktopCloudMemoryKind = CloudMemoryKind | "archive";

export type CloudHomeMemoryClientIdentity = Readonly<{
  accountScope: string;
  identityRevision: number;
  expectedSubject: string;
}>;

const KIND_MAX_BYTES: Record<DesktopCloudMemoryKind, number> = {
  memory: 256 * 1024,
  profile: 32 * 1024,
  memory_map: 32 * 1024,
  core_memory: 64 * 1024,
  personality: 64 * 1024,
  imported_markdown: 512 * 1024,
  user_markdown: 512 * 1024,
  archive: 512 * 1024,
};

const DOCUMENT_KEYS = new Set([
  "documentId",
  "name",
  "displayPath",
  "kind",
  "source",
  "revision",
  "versionId",
  "sha256",
  "sizeBytes",
  "updatedAt",
  "content",
]);
const SNAPSHOT_KEYS = new Set([
  "subject",
  "ownerGeneration",
  "memoryEpoch",
  "importDisposition",
  "lastWipedEpoch",
  "lastWipeCompletedAt",
  "documents",
]);

export class CloudHomeMemoryError extends Error {
  constructor(
    readonly code: "unavailable" | "unauthorized" | "invalid" | "network",
  ) {
    super("Cloud Home memory is unavailable.");
    this.name = "CloudHomeMemoryError";
  }
}

const invalid = (): never => {
  throw new CloudHomeMemoryError("invalid");
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnlyKeys = (
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean => Object.keys(value).every((key) => allowed.has(key));

const isSafeIntegerBetween = (
  value: unknown,
  minimum: number,
  maximum: number,
): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= minimum &&
  (value as number) <= maximum;

const utf8Bytes = (value: string): Uint8Array =>
  new TextEncoder().encode(value);

const hasControlCharacter = (value: string): boolean =>
  Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });

const sha256Hex = async (value: string): Promise<string> => {
  const encoded = utf8Bytes(value);
  const digestInput = new Uint8Array(encoded.byteLength);
  digestInput.set(encoded);
  const digest = await crypto.subtle.digest("SHA-256", digestInput.buffer);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

const normalizedToken = (
  value: unknown,
  pattern: RegExp,
  maxChars: number,
): string => {
  if (typeof value !== "string") return invalid();
  const normalized = value.normalize("NFC").trim();
  if (
    !normalized ||
    normalized !== value ||
    normalized.length > maxChars ||
    !pattern.test(normalized)
  ) {
    return invalid();
  }
  return normalized;
};

const normalizeMemoryName = (value: unknown): string => {
  if (typeof value !== "string") return invalid();
  const normalized = value.normalize("NFC").trim().replace(/^\.\//u, "");
  if (
    !normalized ||
    normalized.length > 240 ||
    normalized.startsWith("/") ||
    normalized.endsWith("/") ||
    normalized.includes("\\") ||
    hasControlCharacter(normalized)
  ) {
    return invalid();
  }
  const segments = normalized.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.startsWith(".") ||
        segment.length > 96,
    ) ||
    !normalized.toLocaleLowerCase().endsWith(".md")
  ) {
    return invalid();
  }
  const canonical =
    normalized === "MEMORY.md" ||
    normalized === "memories/profile.md" ||
    normalized === "memories/memory_map.md" ||
    normalized === "core-memory.md" ||
    normalized === "PERSONALITY.md";
  const imported = normalized.startsWith("imports/") && segments.length >= 3;
  const userMarkdown = normalized.startsWith("markdown/");
  const archive = normalized.startsWith("archive/");
  if (!canonical && !imported && !userMarkdown && !archive) return invalid();
  return normalized;
};

const expectedKindForName = (name: string): DesktopCloudMemoryKind => {
  if (name === "MEMORY.md") return "memory";
  if (name === "memories/profile.md") return "profile";
  if (name === "memories/memory_map.md") return "memory_map";
  if (name === "core-memory.md") return "core_memory";
  if (name === "PERSONALITY.md") return "personality";
  if (name.startsWith("imports/")) return "imported_markdown";
  if (name.startsWith("markdown/")) return "user_markdown";
  if (name.startsWith("archive/")) return "archive";
  return invalid();
};

const expectedDisplayPath = (name: string): string =>
  name === "MEMORY.md"
    ? "~/.stella/memories/MEMORY.md"
    : name.startsWith("archive/")
      ? `~/.stella/memories/${name}`
      : `~/.stella/${name}`;

const isMemoryKind = (value: unknown): value is DesktopCloudMemoryKind =>
  typeof value === "string" &&
  (MEMORY_KINDS as readonly string[]).includes(value);

const normalizedIdentity = (
  value: CloudHomeMemoryClientIdentity,
): CloudHomeMemoryClientIdentity => {
  const accountScope = value.accountScope.trim();
  const expectedSubject = value.expectedSubject.trim();
  if (
    !accountScope ||
    accountScope !== value.accountScope ||
    accountScope.length > 512 ||
    hasControlCharacter(accountScope) ||
    !expectedSubject ||
    expectedSubject !== value.expectedSubject ||
    expectedSubject.length > 1_024 ||
    hasControlCharacter(expectedSubject) ||
    !isSafeIntegerBetween(value.identityRevision, 0, Number.MAX_SAFE_INTEGER)
  ) {
    return invalid();
  }
  return Object.freeze({
    accountScope,
    identityRevision: value.identityRevision,
    expectedSubject,
  });
};

const identitiesMatch = (
  left: CloudHomeMemoryClientIdentity,
  right: CloudHomeMemoryClientIdentity,
): boolean =>
  left.accountScope === right.accountScope &&
  left.identityRevision === right.identityRevision &&
  left.expectedSubject === right.expectedSubject;

export const decodeCloudMemorySnapshot = async (
  value: unknown,
  expectedSubject: string,
): Promise<CloudMemorySnapshot> => {
  if (!isRecord(value) || !hasOnlyKeys(value, SNAPSHOT_KEYS)) return invalid();
  const subject = expectedSubject.trim();
  if (
    !subject ||
    subject !== expectedSubject ||
    subject.length > 1_024 ||
    subject.normalize("NFC") !== subject ||
    hasControlCharacter(subject) ||
    value.subject !== subject ||
    !Array.isArray(value.documents) ||
    value.documents.length > MAX_MEMORY_DOCUMENTS
  ) {
    return invalid();
  }
  const ownerGeneration = normalizedToken(
    value.ownerGeneration,
    OWNER_GENERATION_PATTERN,
    512,
  );
  const memoryEpoch = normalizedToken(
    value.memoryEpoch,
    OWNER_GENERATION_PATTERN,
    512,
  );
  if (
    value.importDisposition !== "automatic_allowed" &&
    value.importDisposition !== "explicit_required" &&
    value.importDisposition !== "explicit_allowed"
  ) {
    return invalid();
  }
  const lastWipedEpoch =
    value.lastWipedEpoch === undefined
      ? undefined
      : normalizedToken(value.lastWipedEpoch, OWNER_GENERATION_PATTERN, 512);
  if (
    value.lastWipeCompletedAt !== undefined &&
    !isSafeIntegerBetween(value.lastWipeCompletedAt, 0, MAX_TIMESTAMP_MS)
  ) {
    return invalid();
  }
  const names = new Set<string>();
  const documentIds = new Set<string>();
  const versionIds = new Set<string>();
  let totalContentBytes = 0;
  const documents: CloudMemoryDocument[] = [];
  for (const candidate of value.documents) {
    if (!isRecord(candidate) || !hasOnlyKeys(candidate, DOCUMENT_KEYS)) {
      return invalid();
    }
    const documentId = normalizedToken(
      candidate.documentId,
      OPAQUE_ID_PATTERN,
      128,
    );
    const name = normalizeMemoryName(candidate.name);
    if (candidate.name !== name || !isMemoryKind(candidate.kind)) {
      return invalid();
    }
    const kind = candidate.kind;
    if (
      typeof candidate.displayPath !== "string" ||
      candidate.displayPath.length > 320 ||
      candidate.displayPath.normalize("NFC") !== candidate.displayPath ||
      candidate.displayPath !== expectedDisplayPath(name) ||
      kind !== expectedKindForName(name)
    ) {
      return invalid();
    }
    const source = normalizedToken(candidate.source, SOURCE_PATTERN, 120);
    if (
      !isSafeIntegerBetween(candidate.revision, 0, Number.MAX_SAFE_INTEGER) ||
      !isSafeIntegerBetween(candidate.sizeBytes, 0, KIND_MAX_BYTES[kind]) ||
      !isSafeIntegerBetween(candidate.updatedAt, 0, MAX_TIMESTAMP_MS) ||
      typeof candidate.content !== "string"
    ) {
      return invalid();
    }
    const contentBytes = utf8Bytes(candidate.content).byteLength;
    totalContentBytes += contentBytes;
    if (
      contentBytes !== candidate.sizeBytes ||
      totalContentBytes > MAX_MEMORY_EXPORT_BYTES
    ) {
      return invalid();
    }
    const versionId =
      candidate.versionId === undefined
        ? undefined
        : normalizedToken(candidate.versionId, OPAQUE_ID_PATTERN, 128);
    const digest =
      candidate.sha256 === undefined
        ? undefined
        : normalizedToken(candidate.sha256, SHA256_PATTERN, 64);
    if (digest && digest !== (await sha256Hex(candidate.content))) {
      return invalid();
    }
    if (
      names.has(name) ||
      documentIds.has(documentId) ||
      (versionId !== undefined && versionIds.has(versionId))
    ) {
      return invalid();
    }
    names.add(name);
    documentIds.add(documentId);
    if (versionId) versionIds.add(versionId);
    documents.push({
      documentId,
      name,
      displayPath: candidate.displayPath,
      kind,
      source,
      revision: candidate.revision,
      ...(versionId ? { versionId } : {}),
      ...(digest ? { sha256: digest } : {}),
      sizeBytes: candidate.sizeBytes,
      updatedAt: candidate.updatedAt,
      content: candidate.content,
    });
  }
  return {
    ownerGeneration,
    memoryEpoch,
    importDisposition: value.importDisposition,
    ...(lastWipedEpoch ? { lastWipedEpoch } : {}),
    ...(value.lastWipeCompletedAt === undefined
      ? {}
      : { lastWipeCompletedAt: value.lastWipeCompletedAt }),
    documents,
  };
};

const validatedOrigin = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CloudHomeMemoryError("unavailable");
  }
  const local =
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (
    (url.protocol !== "https:" && !local) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new CloudHomeMemoryError("unavailable");
  }
  return url.origin;
};

const readBoundedText = async (
  response: Response,
  signal: AbortSignal,
): Promise<string> => {
  const declaredHeader = response.headers.get("content-length");
  if (declaredHeader !== null) {
    const declaredLength = Number(declaredHeader);
    if (
      !Number.isSafeInteger(declaredLength) ||
      declaredLength < 0 ||
      declaredLength > MAX_RESPONSE_BYTES
    ) {
      return invalid();
    }
  }
  if (!response.body) {
    const text = await response.text();
    if (utf8Bytes(text).byteLength > MAX_RESPONSE_BYTES) return invalid();
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  const interrupt = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", interrupt, { once: true });
  try {
    if (signal.aborted) throw new CloudHomeMemoryError("network");
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new CloudHomeMemoryError("network");
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return invalid();
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    signal.removeEventListener("abort", interrupt);
    reader.releaseLock();
  }
};

type RequestResult = { ok: boolean; status: number; body: unknown };

export type CloudMemoryDocumentWriteAttempt = Readonly<{
  identity: CloudHomeMemoryClientIdentity;
  ownerGeneration: string;
  memoryEpoch: string;
  name: string;
  kind: DesktopCloudMemoryKind;
  source: "desktop_user";
  writer: "user_edit";
  expectedRevision: number;
  content: string;
  idempotencyKey: string;
}>;

export const beginCloudMemoryDocumentWrite = (args: {
  identity: CloudHomeMemoryClientIdentity;
  ownerGeneration: string;
  memoryEpoch: string;
  document: CloudMemoryDocument;
  content: string;
  createEntropy?: () => string;
}): CloudMemoryDocumentWriteAttempt => {
  const name = normalizeMemoryName(args.document.name);
  if (
    args.document.kind !== expectedKindForName(name) ||
    !isSafeIntegerBetween(
      args.document.revision,
      0,
      Number.MAX_SAFE_INTEGER - 1,
    ) ||
    typeof args.content !== "string" ||
    utf8Bytes(args.content).byteLength < 1 ||
    utf8Bytes(args.content).byteLength >
      KIND_MAX_BYTES[args.document.kind as DesktopCloudMemoryKind]
  ) {
    return invalid();
  }
  const entropy = (args.createEntropy ?? (() => crypto.randomUUID()))();
  const idempotencyKey = `desktop-memory-edit:${entropy}`;
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) return invalid();
  const identity = normalizedIdentity(args.identity);
  const ownerGeneration = normalizedToken(
    args.ownerGeneration,
    OWNER_GENERATION_PATTERN,
    512,
  );
  const memoryEpoch = normalizedToken(
    args.memoryEpoch,
    OWNER_GENERATION_PATTERN,
    512,
  );
  return Object.freeze({
    identity,
    ownerGeneration,
    memoryEpoch,
    name,
    kind: args.document.kind as DesktopCloudMemoryKind,
    source: "desktop_user",
    writer: "user_edit",
    expectedRevision: args.document.revision,
    content: args.content,
    idempotencyKey,
  });
};

export type CloudHomeMemoryClient = {
  listMemory: () => Promise<CloudMemorySnapshot>;
  readMemory: (name: string) => Promise<CloudMemoryDocument | null>;
  writeMemory: (
    attempt: CloudMemoryDocumentWriteAttempt,
  ) => Promise<
    | { status: "committed"; document: CloudMemoryDocument }
    | { status: "conflict"; document: CloudMemoryDocument | null }
  >;
};

export const createCloudHomeMemoryClient = (options: {
  builderOrigin: string;
  fetch?: typeof fetch;
  identity: CloudHomeMemoryClientIdentity;
  getCurrentIdentity: () => CloudHomeMemoryClientIdentity | null;
  getTokenForSubject: (expectedSubject: string) => Promise<string>;
}): CloudHomeMemoryClient => {
  const origin = validatedOrigin(options.builderOrigin);
  const fetchImpl = options.fetch ?? fetch;
  const identity = normalizedIdentity(options.identity);

  const assertCurrentIdentity = (): void => {
    try {
      const current = options.getCurrentIdentity();
      if (!current || !identitiesMatch(identity, normalizedIdentity(current))) {
        throw new Error("stale identity");
      }
    } catch {
      throw new CloudHomeMemoryError("unauthorized");
    }
  };

  const request = async (
    path: string,
    init: { method: "GET" | "POST"; body?: unknown },
  ): Promise<RequestResult> => {
    assertCurrentIdentity();
    let token: string;
    try {
      token = (
        await options.getTokenForSubject(identity.expectedSubject)
      ).trim();
    } catch {
      throw new CloudHomeMemoryError("unauthorized");
    }
    assertCurrentIdentity();
    if (
      !token ||
      token.length > MAX_TOKEN_CHARS ||
      !TOKEN_PATTERN.test(token)
    ) {
      throw new CloudHomeMemoryError("unauthorized");
    }
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(
      () => controller.abort(),
      HTTP_TIMEOUT_MS,
    );
    try {
      const response = await fetchImpl(`${origin}${path}`, {
        method: init.method,
        redirect: "error",
        headers: {
          authorization: `Bearer ${token}`,
          "x-stella-expected-subject": identity.expectedSubject,
          ...(init.method === "POST"
            ? { "content-type": "application/json" }
            : {}),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: controller.signal,
      });
      assertCurrentIdentity();
      const text = await readBoundedText(response, controller.signal);
      assertCurrentIdentity();
      let body: unknown = null;
      if (text) {
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          if (response.ok) return invalid();
        }
      }
      assertCurrentIdentity();
      return { ok: response.ok, status: response.status, body };
    } catch (error) {
      if (error instanceof CloudHomeMemoryError) throw error;
      throw new CloudHomeMemoryError("network");
    } finally {
      globalThis.clearTimeout(timeout);
    }
  };

  const listMemory = async (): Promise<CloudMemorySnapshot> => {
    const response = await request("/cloud-home/memory", { method: "GET" });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new CloudHomeMemoryError("unauthorized");
      }
      if (
        response.status === 404 ||
        response.status === 409 ||
        response.status === 503
      ) {
        throw new CloudHomeMemoryError("unavailable");
      }
      throw new CloudHomeMemoryError(
        response.status >= 400 && response.status < 500 ? "invalid" : "network",
      );
    }
    const snapshot = await decodeCloudMemorySnapshot(
      response.body,
      identity.expectedSubject,
    );
    assertCurrentIdentity();
    return snapshot;
  };

  const readMemory = async (
    name: string,
  ): Promise<CloudMemoryDocument | null> => {
    const normalized = normalizeMemoryName(name);
    const snapshot = await listMemory();
    const document =
      snapshot.documents.find((document) => document.name === normalized) ??
      null;
    assertCurrentIdentity();
    return document;
  };

  const writeMemory = async (
    attempt: CloudMemoryDocumentWriteAttempt,
  ): ReturnType<CloudHomeMemoryClient["writeMemory"]> => {
    if (!identitiesMatch(identity, attempt.identity)) {
      throw new CloudHomeMemoryError("unauthorized");
    }
    assertCurrentIdentity();
    const expectedDigest = await sha256Hex(attempt.content);
    assertCurrentIdentity();
    let response: RequestResult | null = null;
    try {
      response = await request("/cloud-home/memory/write", {
        method: "POST",
        body: {
          expectedOwnerGeneration: attempt.ownerGeneration,
          expectedMemoryEpoch: attempt.memoryEpoch,
          name: attempt.name,
          kind: attempt.kind,
          source: attempt.source,
          writer: attempt.writer,
          expectedRevision: attempt.expectedRevision,
          content: attempt.content,
          idempotencyKey: attempt.idempotencyKey,
        },
      });
    } catch (error) {
      if (
        error instanceof CloudHomeMemoryError &&
        (error.code === "unauthorized" || error.code === "unavailable")
      ) {
        throw error;
      }
      // A transport can fail after commit. Only the exact authoritative reread
      // below is allowed to report success.
    }
    if (response && !response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new CloudHomeMemoryError("unauthorized");
      }
      if (
        response.status === 400 ||
        response.status === 413 ||
        response.status === 422
      ) {
        throw new CloudHomeMemoryError("invalid");
      }
      if (response.status === 404 || response.status === 503) {
        throw new CloudHomeMemoryError("unavailable");
      }
    }
    const snapshot = await listMemory();
    assertCurrentIdentity();
    if (
      snapshot.ownerGeneration !== attempt.ownerGeneration ||
      snapshot.memoryEpoch !== attempt.memoryEpoch
    ) {
      throw new CloudHomeMemoryError("unavailable");
    }
    const document =
      snapshot.documents.find((candidate) => candidate.name === attempt.name) ??
      null;
    if (
      document?.sha256 === expectedDigest &&
      document.revision === attempt.expectedRevision + 1
    ) {
      assertCurrentIdentity();
      return { status: "committed", document };
    }
    assertCurrentIdentity();
    return { status: "conflict", document };
  };

  return { listMemory, readMemory, writeMemory };
};

export const cloudMemoryDownloadPayload = (
  document: CloudMemoryDocument,
): { suggestedName: string; content: string } => ({
  suggestedName: normalizeMemoryName(document.name).split("/").at(-1)!,
  content: document.content,
});
