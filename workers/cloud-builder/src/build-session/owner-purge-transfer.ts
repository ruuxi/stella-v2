// Owner purge and the world push/pull route.
//
// Cut verbatim out of `src/index.ts`. Nothing here touches the `BuildSession`
// Durable Object instance, so there is no host interface: these are the
// top-level collaborators that the worker router and a handful of class
// methods call with an explicit `env`.
import type { LegacyDirectoryBackup as DirectoryBackup } from "../sandbox-client.js";
import { sha256Hex } from "../hash.js";
import { checkpointBackupName, checkpointKey } from "../workspace.js";
import {
  isOwnerAppBuildPrefix,
  ownerAppBuildRoot,
} from "../app-build-artifacts.js";
import {
  HEADER_OWNER_FENCE_ID,
  type OwnerPurgeFence,
  type OwnerPurgeMode,
} from "../owner-fence-do.js";
import type { CloudHomeLeaseRunner } from "../cloud-home-routes.js";
import { withOwnerActivityLease } from "../owner-activity-lease.js";
import {
  verifyWorldCapability,
  worldCapabilityFromRequest,
} from "../world-capability.js";
import {
  WORLD_BLOB_BATCH_MAX_BYTES,
  WORLD_BLOB_BATCH_MAX_WIRE_BYTES,
  WORLD_FILE_LIMIT_BYTES,
  type WorldListingEntry,
} from "../world/types.js";
import {
  boundedBodyStatus,
  bufferBoundedJsonRequest,
} from "../request-ingress.js";
import {
  nativeStateBackupName,
  nativeStateCheckpointPrefix,
  parseNativeStateCheckpointRecord,
} from "../native-state-checkpoint.js";
import type { Env } from "./shared/env.js";
import type {
  OwnerPurgeReport,
  OwnerPurgeRequest,
  WorkspaceBackupDebt,
} from "./shared/types.js";
import { OwnerPurgeFenceError } from "./shared/errors.js";
import {
  backupDebtKey,
  errorMessage,
  json,
  log,
  nativeBackupDebtKey,
  BACKUP_ID_PATTERN,
  R2_SWEEP_MAX_PAGES,
  sweepR2Prefix,
} from "./shared/keys.js";

const ownerFenceStub = (env: Env, ownerId: string) =>
  env.OWNER_GATES.getByName(ownerId);

export const callOwnerFence = async (
  env: Env,
  ownerId: string,
  path: string,
  body: Record<string, unknown>,
): Promise<Response> =>
  ownerFenceStub(env, ownerId).fetch(`https://owner-gate/owner-fence/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [HEADER_OWNER_FENCE_ID]: ownerId,
    },
    body: JSON.stringify({ ...body, ownerId }),
  });

export const cloudHomeLeaseRunner =
  (env: Env): CloudHomeLeaseRunner =>
  async (ownerId, ownerGeneration, activityId, operation) =>
    await withOwnerActivityLease(
      (path, body) => callOwnerFence(env, ownerId, path, body),
      ownerGeneration,
      activityId,
      async (generation, leaseId) =>
        await operation(async () => {
          const asserted = await callOwnerFence(env, ownerId, "assert", {
            ownerGeneration,
            generation,
            leaseId,
          });
          if (!asserted.ok) throw new OwnerPurgeFenceError();
        }),
    );

export const beginOwnerPurge = async (
  env: Env,
  ownerId: string,
  mode: OwnerPurgeMode,
  requestId: string,
  expectedGeneration?: string,
): Promise<{ generation: string; rejoined?: true }> => {
  let response = await callOwnerFence(env, ownerId, "begin", {
    mode,
    requestId,
    ...(expectedGeneration !== undefined ? { expectedGeneration } : {}),
  });
  if (!response.ok) throw new Error("Owner purge fence could not be created.");
  let state = (await response.json()) as {
    generation?: string;
    active?: OwnerPurgeFence["active"];
    rejoined?: boolean;
  };
  if (!state.generation) throw new Error("Owner purge fence was unreadable.");
  const generation = state.generation;
  const rejoined = state.rejoined === true;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const active = Object.values(state.active ?? {});
    if (active.length === 0) {
      return { generation, ...(rejoined ? { rejoined: true } : {}) };
    }
    await Promise.all(
      active.map(
        async ({ leaseId, sessionId, turnId, namespace, ownerGeneration }) => {
          if (namespace === "activity") return;
          try {
            const target =
              namespace === "orchestrator"
                ? env.ORCHESTRATOR_SESSIONS
                : env.BUILD_SESSIONS;
            const id = target.idFromString(sessionId);
            await target
              .get(id)
              .fetch("https://build-session/owner-purge-cancel", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  ownerId,
                  turnId,
                  ownerGeneration: ownerGeneration ?? "legacy",
                  generation,
                  leaseId,
                }),
              });
          } catch (error) {
            log("error", "owner_purge_turn_cancel_failed", {
              sessionId,
              message: errorMessage(error),
            });
          }
        },
      ),
    );
    await scheduler.wait(250);
    response = await callOwnerFence(env, ownerId, "assert-blocked", {
      generation,
    });
    if (!response.ok)
      throw new Error("Owner purge fence changed unexpectedly.");
    state = (await response.json()) as typeof state;
  }
  throw new Error("Owner cloud turns did not quiesce before purge.");
};

/** The slug a hosted app route is keyed by. */
export const APP_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/**
 * A caller-supplied R2 prefix is a bucket-wipe primitive, so it is matched
 * against the shapes this worker writes rather than merely checked for
 * non-emptiness.
 */
export const LEGACY_BUILD_PREFIX_PATTERN = /^builds\/[A-Za-z0-9_-]{1,64}$/;

/**
 * Backfill for checkpoints written before cleanup debt existed. The sandbox
 * SDK stores `{name}` in `backups/<uuid>/meta.json`; our name is derived from
 * the owner/workspace checkpoint key, so a full metadata scan can attribute
 * old random backup ids without guessing or deleting another owner's data.
 */
const sweepBackupsByName = async (
  bucket: R2Bucket,
  name: string,
): Promise<{ deleted: number; done: boolean }> => {
  const backupIds = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < R2_SWEEP_MAX_PAGES; page += 1) {
    const listing = await bucket.list({
      prefix: "backups/",
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const object of listing.objects) {
      const match = object.key.match(/^backups\/([0-9a-f-]{36})\/meta\.json$/i);
      if (!match || !BACKUP_ID_PATTERN.test(match[1]!)) continue;
      const metadata = await bucket.get(object.key);
      if (!metadata) continue;
      const parsed = (await metadata.json().catch(() => null)) as {
        name?: string | null;
      } | null;
      if (parsed?.name === name) backupIds.add(match[1]!);
    }
    if (!listing.truncated) {
      let deleted = 0;
      for (const backupId of backupIds) {
        const swept = await sweepR2Prefix(bucket, `backups/${backupId}/`);
        deleted += swept.deleted;
        if (!swept.done) return { deleted, done: false };
      }
      return { deleted, done: true };
    }
    cursor = listing.cursor;
  }
  return { deleted: 0, done: false };
};

export const purgeNativeStateForWorkspace = async (
  env: Pick<Env, "APP_ROUTES" | "BACKUP_BUCKET">,
  workspaceKey: string,
): Promise<{ deleted: number; keys: number }> => {
  const prefix = nativeStateCheckpointPrefix(workspaceKey);
  const keys: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < R2_SWEEP_MAX_PAGES; page += 1) {
    const listing = await env.APP_ROUTES.list({
      prefix,
      limit: 1_000,
      ...(cursor ? { cursor } : {}),
    });
    keys.push(...listing.keys.map((entry) => entry.name));
    if (listing.list_complete) {
      cursor = undefined;
      break;
    }
    cursor = listing.cursor;
  }
  if (cursor) throw new Error("Native checkpoint listing was truncated.");

  let deleted = 0;
  const debtKey = nativeBackupDebtKey(workspaceKey);
  const debt = await env.APP_ROUTES.get<WorkspaceBackupDebt>(debtKey, "json");
  for (const backupId of debt?.backupIds ?? []) {
    if (!BACKUP_ID_PATTERN.test(backupId)) {
      throw new Error("Native backup debt descriptor is invalid.");
    }
    const swept = await sweepR2Prefix(
      env.BACKUP_BUCKET,
      `backups/${backupId}/`,
    );
    deleted += swept.deleted;
    if (!swept.done) throw new Error("Native backup debt purge was truncated.");
  }
  for (const key of keys) {
    const raw = await env.APP_ROUTES.get<unknown>(key, "json");
    const record = raw ? parseNativeStateCheckpointRecord(raw) : null;
    const backupIds = new Set<string>();
    if (record) {
      for (const version of [
        ...(record.committed ? [record.committed] : []),
        ...record.candidates,
      ]) {
        backupIds.add(version.descriptor.id);
      }
    }
    for (const backupId of backupIds) {
      if (!BACKUP_ID_PATTERN.test(backupId)) {
        throw new Error("Native checkpoint backup descriptor is invalid.");
      }
      const swept = await sweepR2Prefix(
        env.BACKUP_BUCKET,
        `backups/${backupId}/`,
      );
      deleted += swept.deleted;
      if (!swept.done)
        throw new Error("Native checkpoint purge was truncated.");
    }
    // Also catches createBackup -> descriptor-persist crash or a malformed KV
    // record. The name is a one-way derivative of this exact native key.
    const historical = await sweepBackupsByName(
      env.BACKUP_BUCKET,
      await nativeStateBackupName(key),
    );
    deleted += historical.deleted;
    if (!historical.done) {
      throw new Error("Historical native checkpoint purge was truncated.");
    }
    await env.APP_ROUTES.delete(key);
  }
  await env.APP_ROUTES.delete(debtKey);
  return { deleted, keys: keys.length };
};

export const purgeOwnerStorage = async (
  env: Env,
  ownerId: string,
  request: OwnerPurgeRequest,
): Promise<OwnerPurgeReport> => {
  const pending: string[] = [];
  let deleted = 0;
  const fail = (store: string, error: unknown): void => {
    pending.push(store);
    log("error", "owner_storage_purge_step_failed", {
      store,
      message: errorMessage(error),
    });
  };

  const ownerHash = await sha256Hex(ownerId);
  const prefixTargets: {
    store: string;
    bucket: R2Bucket | undefined;
    prefix: string;
  }[] = [
    {
      store: "agent-home",
      bucket: env.AGENT_HOME,
      prefix: `agent-home/${ownerHash}/`,
    },
    {
      store: "conversations",
      bucket: env.CONVERSATION_ARCHIVE,
      prefix: `conversations/${ownerHash}/`,
    },
    {
      // New mini-app builds are owner-addressable before the callback exists,
      // so a crash orphan is still discoverable by account reset/deletion.
      store: "app-builds",
      bucket: env.APP_BUILDS,
      prefix: `${ownerAppBuildRoot(ownerHash)}/`,
    },
  ];
  for (const target of prefixTargets) {
    // An unbound bucket is a deployment that has no such store, not a store
    // that failed to empty.
    if (!target.bucket) continue;
    try {
      const swept = await sweepR2Prefix(target.bucket, target.prefix);
      deleted += swept.deleted;
      if (!swept.done) pending.push(target.store);
    } catch (error) {
      fail(target.store, error);
    }
  }

  // The world checkpoint. The archive is named only by the descriptor, so the
  // descriptor is deleted last: a crash between the two leaves a KV key
  // pointing at bytes that are already gone (harmless — restore fails and the
  // world starts cold), never bytes with nothing left that names them.
  await (async (): Promise<void> => {
    const store = "checkpoint:world";
    try {
      const key = await checkpointKey(ownerId);
      const nativePurge = await purgeNativeStateForWorkspace(env, key);
      deleted += nativePurge.deleted + nativePurge.keys;
      const descriptor = await env.APP_ROUTES.get<DirectoryBackup>(key, "json");
      const debtKey = backupDebtKey(key);
      const debt = await env.APP_ROUTES.get<WorkspaceBackupDebt>(
        debtKey,
        "json",
      );
      // The live descriptor, cleanup debt, and the name-derived historical
      // backups together name every archive this checkpoint ever wrote.
      const backupIds = new Set<string>(debt?.backupIds ?? []);
      if (descriptor?.id) backupIds.add(descriptor.id);
      let backupSweepFailed = false;
      for (const backupId of backupIds) {
        if (!BACKUP_ID_PATTERN.test(backupId)) {
          pending.push(`${store}:invalid-backup`);
          backupSweepFailed = true;
          continue;
        }
        const swept = await sweepR2Prefix(
          env.BACKUP_BUCKET,
          `backups/${backupId}/`,
        );
        deleted += swept.deleted;
        if (!swept.done) {
          pending.push(store);
          backupSweepFailed = true;
        }
      }
      if (backupSweepFailed) return;
      const historical = await sweepBackupsByName(
        env.BACKUP_BUCKET,
        checkpointBackupName(key),
      );
      deleted += historical.deleted;
      if (!historical.done) {
        pending.push(`${store}:historical-backups`);
        return;
      }
      await env.APP_ROUTES.delete(key);
      await env.APP_ROUTES.delete(debtKey);
      // Counted only when there was something to delete: `deleted` is read off
      // the log to see how much an account actually held, and a fixed number
      // of unconditional KV deletes would drown that.
      if (descriptor) deleted += 1;
    } catch (error) {
      fail(store, error);
    }
  })();

  // Hosted app routes. Deleting the row is strictly stronger than suspending
  // it, and the ownership check keeps a slug that has since been reissued to
  // someone else out of this owner's deletion.
  for (const slug of request.appSlugs ?? []) {
    if (typeof slug !== "string" || !APP_SLUG_PATTERN.test(slug)) {
      pending.push("route:unparseable");
      continue;
    }
    const store = `route:${slug}`;
    try {
      const route = await env.APP_ROUTES.get<{ ownerId?: string }>(
        `app:${slug}`,
        "json",
      );
      if (route && route.ownerId !== ownerId) continue;
      await env.APP_ROUTES.delete(`app:${slug}`);
      if (route) deleted += 1;
    } catch (error) {
      fail(store, error);
    }
  }

  // Build artifacts: the owner's app code and assets, still served by the
  // apps host until they are gone.
  for (const prefix of request.buildPrefixes ?? []) {
    if (
      typeof prefix !== "string" ||
      !(
        LEGACY_BUILD_PREFIX_PATTERN.test(prefix) ||
        isOwnerAppBuildPrefix(prefix, ownerHash)
      )
    ) {
      pending.push("build:unparseable");
      continue;
    }
    try {
      const swept = await sweepR2Prefix(env.APP_BUILDS, `${prefix}/`);
      deleted += swept.deleted;
      if (!swept.done) pending.push(`build:${prefix}`);
    } catch (error) {
      fail(`build:${prefix}`, error);
    }
  }

  return { ok: true, deleted, pending: Array.from(new Set(pending)) };
};

export const boundedIngressRequest = async (
  request: Request,
  maxBytes: number,
): Promise<Request | Response> => {
  try {
    return await bufferBoundedJsonRequest(request, maxBytes);
  } catch (error) {
    const status = boundedBodyStatus(error);
    if (status === null) throw error;
    return json(
      {
        code: status === 413 ? "request_too_large" : "bad_request",
        message:
          status === 413
            ? "Request body is too large."
            : "Malformed JSON request.",
      },
      status,
    );
  }
};

const parseWorldPushListing = (value: unknown): WorldListingEntry[] | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = (value as Record<string, unknown>).entries;
  if (!Array.isArray(entries) || entries.length > 200_000) return null;
  const parsed: WorldListingEntry[] = [];
  for (const value of entries) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const row = value as Record<string, unknown>;
    if (
      typeof row.path !== "string" ||
      (row.kind !== "file" && row.kind !== "dir" && row.kind !== "symlink") ||
      !Number.isSafeInteger(row.mode) ||
      !Number.isSafeInteger(row.mtime) ||
      !Number.isSafeInteger(row.size) ||
      Number(row.size) < 0 ||
      (row.kind === "file" &&
        (typeof row.sha256 !== "string" ||
          !/^[0-9a-f]{64}$/u.test(row.sha256))) ||
      (row.kind === "symlink" && typeof row.target !== "string")
    )
      return null;
    parsed.push({
      path: row.path,
      kind: row.kind,
      mode: Number(row.mode),
      mtime: Number(row.mtime),
      size: Number(row.size),
      ...(typeof row.sha256 === "string" ? { sha256: row.sha256 } : {}),
      ...(typeof row.target === "string" ? { target: row.target } : {}),
    });
  }
  return parsed;
};

export const handleWorldRoute = async (
  request: Request,
  env: Env,
  world: string,
  action:
    | { kind: "export" }
    | { kind: "changes" }
    | { kind: "blob"; sha256: string }
    | { kind: "push" },
): Promise<Response> => {
  const authorization = await verifyWorldCapability({
    secret: env.BUILDER_SERVICE_SECRET,
    capability: worldCapabilityFromRequest(request),
    worldName: world,
    now: Date.now(),
  }).catch(() => ({ ok: false as const }));
  if (!authorization.ok)
    return json({ error: "World capability was rejected." }, 403);
  const stub = env.WORLDS.getByName(world);
  if (action.kind === "changes") {
    if (request.method !== "GET")
      return json({ error: "Method not allowed." }, 405);
    const since = Number(new URL(request.url).searchParams.get("since"));
    if (!Number.isSafeInteger(since) || since < 0) {
      return json({ error: "Malformed world revision." }, 400);
    }
    return json(await stub.changesSince(since));
  }
  if (action.kind === "blob") {
    if (request.method !== "GET")
      return json({ error: "Method not allowed." }, 405);
    const blob = await stub.exportBlob(action.sha256);
    if (!blob) return json({ error: "World blob was not found." }, 404);
    return new Response(blob.body, {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(blob.size),
        "cache-control": "private, no-store",
      },
    });
  }
  if (action.kind === "export") {
    if (request.method !== "GET")
      return json({ error: "Method not allowed." }, 405);
    const requested = new URL(request.url).searchParams.get("manifest");
    const manifestId = requested ?? (await stub.head()).manifestId;
    if (!(await stub.manifest(manifestId, { limit: 1 }))) {
      return json({ error: "World manifest was not found." }, 404);
    }
    const exported = await stub.exportTar(manifestId);
    return new Response(exported.body, {
      headers: {
        "content-type": "application/x-tar",
        "cache-control": "private, no-store",
        "x-stella-world-manifest": manifestId,
        "x-stella-world-revision": String(exported.revision),
      },
    });
  }
  if (request.method !== "POST")
    return json({ error: "Method not allowed." }, 405);
  const blobSha = request.headers.get("x-stella-world-blob-sha256");
  if (blobSha) {
    const size = Number(request.headers.get("content-length"));
    if (
      !/^[0-9a-f]{64}$/u.test(blobSha) ||
      !request.body ||
      !Number.isSafeInteger(size) ||
      size <= WORLD_BLOB_BATCH_MAX_BYTES ||
      size > WORLD_FILE_LIMIT_BYTES
    ) {
      return json({ error: "Malformed world blob upload." }, 400);
    }
    try {
      const outcome = await stub.putBlob(request.body, {
        sha256: blobSha,
        size,
      });
      return json({ outcomes: [outcome] }, outcome.accepted ? 200 : 422);
    } catch (error) {
      return json({ error: errorMessage(error) }, 400);
    }
  }
  const requestType = request.headers.get("content-type")?.split(";", 1)[0];
  if (requestType === "application/vnd.stella.world-blobs") {
    if (!request.body) return json({ error: "Missing world blob batch." }, 400);
    const contentLength = Number(request.headers.get("content-length"));
    if (
      Number.isFinite(contentLength) &&
      contentLength > WORLD_BLOB_BATCH_MAX_WIRE_BYTES
    ) {
      return json({ error: "World blob batch exceeds 32 MiB." }, 413);
    }
    try {
      const outcomes = await stub.putBlobs(request.body);
      return json(
        { outcomes },
        outcomes.every((outcome) => outcome.accepted) ? 200 : 422,
      );
    } catch (error) {
      const message = errorMessage(error);
      return json(
        { error: message },
        /exceeds the (?:32 MiB request|512 blob) limit/u.test(message)
          ? 413
          : 400,
      );
    }
  }
  const listing = parseWorldPushListing(await request.json().catch(() => null));
  if (!listing) return json({ error: "Malformed world listing." }, 400);
  const delta = await stub.diff(listing);
  const changed = new Set(delta.changed);
  const pushed = await stub.pushDiff({
    entries: listing.filter((entry) => changed.has(entry.path)),
    deleted: delta.deleted,
  });
  return json({ ok: pushed.missingBlobs.length === 0, ...pushed });
};
