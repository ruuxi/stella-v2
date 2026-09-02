import {
  CloudHomeProtocolError,
  CloudHomeStore,
  type CloudMemoryKind,
  type CloudSkillUploadFile,
  utf8Bytes,
  utf8Text,
} from "./cloud-home-store.js";
import {
  BoundedBodyError,
  readBoundedRequestJson,
} from "./bounded-body.js";

type CloudHomeRouteEnv = {
  AGENT_HOME?: R2Bucket;
  BUILDER_SERVICE_SECRET: string;
  STELLA_CONVEX_SITE_URL?: string;
};

export type CloudHomeLeaseRunner = <T>(
  ownerId: string,
  ownerGeneration: string,
  activityId: string,
  operation: (assertExternalWrite: () => Promise<void>) => Promise<T>,
) => Promise<T>;

const EXPECTED_SUBJECT_HEADER = "x-stella-expected-subject";

const json = (body: unknown, status = 200): Response =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

const routeError = (error: unknown): Response => {
  if (error instanceof CloudHomeProtocolError) {
    return json(
      { error: error.message, ...(error.code ? { code: error.code } : {}) },
      error.status && error.status >= 400 ? error.status : 400,
    );
  }
  // Unknown exceptions may contain an upstream URL, object locator, secret,
  // or parser detail. Only deliberately constructed protocol errors are safe
  // to return to an authenticated client.
  return json({ error: "Cloud home request failed." }, 500);
};

const endpointBase = (env: CloudHomeRouteEnv): string => {
  const base = (env.STELLA_CONVEX_SITE_URL ?? "").trim().replace(/\/+$/u, "");
  if (!base)
    throw new CloudHomeProtocolError("Cloud home is unavailable.", 503);
  return base;
};

const requireBucket = (env: CloudHomeRouteEnv): R2Bucket => {
  if (!env.AGENT_HOME) {
    throw new CloudHomeProtocolError("Cloud home storage is unavailable.", 503);
  }
  return env.AGENT_HOME;
};

const ownerAccess = async (
  env: CloudHomeRouteEnv,
  ownerId: string,
): Promise<string> => {
  const response = await fetch(`${endpointBase(env)}/api/cloud/home/access`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.BUILDER_SERVICE_SECRET}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ownerId }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => null)) as {
    ownerGeneration?: unknown;
    error?: unknown;
  } | null;
  const ownerGeneration =
    typeof body?.ownerGeneration === "string"
      ? body.ownerGeneration.trim()
      : "";
  if (!response.ok || !ownerGeneration) {
    throw new CloudHomeProtocolError(
      typeof body?.error === "string"
        ? body.error
        : "Account data is being migrated, deleted, or reset.",
      response.status || 409,
    );
  }
  return ownerGeneration;
};

const makeStore = (
  env: CloudHomeRouteEnv,
  ownerId: string,
  ownerGeneration: string,
  assertExternalWrite: () => Promise<void>,
) =>
  new CloudHomeStore(requireBucket(env), {
    base: endpointBase(env),
    bearer: env.BUILDER_SERVICE_SECRET,
    ownerId,
    ownerGeneration,
    assertExternalWrite,
  });

const CLOUD_HOME_CONTROL_REQUEST_MAX_BYTES = 64 * 1024;
const CLOUD_HOME_MEMORY_REQUEST_MAX_BYTES = 1024 * 1024;
// The accepted decoded package is at most 25 MiB. Base64 expands that by 4/3,
// and the JSON manifest needs a small fixed allowance on top. Keep the route
// below one third of the Worker isolate limit while allowing the product-level
// aggregate validator to return its more precise error.
const CLOUD_HOME_SKILL_UPLOAD_REQUEST_MAX_BYTES = 40 * 1024 * 1024;

const requestBodyLimit = (pathname: string): number => {
  if (pathname === "/cloud-home/skills/upload") {
    return CLOUD_HOME_SKILL_UPLOAD_REQUEST_MAX_BYTES;
  }
  if (pathname === "/cloud-home/memory/write") {
    return CLOUD_HOME_MEMORY_REQUEST_MAX_BYTES;
  }
  return CLOUD_HOME_CONTROL_REQUEST_MAX_BYTES;
};

const parseJsonObject = async (request: Request, pathname: string) => {
  let body: unknown;
  try {
    body = await readBoundedRequestJson(request, requestBodyLimit(pathname));
  } catch (error) {
    if (error instanceof BoundedBodyError && error.reason === "too_large") {
      throw new CloudHomeProtocolError("Cloud home request is too large.", 413);
    }
    throw new CloudHomeProtocolError("JSON object required.", 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new CloudHomeProtocolError("JSON object required.", 400);
  }
  return body as Record<string, unknown>;
};

const requiredString = (
  row: Record<string, unknown>,
  key: string,
  max: number,
): string => {
  const value = typeof row[key] === "string" ? row[key].trim() : "";
  if (!value || value.length > max) {
    throw new CloudHomeProtocolError(`${key} was invalid.`, 400);
  }
  return value;
};

const requiredRawString = (
  row: Record<string, unknown>,
  key: string,
  max: number,
): string => {
  const value = row[key];
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    throw new CloudHomeProtocolError(`${key} was invalid.`, 400);
  }
  return value;
};

const requiredRevision = (
  row: Record<string, unknown>,
  key: string,
): number => {
  const value = row[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new CloudHomeProtocolError(`${key} was invalid.`, 400);
  }
  return value as number;
};

const CLOUD_SKILL_MAX_FILE_BYTES = 5 * 1024 * 1024;
const CLOUD_SKILL_MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const MAX_BASE64_FILE_CHARS = Math.ceil(CLOUD_SKILL_MAX_FILE_BYTES / 3) * 4;

const decodedBase64Size = (value: string): number => {
  if (value.length % 4 !== 0) return Number.POSITIVE_INFINITY;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
};

const base64Bytes = (value: string): Uint8Array => {
  const decodedSize = decodedBase64Size(value);
  if (
    !value ||
    value.length > MAX_BASE64_FILE_CHARS ||
    decodedSize > CLOUD_SKILL_MAX_FILE_BYTES
  ) {
    throw new CloudHomeProtocolError("Skill file body was invalid.", 413);
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new CloudHomeProtocolError("Skill file body was not base64.", 400);
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  if (bytes.byteLength !== decodedSize) {
    throw new CloudHomeProtocolError(
      "Skill file body was not canonical base64.",
      400,
    );
  }
  return bytes;
};

const bytesBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
};

const safeMemoryKind = (value: unknown): CloudMemoryKind => {
  if (
    value === "memory" ||
    value === "profile" ||
    value === "memory_map" ||
    value === "core_memory" ||
    value === "personality" ||
    value === "imported_markdown" ||
    value === "user_markdown" ||
    value === "archive"
  ) {
    return value;
  }
  throw new CloudHomeProtocolError("Memory kind was invalid.", 400);
};

/**
 * Authenticated desktop/mobile plane. `ownerId` is the verified JWT subject,
 * never a request field. Responses intentionally omit every R2 object key.
 */
export const handleUserCloudHomeRoute = async (args: {
  request: Request;
  env: CloudHomeRouteEnv;
  ownerId: string;
  subject: string;
  withLease: CloudHomeLeaseRunner;
}): Promise<Response | null> => {
  const url = new URL(args.request.url);
  const matches = url.pathname.startsWith("/cloud-home/");
  if (!matches) return null;
  try {
    const memoryRoute = url.pathname.startsWith("/cloud-home/memory");
    if (memoryRoute) {
      const expectedSubject =
        args.request.headers.get(EXPECTED_SUBJECT_HEADER)?.trim() ?? "";
      if (
        !expectedSubject ||
        expectedSubject !== args.subject ||
        expectedSubject !== args.ownerId
      ) {
        throw new CloudHomeProtocolError(
          "The authenticated cloud session changed before this request.",
          409,
          "SESSION_IDENTITY_MISMATCH",
        );
      }
    }
    const ownerGeneration = await ownerAccess(args.env, args.ownerId);
    if (
      args.request.method === "GET" &&
      url.pathname === "/cloud-home/memory/wipe/status"
    ) {
      // Status is control-plane only and must stay reachable while the owner
      // R2 activity fence is closed for the wipe itself.
      const home = new CloudHomeStore(requireBucket(args.env), {
        base: endpointBase(args.env),
        bearer: args.env.BUILDER_SERVICE_SECRET,
        ownerId: args.ownerId,
        ownerGeneration,
      });
      return json(await home.getMemoryWipeStatus());
    }
    return await args.withLease(
      args.ownerId,
      ownerGeneration,
      `cloud-home-user:${crypto.randomUUID()}`,
      async (assertExternalWrite) => {
        const home = makeStore(
          args.env,
          args.ownerId,
          ownerGeneration,
          assertExternalWrite,
        );
        if (
          args.request.method === "POST" &&
          url.pathname === "/cloud-home/memory/wipe/start"
        ) {
          const body = await parseJsonObject(args.request, url.pathname);
          if (
            requiredString(body, "expectedOwnerGeneration", 512) !==
            ownerGeneration
          ) {
            throw new CloudHomeProtocolError(
              "This memory wipe request belongs to an older account reset.",
              412,
              "OWNER_DATA_GENERATION_STALE",
            );
          }
          const status = await home.startMemoryWipe({
            expectedMemoryEpoch: requiredString(
              body,
              "expectedMemoryEpoch",
              512,
            ),
            requestId: requiredString(body, "requestId", 128),
          });
          return json(status, status.job?.stage === "completed" ? 200 : 202);
        }
        if (
          args.request.method === "GET" &&
          url.pathname === "/cloud-home/memory"
        ) {
          const [heads, memoryStatus] = await Promise.all([
            home.listMemoryHeads(100),
            home.getMemoryWipeStatus(),
          ]);
          const documents = [];
          let total = 0;
          for (const head of heads) {
            const bytes = head.sha256
              ? await home.readMemoryHeadBytes(head)
              : await home.readLegacyMemoryHeadBytes(head);
            total += bytes.byteLength;
            if (total > 2 * 1024 * 1024) {
              throw new CloudHomeProtocolError(
                "Cloud memory export exceeded its bound.",
                413,
              );
            }
            const {
              r2Key: _r2Key,
              ownerGeneration: _generation,
              memoryEpoch: _memoryEpoch,
              ...safeHead
            } = head;
            documents.push({ ...safeHead, content: utf8Text(bytes) });
          }
          return json({
            subject: args.subject,
            ownerGeneration,
            memoryEpoch: memoryStatus.memoryEpoch,
            importDisposition: memoryStatus.importDisposition,
            ...(memoryStatus.lastWipedEpoch
              ? { lastWipedEpoch: memoryStatus.lastWipedEpoch }
              : {}),
            ...(memoryStatus.job?.completedAt
              ? { lastWipeCompletedAt: memoryStatus.job.completedAt }
              : {}),
            documents,
          });
        }
        if (
          args.request.method === "POST" &&
          url.pathname === "/cloud-home/memory/reimport/authorize"
        ) {
          const body = await parseJsonObject(args.request, url.pathname);
          if (
            requiredString(body, "expectedOwnerGeneration", 512) !==
            ownerGeneration
          ) {
            throw new CloudHomeProtocolError(
              "This reimport request belongs to an older account reset.",
              412,
              "OWNER_DATA_GENERATION_STALE",
            );
          }
          return json(
            await home.authorizeMemoryReimport({
              expectedMemoryEpoch: requiredString(
                body,
                "expectedMemoryEpoch",
                512,
              ),
              requestId: requiredString(body, "requestId", 128),
            }),
          );
        }
        if (
          args.request.method === "POST" &&
          url.pathname === "/cloud-home/memory/write"
        ) {
          const body = await parseJsonObject(args.request, url.pathname);
          if (
            requiredString(body, "expectedOwnerGeneration", 512) !==
            ownerGeneration
          ) {
            throw new CloudHomeProtocolError(
              "This memory write belongs to an older account reset.",
              412,
              "OWNER_DATA_GENERATION_STALE",
            );
          }
          const expectedMemoryEpoch = requiredString(
            body,
            "expectedMemoryEpoch",
            512,
          );
          const writer = body.writer;
          if (
            writer !== "desktop_sync" &&
            writer !== "mobile_sync" &&
            writer !== "user_edit"
          ) {
            throw new CloudHomeProtocolError("Memory writer was invalid.", 400);
          }
          const receipt = await home.publishMemory({
            name: requiredString(body, "name", 240),
            kind: safeMemoryKind(body.kind),
            source: requiredString(body, "source", 120),
            expectedRevision: requiredRevision(body, "expectedRevision"),
            bytes: utf8Bytes(requiredRawString(body, "content", 512 * 1024)),
            writer,
            idempotencyKey: requiredString(body, "idempotencyKey", 128),
            expectedMemoryEpoch,
          });
          const {
            r2Key: _r2Key,
            ownerGeneration: _generation,
            ...safe
          } = receipt;
          return json(
            { subject: args.subject, ...safe },
            receipt.status === "conflict" ? 409 : 200,
          );
        }
        if (
          args.request.method === "POST" &&
          url.pathname === "/cloud-home/skills/upload"
        ) {
          const body = await parseJsonObject(args.request, url.pathname);
          const source = body.source;
          if (
            source !== "desktop_sync" &&
            source !== "mobile_sync" &&
            source !== "cloud_created"
          ) {
            throw new CloudHomeProtocolError("Skill source was invalid.", 400);
          }
          const availability = body.availability;
          if (
            availability !== "orchestrator" &&
            availability !== "general" &&
            availability !== "both"
          ) {
            throw new CloudHomeProtocolError(
              "Skill availability was invalid.",
              400,
            );
          }
          if (!Array.isArray(body.files) || body.files.length > 256) {
            throw new CloudHomeProtocolError("Skill files were invalid.", 400);
          }
          const files: CloudSkillUploadFile[] = [];
          let totalEncodedBytes = 0;
          let totalDecodedBytes = 0;
          for (const raw of body.files) {
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
              throw new CloudHomeProtocolError("Skill file was invalid.", 400);
            }
            const file = raw as Record<string, unknown>;
            const base64 = requiredString(
              file,
              "base64",
              MAX_BASE64_FILE_CHARS,
            );
            const decodedSize = decodedBase64Size(base64);
            totalEncodedBytes += base64.length;
            totalDecodedBytes += decodedSize;
            // Check the encoded and decoded aggregate before allocating the
            // next decoded buffer. The encoded ceiling accounts for base64's
            // 4/3 expansion and prevents a 256-file request from multiplying
            // the per-file allowance into worker-memory exhaustion.
            if (
              totalEncodedBytes >
                Math.ceil(CLOUD_SKILL_MAX_TOTAL_BYTES / 3) * 4 ||
              totalDecodedBytes > CLOUD_SKILL_MAX_TOTAL_BYTES
            ) {
              throw new CloudHomeProtocolError(
                "Skill package exceeds the total size limit.",
                413,
              );
            }
            const bytes = base64Bytes(base64);
            files.push({
              path: requiredString(file, "path", 240),
              contentType: requiredString(file, "contentType", 120),
              bytes,
            });
          }
          const receipt = await home.publishSkill({
            slug: requiredString(body, "slug", 63),
            name: requiredString(body, "name", 120),
            description: requiredString(body, "description", 1_000),
            source,
            availability,
            expectedRevision: requiredRevision(body, "expectedRevision"),
            files,
            idempotencyKey: requiredString(body, "idempotencyKey", 128),
          });
          const {
            manifestR2Key: _manifestR2Key,
            ownerGeneration: _generation,
            files: _files,
            ...safe
          } = receipt;
          return json(safe, receipt.status === "conflict" ? 409 : 200);
        }
        if (
          args.request.method === "GET" &&
          url.pathname === "/cloud-home/skills/export"
        ) {
          const requestedAgentType = url.searchParams.get("agentType");
          if (
            requestedAgentType !== "general" &&
            requestedAgentType !== "orchestrator"
          ) {
            throw new CloudHomeProtocolError("agentType was invalid.", 400);
          }
          const agentType = requestedAgentType;
          const snapshot = await home.loadSkillCatalog(agentType);
          const skills = await Promise.all(
            snapshot.entries.map(async (entry) => ({
              skillId: entry.skillId,
              slug: entry.slug,
              name: entry.name,
              description: entry.description,
              source: entry.source,
              availability: entry.availability,
              revision: entry.revision,
              versionId: entry.versionId,
              manifestSha256: entry.manifestSha256,
              treeSha256: entry.treeSha256,
              files: await Promise.all(
                entry.files.map(async (file) => ({
                  path: file.path,
                  sha256: file.sha256,
                  sizeBytes: file.sizeBytes,
                  contentType: file.contentType,
                  base64: bytesBase64(
                    await home.readSkillFile(
                      snapshot,
                      entry.skillId,
                      file.path,
                    ),
                  ),
                })),
              ),
            })),
          );
          return json({ ownerGeneration, agentType, skills });
        }
        return json({ error: "Not found." }, 404);
      },
    );
  } catch (error) {
    return routeError(error);
  }
};
