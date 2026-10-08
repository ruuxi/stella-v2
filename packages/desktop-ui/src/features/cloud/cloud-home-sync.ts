import type {
  CloudHomeImportOwnership,
  CloudHomeScanWarningCode,
  CloudHomeSyncCursor,
  CloudHomeSyncIssue,
  CloudHomeSyncStatus,
  CloudSkillHead,
  CloudSkillMirrorDeletion,
  LocalCloudHomeScan,
  LocalCloudSkillPackage,
} from "@stella/contracts/cloud-home-sync";

const CURSOR_SCHEMA_VERSION = 1 as const;
const HTTP_TIMEOUT_MS = 20_000;
const SCAN_TIMEOUT_MS = 30_000;
const MAX_HTTP_RESPONSE_BYTES = 4 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
/**
 * Scan warnings that can hide a skill the device root really does hold. Any of
 * them makes the scanned slug set an incomplete picture of that root, and a
 * mirror prune driven by an incomplete picture deletes live skills.
 */
const SKILL_SCAN_INCOMPLETE_CODES = new Set<CloudHomeScanWarningCode>([
  "invalid_path",
  "unsafe_file",
  "skill_invalid",
  "skill_too_large",
  "skill_limit",
  "read_failed",
]);
const hasAsciiControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};

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
  deleteSkillMirror: (args: {
    slug: string;
    expectedRevision: number;
  }) => Promise<CloudSkillMirrorDeletion>;
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
  skills: {},
});

const parseCursor = (raw: string | null): CloudHomeSyncCursor => {
  if (!raw) return blankCursor();
  try {
    const parsed = JSON.parse(raw) as Partial<CloudHomeSyncCursor>;
    if (
      parsed.schemaVersion !== CURSOR_SCHEMA_VERSION ||
      !parsed.skills ||
      typeof parsed.skills !== "object" ||
      Array.isArray(parsed.skills)
    ) {
      return blankCursor();
    }
    const skills: CloudHomeSyncCursor["skills"] = Object.create(
      null,
    ) as CloudHomeSyncCursor["skills"];
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

const safeIssue = (
  code: CloudHomeSyncIssue["code"],
  item: string | undefined,
  message: string,
): CloudHomeSyncIssue => ({
  code,
  ...(item ? { item: item.slice(0, 120) } : {}),
  message,
});

const skillIdempotencyKey = async (
  accountScope: string,
  skill: LocalCloudSkillPackage,
): Promise<string> =>
  `desktop-skill-${(
    await sha256Text(`${accountScope}\0${skill.slug}\0${skill.treeSha256}`)
  ).slice(0, 48)}`;

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
    hasAsciiControlCharacter(expectedSubject)
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
            ? "Confirm which account owns this Mac's custom skills before importing them."
            : importOwnership === "anonymous"
              ? "Sign in to a connected account before importing this Mac's custom skills."
              : importOwnership === "corrupt"
                ? "Stella could not verify this Mac's durable local-import owner record, so no local skills were uploaded."
                : "This Mac's custom skills are already bound to another account and were not uploaded.",
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

  let cloudSkills: CloudSkillHead[];
  let scan: LocalCloudHomeScan;
  try {
    // Read the cloud authority before inspecting local state. The importer is
    // additive only: an existing divergent cloud head always wins.
    cloudSkills = await awaitBounded({
      operation: options.readSkillHeads,
      timeoutMs: HTTP_TIMEOUT_MS,
      signal: options.signal,
    }).then(parseSkillHeads);
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
  const cursor = parseCursor(options.cursorStore.getItem(cursorKey));
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

  // The prune runs only after the upload pass above has finished, on the heads
  // that pass last observed. Two properties make it safe. Every slug the
  // conflict branch touched is by definition present in the scanned device
  // root, so it is never a candidate here; and the delete carries the revision
  // this pass observed, so a head another device advanced in the meantime is
  // refused rather than erased. Multi-device convergence is deliberate rather
  // than exact: if this Mac drops a skill another Mac still holds, that Mac
  // re-uploads it on its next pass and the skill comes back. The live device
  // roots, not a tombstone, are the authority. What keeps that from being a
  // footgun on a fresh Mac is the one-time import-ownership confirmation
  // above, which is where the user says this root speaks for the account.
  const deviceSlugs = new Set(scan.skills.map((local) => local.slug));
  if (
    !scan.warnings.some((warning) =>
      SKILL_SCAN_INCOMPLETE_CODES.has(warning.code),
    )
  ) {
    for (const cloud of skillsBySlug.values()) {
      if (options.signal?.aborted) return interrupted();
      if (deviceSlugs.has(cloud.slug)) continue;
      let deletion: CloudSkillMirrorDeletion | null = null;
      try {
        deletion = await awaitBounded({
          operation: () =>
            options.deleteSkillMirror({
              slug: cloud.slug,
              expectedRevision: cloud.revision,
            }),
          timeoutMs: HTTP_TIMEOUT_MS,
          signal: options.signal,
        });
      } catch {
        if (options.signal?.aborted) return interrupted();
      }
      if (deletion?.status === "deleted") continue;
      status =
        deletion?.status === "conflict"
          ? {
              ...status,
              skillsCloudWins: status.skillsCloudWins + 1,
              issues: [
                ...status.issues,
                safeIssue(
                  "cloud_conflict",
                  cloud.slug,
                  "The cloud skill changed, so it was not removed from Cloud Home.",
                ),
              ],
            }
          : {
              ...status,
              issues: [
                ...status.issues,
                safeIssue(
                  "verification_failed",
                  cloud.slug,
                  "The cloud skill could not be removed after it was deleted on this Mac.",
                ),
              ],
            };
      publishStatus();
    }
    // A slug the device root no longer holds keeps no cursor row, so a bounded
    // cursor never fills with skills this Mac deleted long ago.
    for (const slug of Object.keys(cursor.skills)) {
      if (!deviceSlugs.has(slug)) delete cursor.skills[slug];
    }
    persistCursor();
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
