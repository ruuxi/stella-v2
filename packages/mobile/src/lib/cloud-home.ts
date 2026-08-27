import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

const HTTP_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_MEMORY_DOCUMENTS = 100;
const MAX_MEMORY_EXPORT_BYTES = 2 * 1024 * 1024;
const MAX_OWNER_GENERATION_CHARS = 512;
const MAX_IDENTITY_CHARS = 1_024;
const MAX_DOCUMENT_NAME_CHARS = 240;
const MAX_DISPLAY_PATH_CHARS = 320;
const MAX_SOURCE_CHARS = 120;
const MAX_TOKEN_CHARS = 16 * 1024;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const OWNER_GENERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u;
const SOURCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]+$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

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

export type MobileCloudMemoryKind = (typeof MEMORY_KINDS)[number];
export type MobileCloudMemoryWriter = "mobile_sync" | "user_edit";

/** Locator-free public document returned by the Cloud Home user plane. */
export type MobileCloudMemoryDocument = {
  documentId: string;
  name: string;
  displayPath: string;
  kind: MobileCloudMemoryKind;
  source: string;
  revision: number;
  versionId?: string;
  sha256?: string;
  sizeBytes: number;
  updatedAt: number;
  content: string;
};

export type MobileCloudMemorySnapshot = {
  subject: string;
  ownerGeneration: string;
  memoryEpoch: string;
  importDisposition: MobileCloudMemoryImportDisposition;
  lastWipedEpoch?: string;
  lastWipeCompletedAt?: number;
  documents: MobileCloudMemoryDocument[];
};

export type MobileCloudMemoryImportDisposition =
  | "automatic_allowed"
  | "explicit_required"
  | "explicit_allowed";

export type MobileCloudMemoryAuthority = Readonly<
  Pick<
    MobileCloudMemorySnapshot,
    "subject" | "ownerGeneration" | "memoryEpoch" | "importDisposition"
  >
>;

export type MobileCloudMemoryReadResult = Readonly<{
  authority: MobileCloudMemoryAuthority;
  document: MobileCloudMemoryDocument | null;
}>;

export type MobileCloudHomeClientIdentity = Readonly<{
  accountScope: string;
  identityKey: string;
  identityRevision: number;
  /** Exact issuer-qualified tokenIdentifier echoed by the Cloud Home worker. */
  expectedSubject: string;
}>;

const KIND_MAX_BYTES: Record<MobileCloudMemoryKind, number> = {
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
const AUTHORITY_KEYS = new Set([
  "subject",
  "ownerGeneration",
  "memoryEpoch",
  "importDisposition",
]);

export type MobileCloudMemoryWrite = {
  authority: MobileCloudMemoryAuthority;
  name: string;
  kind: MobileCloudMemoryKind;
  content: string;
  expectedRevision: number;
  source?: string;
  writer?: MobileCloudMemoryWriter;
  idempotencyKey?: string;
};

export type MobileCloudMemoryWriteResult =
  | { status: "committed"; document: MobileCloudMemoryDocument }
  | { status: "conflict"; document: MobileCloudMemoryDocument | null };

/** Content-free rows suitable for a mobile Settings list. */
export type MobileCloudMemorySummary = Pick<
  MobileCloudMemoryDocument,
  "name" | "displayPath" | "kind" | "revision" | "sizeBytes" | "updatedAt"
>;

export const summarizeCloudMemory = (
  snapshot: MobileCloudMemorySnapshot,
): MobileCloudMemorySummary[] =>
  snapshot.documents.map(
    ({ name, displayPath, kind, revision, sizeBytes, updatedAt }) => ({
      name,
      displayPath,
      kind,
      revision,
      sizeBytes,
      updatedAt,
    }),
  );

export type MobileCloudHomeClient = {
  listMemory: () => Promise<MobileCloudMemorySnapshot>;
  readMemory: (name: string) => Promise<MobileCloudMemoryReadResult>;
  writeMemory: (
    input: MobileCloudMemoryWrite,
  ) => Promise<MobileCloudMemoryWriteResult>;
};

type MobileCloudHomeFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class MobileCloudHomeError extends Error {
  constructor(
    readonly code: "unavailable" | "unauthorized" | "invalid" | "network",
  ) {
    super(
      code === "unauthorized"
        ? "Sign in again to access Cloud Home."
        : code === "invalid"
          ? "Cloud Home returned an invalid response."
          : code === "unavailable"
            ? "Cloud Home is not available for this account right now."
            : "Cloud Home could not be reached. Try again.",
    );
    this.name = "MobileCloudHomeError";
  }
}

const invalid = (): never => {
  throw new MobileCloudHomeError("invalid");
};

const validatedOrigin = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MobileCloudHomeError("unavailable");
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
    throw new MobileCloudHomeError("unavailable");
  }
  return url.origin;
};

const hasExactKeys = (
  row: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean => Object.keys(row).every((key) => allowed.has(key));

const isMemoryKind = (value: unknown): value is MobileCloudMemoryKind =>
  typeof value === "string" &&
  (MEMORY_KINDS as readonly string[]).includes(value);

const isSafeIntegerBetween = (
  value: unknown,
  minimum: number,
  maximum: number,
): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= minimum &&
  (value as number) <= maximum;

const normalizedToken = (
  value: unknown,
  pattern: RegExp,
  maxChars: number,
): string => {
  if (typeof value !== "string") {
    throw new MobileCloudHomeError("invalid");
  }
  const normalized = value.normalize("NFC").trim();
  if (
    !normalized ||
    normalized.length > maxChars ||
    normalized !== value ||
    !pattern.test(normalized)
  ) {
    invalid();
  }
  return normalized;
};

const normalizedIdentityValue = (value: unknown): string => {
  if (typeof value !== "string") return invalid();
  const normalized = value.normalize("NFC");
  if (
    !normalized ||
    normalized !== value ||
    normalized.trim() !== normalized ||
    normalized.length > MAX_IDENTITY_CHARS ||
    CONTROL_CHARACTER_PATTERN.test(normalized)
  ) {
    invalid();
  }
  return normalized;
};

const normalizedClientIdentity = (
  value: MobileCloudHomeClientIdentity,
): MobileCloudHomeClientIdentity => {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  if (
    !Number.isSafeInteger(value.identityRevision) ||
    value.identityRevision < 0
  ) {
    invalid();
  }
  return Object.freeze({
    accountScope: normalizedIdentityValue(value.accountScope),
    identityKey: normalizedIdentityValue(value.identityKey),
    identityRevision: value.identityRevision,
    expectedSubject: normalizedIdentityValue(value.expectedSubject),
  });
};

const identitiesMatch = (
  left: MobileCloudHomeClientIdentity,
  right: MobileCloudHomeClientIdentity,
): boolean =>
  left.accountScope === right.accountScope &&
  left.identityKey === right.identityKey &&
  left.identityRevision === right.identityRevision &&
  left.expectedSubject === right.expectedSubject;

const normalizeMemoryName = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new MobileCloudHomeError("invalid");
  }
  const normalized = value.normalize("NFC").trim().replace(/^\.\//u, "");
  if (
    !normalized ||
    normalized.length > MAX_DOCUMENT_NAME_CHARS ||
    normalized.startsWith("/") ||
    normalized.endsWith("/") ||
    normalized.includes("\\") ||
    CONTROL_CHARACTER_PATTERN.test(normalized)
  ) {
    invalid();
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
    invalid();
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
  if (!canonical && !imported && !userMarkdown && !archive) invalid();
  return normalized;
};

const expectedKindForName = (name: string): MobileCloudMemoryKind => {
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

const parseSnapshot = (
  value: unknown,
  expectedSubject: string,
): MobileCloudMemorySnapshot => {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  const rawDocuments = row.documents;
  const subject = normalizedIdentityValue(row.subject);
  if (
    !hasExactKeys(row, SNAPSHOT_KEYS) ||
    subject !== expectedSubject ||
    !Array.isArray(rawDocuments) ||
    rawDocuments.length > MAX_MEMORY_DOCUMENTS
  ) {
    throw new MobileCloudHomeError("invalid");
  }
  const ownerGeneration = normalizedToken(
    row.ownerGeneration,
    OWNER_GENERATION_PATTERN,
    MAX_OWNER_GENERATION_CHARS,
  );
  const memoryEpoch = normalizedToken(
    row.memoryEpoch,
    OWNER_GENERATION_PATTERN,
    MAX_OWNER_GENERATION_CHARS,
  );
  const importDisposition =
    row.importDisposition === "automatic_allowed" ||
    row.importDisposition === "explicit_required" ||
    row.importDisposition === "explicit_allowed"
      ? row.importDisposition
      : invalid();
  const lastWipedEpoch =
    row.lastWipedEpoch === undefined
      ? undefined
      : normalizedToken(
          row.lastWipedEpoch,
          OWNER_GENERATION_PATTERN,
          MAX_OWNER_GENERATION_CHARS,
        );
  const lastWipeCompletedAt =
    row.lastWipeCompletedAt === undefined
      ? undefined
      : isSafeIntegerBetween(row.lastWipeCompletedAt, 0, MAX_TIMESTAMP_MS)
        ? row.lastWipeCompletedAt
        : invalid();
  const names = new Set<string>();
  const documentIds = new Set<string>();
  const versionIds = new Set<string>();
  let totalContentBytes = 0;
  const documents = rawDocuments.map(
    (candidate: unknown): MobileCloudMemoryDocument => {
      if (
        !candidate ||
        typeof candidate !== "object" ||
        Array.isArray(candidate)
      ) {
        return invalid();
      }
      const document = candidate as Record<string, unknown>;
      if (!hasExactKeys(document, DOCUMENT_KEYS)) invalid();
      const documentId = normalizedToken(
        document.documentId,
        OPAQUE_ID_PATTERN,
        128,
      );
      const rawName = document.name;
      const name = normalizeMemoryName(rawName);
      const rawKind = document.kind;
      if (rawName !== name || !isMemoryKind(rawKind)) {
        throw new MobileCloudHomeError("invalid");
      }
      const kind = rawKind;
      const rawDisplayPath = document.displayPath;
      if (
        typeof rawDisplayPath !== "string" ||
        rawDisplayPath.length > MAX_DISPLAY_PATH_CHARS ||
        rawDisplayPath !== rawDisplayPath.normalize("NFC") ||
        rawDisplayPath !== expectedDisplayPath(name) ||
        expectedKindForName(name) !== kind
      ) {
        throw new MobileCloudHomeError("invalid");
      }
      const displayPath = rawDisplayPath;
      const source = normalizedToken(
        document.source,
        SOURCE_PATTERN,
        MAX_SOURCE_CHARS,
      );
      const rawRevision = document.revision;
      if (!isSafeIntegerBetween(rawRevision, 0, Number.MAX_SAFE_INTEGER)) {
        throw new MobileCloudHomeError("invalid");
      }
      const revision = rawRevision;
      const rawSizeBytes = document.sizeBytes;
      const rawUpdatedAt = document.updatedAt;
      const rawContent = document.content;
      if (
        !isSafeIntegerBetween(rawSizeBytes, 0, KIND_MAX_BYTES[kind]) ||
        !isSafeIntegerBetween(rawUpdatedAt, 0, MAX_TIMESTAMP_MS) ||
        typeof rawContent !== "string"
      ) {
        throw new MobileCloudHomeError("invalid");
      }
      const sizeBytes = rawSizeBytes;
      const updatedAt = rawUpdatedAt;
      const content = rawContent;
      const contentBytes = utf8ToBytes(content).byteLength;
      totalContentBytes += contentBytes;
      if (
        contentBytes !== sizeBytes ||
        contentBytes > KIND_MAX_BYTES[kind] ||
        totalContentBytes > MAX_MEMORY_EXPORT_BYTES
      ) {
        invalid();
      }
      let versionId: string | undefined;
      if (document.versionId !== undefined) {
        versionId = normalizedToken(document.versionId, OPAQUE_ID_PATTERN, 128);
      }
      let digest: string | undefined;
      if (document.sha256 !== undefined) {
        digest = normalizedToken(document.sha256, SHA256_PATTERN, 64);
        if (digest !== bytesToHex(sha256(utf8ToBytes(content)))) invalid();
      }
      if (
        names.has(name) ||
        documentIds.has(documentId) ||
        (versionId !== undefined && versionIds.has(versionId))
      ) {
        invalid();
      }
      names.add(name);
      documentIds.add(documentId);
      if (versionId) versionIds.add(versionId);
      return {
        documentId,
        name,
        displayPath,
        kind,
        source,
        revision,
        ...(versionId ? { versionId } : {}),
        ...(digest ? { sha256: digest } : {}),
        sizeBytes,
        updatedAt,
        content,
      };
    },
  );
  return {
    subject,
    ownerGeneration,
    memoryEpoch,
    importDisposition,
    ...(lastWipedEpoch ? { lastWipedEpoch } : {}),
    ...(lastWipeCompletedAt !== undefined ? { lastWipeCompletedAt } : {}),
    documents,
  };
};

const contentSha256 = (content: string): string =>
  bytesToHex(sha256(utf8ToBytes(content)));

const normalizeMemoryAuthority = (
  value: unknown,
): MobileCloudMemoryAuthority => {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== AUTHORITY_KEYS.size ||
    !hasExactKeys(row, AUTHORITY_KEYS)
  ) {
    invalid();
  }
  const importDisposition =
    row.importDisposition === "automatic_allowed" ||
    row.importDisposition === "explicit_required" ||
    row.importDisposition === "explicit_allowed"
      ? row.importDisposition
      : invalid();
  return Object.freeze({
    subject: normalizedIdentityValue(row.subject),
    ownerGeneration: normalizedToken(
      row.ownerGeneration,
      OWNER_GENERATION_PATTERN,
      MAX_OWNER_GENERATION_CHARS,
    ),
    memoryEpoch: normalizedToken(
      row.memoryEpoch,
      OWNER_GENERATION_PATTERN,
      MAX_OWNER_GENERATION_CHARS,
    ),
    importDisposition,
  });
};

const authorityFromSnapshot = (
  snapshot: MobileCloudMemorySnapshot,
): MobileCloudMemoryAuthority =>
  Object.freeze({
    subject: snapshot.subject,
    ownerGeneration: snapshot.ownerGeneration,
    memoryEpoch: snapshot.memoryEpoch,
    importDisposition: snapshot.importDisposition,
  });

type NormalizedWrite = {
  authority: MobileCloudMemoryAuthority;
  name: string;
  kind: MobileCloudMemoryKind;
  content: string;
  expectedRevision: number;
  source: string;
  writer: MobileCloudMemoryWriter;
  idempotencyKey: string;
};

const defaultIdempotencyKey = (
  input: Omit<NormalizedWrite, "idempotencyKey">,
): string =>
  `mobile-memory-${bytesToHex(
    sha256(
      utf8ToBytes(
        `${input.authority.subject}\0${input.authority.ownerGeneration}\0${input.authority.memoryEpoch}\0${input.name}\0${input.kind}\0${input.source}\0${input.writer}\0${input.expectedRevision}\0${contentSha256(input.content)}`,
      ),
    ),
  ).slice(0, 48)}`;

const normalizeWrite = (input: MobileCloudMemoryWrite): NormalizedWrite => {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid();
  const authority = normalizeMemoryAuthority(input.authority);
  const name = normalizeMemoryName(input.name);
  if (!isMemoryKind(input.kind) || expectedKindForName(name) !== input.kind) {
    invalid();
  }
  if (
    typeof input.content !== "string" ||
    !isSafeIntegerBetween(
      input.expectedRevision,
      0,
      Number.MAX_SAFE_INTEGER - 1,
    )
  ) {
    invalid();
  }
  const contentBytes = utf8ToBytes(input.content).byteLength;
  if (contentBytes < 1 || contentBytes > KIND_MAX_BYTES[input.kind]) invalid();
  const rawSource = input.source ?? "mobile_user";
  if (typeof rawSource !== "string") invalid();
  const source = rawSource.normalize("NFC").trim();
  if (!SOURCE_PATTERN.test(source) || source.length > MAX_SOURCE_CHARS)
    invalid();
  const writer = input.writer ?? "user_edit";
  if (writer !== "mobile_sync" && writer !== "user_edit") invalid();
  const basis = {
    authority,
    name,
    kind: input.kind,
    content: input.content,
    expectedRevision: input.expectedRevision,
    source,
    writer,
  };
  const rawIdempotencyKey = input.idempotencyKey;
  const idempotencyKey =
    rawIdempotencyKey === undefined
      ? defaultIdempotencyKey(basis)
      : typeof rawIdempotencyKey === "string"
        ? rawIdempotencyKey.normalize("NFC").trim()
        : invalid();
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) invalid();
  return { ...basis, idempotencyKey };
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
      throw new MobileCloudHomeError("invalid");
    }
  }
  if (!response.body) {
    const text = await response.text();
    if (utf8ToBytes(text).byteLength > MAX_RESPONSE_BYTES) {
      throw new MobileCloudHomeError("invalid");
    }
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  const interrupt = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", interrupt, { once: true });
  try {
    if (signal.aborted) throw new MobileCloudHomeError("network");
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new MobileCloudHomeError("network");
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new MobileCloudHomeError("invalid");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    signal.removeEventListener("abort", interrupt);
    reader.releaseLock();
  }
};

const responseError = (status: number): MobileCloudHomeError =>
  status === 401 || status === 403
    ? new MobileCloudHomeError("unauthorized")
    : status === 404 || status === 409 || status === 503
      ? new MobileCloudHomeError("unavailable")
      : status >= 400 && status < 500
        ? new MobileCloudHomeError("invalid")
        : new MobileCloudHomeError("network");

export const createMobileCloudHomeClient = (options: {
  builderOrigin: string;
  fetch?: MobileCloudHomeFetch;
  identity: MobileCloudHomeClientIdentity;
  getCurrentIdentity: () => MobileCloudHomeClientIdentity | null;
  getToken: () => Promise<string>;
}): MobileCloudHomeClient => {
  const origin = validatedOrigin(options.builderOrigin);
  const fetchImpl: MobileCloudHomeFetch = options.fetch ?? fetch;
  const tokenLoader = options.getToken;
  const identity = normalizedClientIdentity(options.identity);

  const assertCurrentIdentity = (): void => {
    try {
      const current = options.getCurrentIdentity();
      if (
        !current ||
        !identitiesMatch(identity, normalizedClientIdentity(current))
      ) {
        throw new Error("stale Cloud Home identity");
      }
    } catch {
      throw new MobileCloudHomeError("unauthorized");
    }
  };

  const request = async (
    path: string,
    init: { method: "GET" | "POST"; body?: unknown },
  ): Promise<{ ok: boolean; status: number; body: unknown }> => {
    assertCurrentIdentity();
    let tokenValue: unknown;
    try {
      tokenValue = await tokenLoader();
    } catch {
      throw new MobileCloudHomeError("unauthorized");
    }
    assertCurrentIdentity();
    const token = typeof tokenValue === "string" ? tokenValue.trim() : "";
    if (
      !token ||
      token.length > MAX_TOKEN_CHARS ||
      !TOKEN_PATTERN.test(token)
    ) {
      throw new MobileCloudHomeError("unauthorized");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
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
          // Authentication proxies and deployment edges sometimes return a
          // short plain-text error. Preserve the status mapping for non-2xx
          // responses; successful responses must still be valid JSON.
          if (response.ok) throw new MobileCloudHomeError("invalid");
        }
      }
      assertCurrentIdentity();
      return { ok: response.ok, status: response.status, body };
    } catch (error) {
      if (error instanceof MobileCloudHomeError) throw error;
      throw new MobileCloudHomeError("network");
    } finally {
      clearTimeout(timeout);
    }
  };

  const listMemory = async (): Promise<MobileCloudMemorySnapshot> => {
    const response = await request("/cloud-home/memory", { method: "GET" });
    if (!response.ok) throw responseError(response.status);
    const snapshot = parseSnapshot(response.body, identity.expectedSubject);
    assertCurrentIdentity();
    return snapshot;
  };

  const readMemory = async (
    name: string,
  ): Promise<MobileCloudMemoryReadResult> => {
    const normalizedName = normalizeMemoryName(name);
    const snapshot = await listMemory();
    const document =
      snapshot.documents.find((document) => document.name === normalizedName) ??
      null;
    assertCurrentIdentity();
    return Object.freeze({
      authority: authorityFromSnapshot(snapshot),
      document,
    });
  };

  const writeMemory = async (
    input: MobileCloudMemoryWrite,
  ): Promise<MobileCloudMemoryWriteResult> => {
    assertCurrentIdentity();
    const normalized = normalizeWrite(input);
    if (normalized.authority.subject !== identity.expectedSubject) {
      throw new MobileCloudHomeError("unauthorized");
    }
    if (
      normalized.writer === "mobile_sync" &&
      normalized.authority.importDisposition === "explicit_required"
    ) {
      throw new MobileCloudHomeError("unavailable");
    }
    const expectedSha256 = contentSha256(normalized.content);
    let writeResponse: { ok: boolean; status: number; body: unknown } | null =
      null;
    try {
      writeResponse = await request("/cloud-home/memory/write", {
        method: "POST",
        body: {
          name: normalized.name,
          kind: normalized.kind,
          content: normalized.content,
          expectedRevision: normalized.expectedRevision,
          source: normalized.source,
          writer: normalized.writer,
          idempotencyKey: normalized.idempotencyKey,
          expectedOwnerGeneration: normalized.authority.ownerGeneration,
          expectedMemoryEpoch: normalized.authority.memoryEpoch,
        },
      });
    } catch (error) {
      if (
        error instanceof MobileCloudHomeError &&
        (error.code === "unauthorized" || error.code === "unavailable")
      ) {
        throw error;
      }
      // The response can be lost after commit. The authoritative re-read below
      // is the only success signal returned to the UI.
    }
    if (writeResponse && !writeResponse.ok) {
      if (writeResponse.status === 401 || writeResponse.status === 403) {
        throw new MobileCloudHomeError("unauthorized");
      }
      if (
        writeResponse.status === 400 ||
        writeResponse.status === 413 ||
        writeResponse.status === 422
      ) {
        throw new MobileCloudHomeError("invalid");
      }
      if (writeResponse.status === 404 || writeResponse.status === 503) {
        throw new MobileCloudHomeError("unavailable");
      }
      // A 409 may be a document CAS conflict or an owner-lifecycle fence. A
      // successful re-read distinguishes them; a lifecycle-fenced GET maps to
      // unavailable. A 5xx can also arrive after a durable commit.
    }
    const snapshot = await listMemory();
    assertCurrentIdentity();
    if (
      snapshot.ownerGeneration !== normalized.authority.ownerGeneration ||
      snapshot.memoryEpoch !== normalized.authority.memoryEpoch ||
      (normalized.writer === "mobile_sync" &&
        snapshot.importDisposition === "explicit_required")
    ) {
      throw new MobileCloudHomeError("unavailable");
    }
    const document =
      snapshot.documents.find(
        (candidate) => candidate.name === normalized.name,
      ) ?? null;
    if (
      document?.sha256 === expectedSha256 &&
      document.revision === normalized.expectedRevision + 1
    ) {
      assertCurrentIdentity();
      return { status: "committed", document };
    }
    assertCurrentIdentity();
    return { status: "conflict", document };
  };

  return { listMemory, readMemory, writeMemory };
};
