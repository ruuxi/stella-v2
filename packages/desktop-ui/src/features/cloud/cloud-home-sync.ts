import type {
  CloudHomeImportOwnership,
  CloudHomeSyncCursor,
  CloudHomeSyncIssue,
  CloudHomeSyncStatus,
  CloudMemoryDocument,
  CloudMemorySnapshot,
  CloudSkillHead,
  LocalCloudHomeScan,
  LocalCloudMemoryDocument,
  LocalCloudSkillPackage,
} from "@stella/contracts/cloud-home-sync";

const CURSOR_SCHEMA_VERSION = 1 as const;
const HTTP_TIMEOUT_MS = 20_000;
const SCAN_TIMEOUT_MS = 30_000;
const MAX_HTTP_RESPONSE_BYTES = 4 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const LIFECYCLE_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u;
const MEMORY_SNAPSHOT_KEYS = new Set([
  "subject",
  "ownerGeneration",
  "memoryEpoch",
  "importDisposition",
  "lastWipedEpoch",
  "lastWipeCompletedAt",
  "documents",
]);

const isSafeCursorMemoryName = (name: string): boolean =>
  Boolean(
    name &&
      name.length <= 240 &&
      name.toLowerCase().endsWith(".md") &&
      !name.startsWith("/") &&
      !name.includes("\\") &&
      !/[\u0000-\u001f\u007f]/u.test(name) &&
      name
        .split("/")
        .every(
          (segment) =>
            segment &&
            segment !== "." &&
            segment !== ".." &&
            !segment.startsWith("."),
        ),
  );

export type CloudHomeCursorStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  /** Test/alternate privileged-store seam. Missing always fails closed. */
  readImportOwnership?: (
    accountScope: string,
  ) => Promise<CloudHomeImportOwnership>;
};

export type RunCloudHomeSyncOptions = {
  accountScope: string;
  expectedSubject: string;
  builderOrigin: string;
  token: string;
  scanLocal: () => Promise<LocalCloudHomeScan>;
  readSkillHeads: () => Promise<CloudSkillHead[]>;
  readImportOwnership?: (
    accountScope: string,
  ) => Promise<CloudHomeImportOwnership>;
  cursorStore: CloudHomeCursorStore;
  fetch?: typeof fetch;
  now?: () => number;
  signal?: AbortSignal;
  onStatus?: (status: CloudHomeSyncStatus) => void;
};

class CloudHomeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly protocolCode?: string,
  ) {
    super("Cloud Home request failed.");
  }
}

const emptyStatus = (accountScope: string | null): CloudHomeSyncStatus => ({
  accountScope,
  phase: "idle",
  memoryUploaded: 0,
  memoryCloudWins: 0,
  skillsUploaded: 0,
  skillsCloudWins: 0,
  skipped: 0,
  warnings: [],
  issues: [],
});

/** Never let a previous account's item labels cross an account transition. */
export const cloudHomeStatusForAccount = (
  status: CloudHomeSyncStatus,
  accountScope: string,
): CloudHomeSyncStatus =>
  status.accountScope === accountScope ? status : emptyStatus(accountScope);

let statusSnapshot = emptyStatus(null);
const statusListeners = new Set<() => void>();

export const cloudHomeSyncStatusStore = {
  subscribe(listener: () => void): () => void {
    statusListeners.add(listener);
    return () => statusListeners.delete(listener);
  },
  getSnapshot(): CloudHomeSyncStatus {
    return statusSnapshot;
  },
  getServerSnapshot(): CloudHomeSyncStatus {
    return statusSnapshot;
  },
  set(status: CloudHomeSyncStatus): void {
    statusSnapshot = status;
    for (const listener of statusListeners) listener();
  },
  reset(accountScope: string | null = null): void {
    this.set(emptyStatus(accountScope));
  },
};

let retrySnapshot = 0;
const retryListeners = new Set<() => void>();

export const cloudHomeSyncRetryStore = {
  subscribe(listener: () => void): () => void {
    retryListeners.add(listener);
    return () => retryListeners.delete(listener);
  },
  getSnapshot(): number {
    return retrySnapshot;
  },
  getServerSnapshot(): number {
    return 0;
  },
  request(): void {
    retrySnapshot += 1;
    for (const listener of retryListeners) listener();
  },
};

const sha256Text = async (value: string): Promise<string> => {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

export const cloudHomeCursorKey = async (
  accountScope: string,
): Promise<string> =>
  `stella:cloud-home-sync:v1:${(await sha256Text(accountScope)).slice(0, 32)}`;

const blankCursor = (): CloudHomeSyncCursor => ({
  schemaVersion: CURSOR_SCHEMA_VERSION,
  memories: {},
  skills: {},
});

const parseCursor = (raw: string | null): CloudHomeSyncCursor => {
  if (!raw) return blankCursor();
  try {
    const parsed = JSON.parse(raw) as Partial<CloudHomeSyncCursor>;
    if (
      parsed.schemaVersion !== CURSOR_SCHEMA_VERSION ||
      !parsed.memories ||
      typeof parsed.memories !== "object" ||
      Array.isArray(parsed.memories) ||
      !parsed.skills ||
      typeof parsed.skills !== "object" ||
      Array.isArray(parsed.skills)
    ) {
      return blankCursor();
    }
    const memories: CloudHomeSyncCursor["memories"] = Object.create(
      null,
    ) as CloudHomeSyncCursor["memories"];
    const skills: CloudHomeSyncCursor["skills"] = Object.create(
      null,
    ) as CloudHomeSyncCursor["skills"];
    for (const [name, value] of Object.entries(parsed.memories).slice(0, 100)) {
      if (
        !isSafeCursorMemoryName(name) ||
        !value ||
        typeof value !== "object" ||
        Array.isArray(value)
      ) {
        continue;
      }
      const row = value as Record<string, unknown>;
      if (
        typeof row.localSha256 !== "string" ||
        !SHA256_PATTERN.test(row.localSha256) ||
        !Number.isSafeInteger(row.cloudRevision) ||
        (row.cloudRevision as number) < 0 ||
        (row.cloudVersionId !== undefined &&
          (typeof row.cloudVersionId !== "string" ||
            !row.cloudVersionId ||
            row.cloudVersionId.length > 128))
      ) {
        continue;
      }
      memories[name] = {
        localSha256: row.localSha256,
        ...(typeof row.cloudVersionId === "string"
          ? { cloudVersionId: row.cloudVersionId }
          : {}),
        cloudRevision: row.cloudRevision as number,
      };
    }
    for (const [slug, value] of Object.entries(parsed.skills).slice(0, 50)) {
      if (
        !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(slug) ||
        !value ||
        typeof value !== "object" ||
        Array.isArray(value)
      ) {
        continue;
      }
      const row = value as Record<string, unknown>;
      if (
        typeof row.localTreeSha256 !== "string" ||
        !SHA256_PATTERN.test(row.localTreeSha256) ||
        !Number.isSafeInteger(row.cloudRevision) ||
        (row.cloudRevision as number) < 0 ||
        (row.cloudVersionId !== undefined &&
          (typeof row.cloudVersionId !== "string" ||
            !row.cloudVersionId ||
            row.cloudVersionId.length > 128))
      ) {
        continue;
      }
      skills[slug] = {
        localTreeSha256: row.localTreeSha256,
        ...(typeof row.cloudVersionId === "string"
          ? { cloudVersionId: row.cloudVersionId }
          : {}),
        cloudRevision: row.cloudRevision as number,
      };
    }
    return {
      schemaVersion: CURSOR_SCHEMA_VERSION,
      ...(typeof parsed.ownerGeneration === "string" &&
      LIFECYCLE_TOKEN_PATTERN.test(parsed.ownerGeneration)
        ? { ownerGeneration: parsed.ownerGeneration }
        : {}),
      ...(typeof parsed.memoryEpoch === "string" &&
      LIFECYCLE_TOKEN_PATTERN.test(parsed.memoryEpoch)
        ? { memoryEpoch: parsed.memoryEpoch }
        : {}),
      memories,
      skills,
      ...(typeof parsed.lastCompletedAt === "number" &&
      Number.isFinite(parsed.lastCompletedAt) &&
      parsed.lastCompletedAt >= 0
        ? { lastCompletedAt: parsed.lastCompletedAt }
        : {}),
    };
  } catch {
    return blankCursor();
  }
};

const awaitBounded = async <T>(args: {
  operation: () => Promise<T>;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<T> => {
  if (args.signal?.aborted) throw new CloudHomeHttpError(0);
  let rejectWait: ((error: CloudHomeHttpError) => void) | null = null;
  const boundary = new Promise<never>((_resolve, reject) => {
    rejectWait = reject;
  });
  const interrupt = () => rejectWait?.(new CloudHomeHttpError(0));
  args.signal?.addEventListener("abort", interrupt, { once: true });
  const timeout = setTimeout(interrupt, args.timeoutMs);
  try {
    return await Promise.race([args.operation(), boundary]);
  } finally {
    clearTimeout(timeout);
    args.signal?.removeEventListener("abort", interrupt);
  }
};

const readBoundedResponseText = async (
  response: Response,
  signal: AbortSignal,
): Promise<string> => {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_HTTP_RESPONSE_BYTES
  ) {
    throw new CloudHomeHttpError(502);
  }
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_HTTP_RESPONSE_BYTES) {
      throw new CloudHomeHttpError(502);
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
    if (signal.aborted) throw new CloudHomeHttpError(0);
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new CloudHomeHttpError(0);
      if (done) break;
      total += value.byteLength;
      if (total > MAX_HTTP_RESPONSE_BYTES) {
        await reader.cancel();
        throw new CloudHomeHttpError(502);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    signal.removeEventListener("abort", interrupt);
    reader.releaseLock();
  }
};

const validatedOrigin = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CloudHomeHttpError(0);
  }
  const isLocalHttp =
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (
    (url.protocol !== "https:" && !isLocalHttp) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new CloudHomeHttpError(0);
  }
  return url.origin;
};

const requestJson = async <T>(args: {
  fetchImpl: typeof fetch;
  origin: string;
  path: string;
  token: string;
  expectedSubject: string;
  method: "GET" | "POST";
  body?: unknown;
  signal?: AbortSignal;
}): Promise<T> => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  args.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, HTTP_TIMEOUT_MS);
  let response: Response;
  try {
    response = await args.fetchImpl(`${args.origin}${args.path}`, {
      method: args.method,
      redirect: "error",
      headers: {
        authorization: `Bearer ${args.token}`,
        "x-stella-expected-subject": args.expectedSubject,
        ...(args.method === "POST"
          ? { "content-type": "application/json" }
          : {}),
      },
      ...(args.body === undefined ? {} : { body: JSON.stringify(args.body) }),
      signal: controller.signal,
    });
    const text = await readBoundedResponseText(response, controller.signal);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new CloudHomeHttpError(response.status || 502);
    }
    if (!response.ok) {
      const code =
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as { code?: unknown }).code === "string"
          ? (parsed as { code: string }).code
          : undefined;
      throw new CloudHomeHttpError(response.status, code);
    }
    return parsed as T;
  } catch (error) {
    if (error instanceof CloudHomeHttpError) throw error;
    throw new CloudHomeHttpError(0);
  } finally {
    clearTimeout(timeout);
    args.signal?.removeEventListener("abort", abort);
  }
};

const parseSkillHeads = (value: unknown): CloudSkillHead[] => {
  if (!Array.isArray(value) || value.length > 50) {
    throw new CloudHomeHttpError(502);
  }
  return value.map((candidate) => {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      throw new CloudHomeHttpError(502);
    }
    const row = candidate as Record<string, unknown>;
    if (
      typeof row.skillId !== "string" ||
      typeof row.slug !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(row.slug) ||
      typeof row.name !== "string" ||
      typeof row.description !== "string" ||
      typeof row.source !== "string" ||
      typeof row.availability !== "string" ||
      !Number.isSafeInteger(row.revision) ||
      (row.revision as number) < 0 ||
      typeof row.updatedAt !== "number" ||
      (row.treeSha256 !== undefined &&
        (typeof row.treeSha256 !== "string" ||
          !SHA256_PATTERN.test(row.treeSha256)))
    ) {
      throw new CloudHomeHttpError(502);
    }
    return row as CloudSkillHead;
  });
};

const parseMemorySnapshot = (
  value: unknown,
  expectedSubject: string,
): CloudMemorySnapshot => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CloudHomeHttpError(502);
  }
  const row = value as Record<string, unknown>;
  if (
    !Object.keys(row).every((key) => MEMORY_SNAPSHOT_KEYS.has(key)) ||
    row.subject !== expectedSubject ||
    typeof row.ownerGeneration !== "string" ||
    !LIFECYCLE_TOKEN_PATTERN.test(row.ownerGeneration) ||
    typeof row.memoryEpoch !== "string" ||
    !LIFECYCLE_TOKEN_PATTERN.test(row.memoryEpoch) ||
    (row.importDisposition !== "automatic_allowed" &&
      row.importDisposition !== "explicit_required" &&
      row.importDisposition !== "explicit_allowed") ||
    (row.lastWipedEpoch !== undefined &&
      (typeof row.lastWipedEpoch !== "string" ||
        !LIFECYCLE_TOKEN_PATTERN.test(row.lastWipedEpoch))) ||
    (row.lastWipeCompletedAt !== undefined &&
      (!Number.isSafeInteger(row.lastWipeCompletedAt) ||
        (row.lastWipeCompletedAt as number) < 0)) ||
    !Array.isArray(row.documents)
  ) {
    throw new CloudHomeHttpError(502);
  }
  const documents = row.documents.map((candidate): CloudMemoryDocument => {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      throw new CloudHomeHttpError(502);
    }
    const document = candidate as Record<string, unknown>;
    if (
      typeof document.documentId !== "string" ||
      typeof document.name !== "string" ||
      typeof document.displayPath !== "string" ||
      typeof document.kind !== "string" ||
      typeof document.source !== "string" ||
      !Number.isSafeInteger(document.revision) ||
      typeof document.sizeBytes !== "number" ||
      typeof document.updatedAt !== "number" ||
      typeof document.content !== "string" ||
      (document.sha256 !== undefined &&
        (typeof document.sha256 !== "string" ||
          !SHA256_PATTERN.test(document.sha256)))
    ) {
      throw new CloudHomeHttpError(502);
    }
    return document as CloudMemoryDocument;
  });
  return {
    ownerGeneration: row.ownerGeneration,
    memoryEpoch: row.memoryEpoch,
    importDisposition: row.importDisposition,
    ...(typeof row.lastWipedEpoch === "string"
      ? { lastWipedEpoch: row.lastWipedEpoch }
      : {}),
    ...(typeof row.lastWipeCompletedAt === "number"
      ? { lastWipeCompletedAt: row.lastWipeCompletedAt }
      : {}),
    documents,
  };
};

const safeIssue = (
  code: CloudHomeSyncIssue["code"],
  item: string | undefined,
  message: string,
): CloudHomeSyncIssue => ({
  code,
  ...(item ? { item: item.slice(0, 120) } : {}),
  message,
});

const memoryIdempotencyKey = async (
  accountScope: string,
  document: LocalCloudMemoryDocument,
): Promise<string> =>
  `desktop-memory-${(
    await sha256Text(`${accountScope}\0${document.name}\0${document.sha256}`)
  ).slice(0, 48)}`;

const skillIdempotencyKey = async (
  accountScope: string,
  skill: LocalCloudSkillPackage,
): Promise<string> =>
  `desktop-skill-${(
    await sha256Text(`${accountScope}\0${skill.slug}\0${skill.treeSha256}`)
  ).slice(0, 48)}`;

const cursorMatchesMemory = (
  cursor: CloudHomeSyncCursor,
  local: LocalCloudMemoryDocument,
  cloud: CloudMemoryDocument,
): boolean => {
  const prior = cursor.memories[local.name];
  return Boolean(
    prior &&
      prior.localSha256 === local.sha256 &&
      prior.cloudRevision === cloud.revision &&
      prior.cloudVersionId === cloud.versionId,
  );
};

const cursorMatchesSkill = (
  cursor: CloudHomeSyncCursor,
  local: LocalCloudSkillPackage,
  cloud: CloudSkillHead,
): boolean => {
  const prior = cursor.skills[local.slug];
  return Boolean(
    prior &&
      prior.localTreeSha256 === local.treeSha256 &&
      prior.cloudRevision === cloud.revision &&
      prior.cloudVersionId === cloud.versionId,
  );
};

export const runCloudHomeSync = async (
  options: RunCloudHomeSyncOptions,
): Promise<CloudHomeSyncStatus> => {
  const accountScope = options.accountScope.trim();
  const token = options.token.trim();
  const expectedSubject = options.expectedSubject.trim();
  if (
    !accountScope ||
    !token ||
    !expectedSubject ||
    expectedSubject !== options.expectedSubject ||
    expectedSubject.length > 1_024 ||
    expectedSubject.normalize("NFC") !== expectedSubject ||
    /[\u0000-\u001f\u007f]/u.test(expectedSubject)
  ) {
    return {
      ...emptyStatus(accountScope || null),
      phase: "unavailable",
      issues: [
        safeIssue(
          "not_authenticated",
          undefined,
          "Sign in again to synchronize Cloud Home.",
        ),
      ],
    };
  }
  let importOwnership: CloudHomeImportOwnership;
  try {
    const readImportOwnership =
      options.readImportOwnership ?? options.cursorStore.readImportOwnership;
    if (!readImportOwnership) throw new CloudHomeHttpError(0);
    importOwnership = await awaitBounded({
      operation: () => readImportOwnership(accountScope),
      timeoutMs: SCAN_TIMEOUT_MS,
      signal: options.signal,
    });
  } catch {
    importOwnership = "corrupt";
  }
  if (importOwnership !== "owned") {
    const confirmationRequired = importOwnership === "unclaimed";
    const blocked: CloudHomeSyncStatus = {
      ...emptyStatus(accountScope),
      phase: confirmationRequired ? "attention" : "unavailable",
      issues: [
        safeIssue(
          confirmationRequired
            ? "import_confirmation_required"
            : importOwnership === "corrupt"
              ? "local_owner_record_invalid"
              : "local_owner_mismatch",
          undefined,
          confirmationRequired
            ? "Confirm which account owns this Mac's local memory and custom skills before importing them."
            : importOwnership === "anonymous"
              ? "Sign in to a connected account before importing this Mac's local memory and custom skills."
              : importOwnership === "corrupt"
                ? "Stella could not verify this Mac's durable local-import owner record, so no local memory or skills were uploaded."
                : "This Mac's local memory and custom skills are already bound to another account and were not uploaded.",
        ),
      ],
    };
    options.onStatus?.(blocked);
    return blocked;
  }
  const fetchImpl = options.fetch ?? fetch;
  let origin: string;
  try {
    origin = validatedOrigin(options.builderOrigin);
  } catch {
    return {
      ...emptyStatus(accountScope),
      phase: "unavailable",
      issues: [
        safeIssue(
          "not_available",
          undefined,
          "Cloud Home is not available in this deployment.",
        ),
      ],
    };
  }

  let status: CloudHomeSyncStatus = {
    ...emptyStatus(accountScope),
    phase: "scanning",
  };
  const publishStatus = () => options.onStatus?.({ ...status });
  publishStatus();

  let cloudMemory: CloudMemorySnapshot;
  let cloudSkills: CloudSkillHead[];
  let scan: LocalCloudHomeScan;
  try {
    // Read both cloud authorities before inspecting local state. The importer
    // is additive only: an existing divergent cloud head always wins.
    [cloudMemory, cloudSkills] = await Promise.all([
      requestJson<unknown>({
        fetchImpl,
        origin,
        path: "/cloud-home/memory",
        token,
        expectedSubject,
        method: "GET",
        signal: options.signal,
      }).then((value) => parseMemorySnapshot(value, expectedSubject)),
      awaitBounded({
        operation: options.readSkillHeads,
        timeoutMs: HTTP_TIMEOUT_MS,
        signal: options.signal,
      }).then(parseSkillHeads),
    ]);
    scan = await awaitBounded({
      operation: options.scanLocal,
      timeoutMs: SCAN_TIMEOUT_MS,
      signal: options.signal,
    });
  } catch {
    status = {
      ...status,
      phase: "unavailable",
      issues: [
        safeIssue(
          "cloud_unavailable",
          undefined,
          "Cloud Home could not be synchronized. Try again.",
        ),
      ],
    };
    publishStatus();
    return status;
  }

  const cursorKey = await cloudHomeCursorKey(accountScope);
  let cursor = parseCursor(options.cursorStore.getItem(cursorKey));
  if (
    cursor.ownerGeneration &&
    cursor.ownerGeneration !== cloudMemory.ownerGeneration
  ) {
    cursor = blankCursor();
  } else if (cursor.memoryEpoch !== cloudMemory.memoryEpoch) {
    cursor.memories = {};
  }
  cursor.ownerGeneration = cloudMemory.ownerGeneration;
  cursor.memoryEpoch = cloudMemory.memoryEpoch;
  const persistCursor = () =>
    options.cursorStore.setItem(cursorKey, JSON.stringify(cursor));
  persistCursor();
  status = {
    ...status,
    phase: "reconciling",
    warnings: scan.warnings,
  };
  publishStatus();

  const interrupted = (): CloudHomeSyncStatus => {
    // Confirmed item cursors remain resumable, but a canceled/account-switched
    // pass never records lastCompletedAt or presents itself as successful.
    const partial = { ...status, phase: "idle" as const };
    status = partial;
    publishStatus();
    return partial;
  };

  const ownerGenerationAtStart = cloudMemory.ownerGeneration;
  const memoryEpochAtStart = cloudMemory.memoryEpoch;
  const memoryImportBlocked =
    cloudMemory.importDisposition === "explicit_required";
  if (memoryImportBlocked && scan.memories.length > 0) {
    status = {
      ...status,
      issues: [
        ...status.issues,
        safeIssue(
          "memory_reimport_confirmation_required",
          undefined,
          "Cloud Memory was erased. Explicitly confirm before importing this Mac's local Memory into the new empty epoch.",
        ),
      ],
    };
    publishStatus();
  }

  let memoryByName = new Map(
    cloudMemory.documents.map((document) => [document.name, document]),
  );
  for (const local of memoryImportBlocked ? [] : scan.memories) {
    if (options.signal?.aborted) return interrupted();
    const cloud = memoryByName.get(local.name);
    if (cloud?.sha256 === local.sha256) {
      cursor.memories[local.name] = {
        localSha256: local.sha256,
        ...(cloud.versionId ? { cloudVersionId: cloud.versionId } : {}),
        cloudRevision: cloud.revision,
      };
      status = { ...status, skipped: status.skipped + 1 };
      persistCursor();
      publishStatus();
      continue;
    }
    if (cloud) {
      if (cursorMatchesMemory(cursor, local, cloud)) {
        status = { ...status, skipped: status.skipped + 1 };
      } else {
        status = {
          ...status,
          memoryCloudWins: status.memoryCloudWins + 1,
          issues: [
            ...status.issues,
            safeIssue(
              "cloud_conflict",
              local.name,
              "The cloud document changed, so the local copy was not uploaded.",
            ),
          ],
        };
      }
      cursor.memories[local.name] = {
        localSha256: local.sha256,
        ...(cloud.versionId ? { cloudVersionId: cloud.versionId } : {}),
        cloudRevision: cloud.revision,
      };
      persistCursor();
      publishStatus();
      continue;
    }

    try {
      await requestJson({
        fetchImpl,
        origin,
        path: "/cloud-home/memory/write",
        token,
        expectedSubject,
        method: "POST",
        body: {
          expectedOwnerGeneration: ownerGenerationAtStart,
          expectedMemoryEpoch: memoryEpochAtStart,
          name: local.name,
          kind: local.kind,
          source: local.source,
          expectedRevision: 0,
          content: local.content,
          writer: "desktop_sync",
          idempotencyKey: await memoryIdempotencyKey(accountScope, local),
        },
        signal: options.signal,
      });
    } catch {
      // A response can be lost after a successful commit. The authoritative
      // re-read below distinguishes that case from a real failure.
    }
    try {
      const verifiedMemory = parseMemorySnapshot(
        await requestJson<unknown>({
          fetchImpl,
          origin,
          path: "/cloud-home/memory",
          token,
          expectedSubject,
          method: "GET",
          signal: options.signal,
        }),
        expectedSubject,
      );
      if (
        verifiedMemory.ownerGeneration !== ownerGenerationAtStart ||
        verifiedMemory.memoryEpoch !== memoryEpochAtStart
      ) {
        status = {
          ...status,
          phase: "unavailable",
          issues: [
            ...status.issues,
            safeIssue(
              "verification_failed",
              undefined,
              "Cloud Memory authority changed during synchronization. No further local content was uploaded.",
            ),
          ],
        };
        publishStatus();
        return status;
      }
      cloudMemory = verifiedMemory;
      memoryByName = new Map(
        cloudMemory.documents.map((document) => [document.name, document]),
      );
      const verified = memoryByName.get(local.name);
      if (verified?.sha256 === local.sha256) {
        cursor.memories[local.name] = {
          localSha256: local.sha256,
          ...(verified.versionId ? { cloudVersionId: verified.versionId } : {}),
          cloudRevision: verified.revision,
        };
        status = { ...status, memoryUploaded: status.memoryUploaded + 1 };
        persistCursor();
      } else {
        status = {
          ...status,
          memoryCloudWins: status.memoryCloudWins + 1,
          issues: [
            ...status.issues,
            safeIssue(
              "cloud_conflict",
              local.name,
              "The cloud document won a concurrent update; the local copy was kept only on this device.",
            ),
          ],
        };
      }
    } catch {
      status = {
        ...status,
        issues: [
          ...status.issues,
          safeIssue(
            "verification_failed",
            local.name,
            "The cloud document could not be verified after upload.",
          ),
        ],
      };
    }
    publishStatus();
  }

  if (options.signal?.aborted) return interrupted();

  let skillsBySlug = new Map(cloudSkills.map((skill) => [skill.slug, skill]));
  for (const local of scan.skills) {
    if (options.signal?.aborted) return interrupted();
    const cloud = skillsBySlug.get(local.slug);
    if (cloud?.treeSha256 === local.treeSha256) {
      cursor.skills[local.slug] = {
        localTreeSha256: local.treeSha256,
        ...(cloud.versionId ? { cloudVersionId: cloud.versionId } : {}),
        cloudRevision: cloud.revision,
      };
      status = { ...status, skipped: status.skipped + 1 };
      persistCursor();
      publishStatus();
      continue;
    }
    if (cloud) {
      if (cursorMatchesSkill(cursor, local, cloud)) {
        status = { ...status, skipped: status.skipped + 1 };
      } else {
        status = {
          ...status,
          skillsCloudWins: status.skillsCloudWins + 1,
          issues: [
            ...status.issues,
            safeIssue(
              "cloud_conflict",
              local.slug,
              "The cloud skill changed, so the local package was not uploaded.",
            ),
          ],
        };
      }
      cursor.skills[local.slug] = {
        localTreeSha256: local.treeSha256,
        ...(cloud.versionId ? { cloudVersionId: cloud.versionId } : {}),
        cloudRevision: cloud.revision,
      };
      persistCursor();
      publishStatus();
      continue;
    }

    try {
      await requestJson({
        fetchImpl,
        origin,
        path: "/cloud-home/skills/upload",
        token,
        expectedSubject,
        method: "POST",
        body: {
          slug: local.slug,
          name: local.name,
          description: local.description,
          source: local.source,
          availability: local.availability,
          expectedRevision: 0,
          files: local.files.map(({ path, contentType, base64 }) => ({
            path,
            contentType,
            base64,
          })),
          idempotencyKey: await skillIdempotencyKey(accountScope, local),
        },
        signal: options.signal,
      });
    } catch {
      // Re-query below: an exact version may have committed before response loss.
    }
    try {
      cloudSkills = parseSkillHeads(
        await awaitBounded({
          operation: options.readSkillHeads,
          timeoutMs: HTTP_TIMEOUT_MS,
          signal: options.signal,
        }),
      );
      skillsBySlug = new Map(cloudSkills.map((skill) => [skill.slug, skill]));
      const verified = skillsBySlug.get(local.slug);
      if (verified?.treeSha256 === local.treeSha256) {
        cursor.skills[local.slug] = {
          localTreeSha256: local.treeSha256,
          ...(verified.versionId ? { cloudVersionId: verified.versionId } : {}),
          cloudRevision: verified.revision,
        };
        status = { ...status, skillsUploaded: status.skillsUploaded + 1 };
        persistCursor();
      } else if (verified) {
        status = {
          ...status,
          skillsCloudWins: status.skillsCloudWins + 1,
          issues: [
            ...status.issues,
            safeIssue(
              "cloud_conflict",
              local.slug,
              "The cloud skill won a concurrent update; the local package was kept only on this device.",
            ),
          ],
        };
      } else {
        status = {
          ...status,
          issues: [
            ...status.issues,
            safeIssue(
              "verification_failed",
              local.slug,
              "The cloud skill could not be verified after upload.",
            ),
          ],
        };
      }
    } catch {
      status = {
        ...status,
        issues: [
          ...status.issues,
          safeIssue(
            "verification_failed",
            local.slug,
            "The cloud skill could not be verified after upload.",
          ),
        ],
      };
    }
    publishStatus();
  }

  if (options.signal?.aborted) return interrupted();

  const completedAt = (options.now ?? Date.now)();
  cursor.lastCompletedAt = completedAt;
  persistCursor();
  status = {
    ...status,
    phase:
      status.issues.length > 0 || status.warnings.length > 0
        ? "attention"
        : "complete",
    lastCompletedAt: completedAt,
  };
  publishStatus();
  return status;
};
