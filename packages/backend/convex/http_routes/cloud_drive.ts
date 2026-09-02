import type { HttpRouter } from "convex/server";
import { makeFunctionReference } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  DRIVE_INLINE_FILE_LIMIT_BYTES,
  buildDriveSyncManifest,
  driveObjectKey,
  driveProducedObjectKey,
  driveRevisionPath,
  normalizeDriveFileReport,
  putDriveObject,
  reconcileDriveObject,
  type DriveFileReport,
  type NormalizedDriveFile,
} from "../cloud_drive";
import { assertOwnerDataAccessActive } from "../owner_lifecycle";
import { r2 } from "../r2_files";
import {
  authorizeControlPlaneRequest,
  type ControlPlaneTurnAuthority,
} from "../lib/capability_verify";

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const serviceAuthorized = (request: Request): boolean => {
  const secret = process.env.BUILDER_SERVICE_SECRET?.trim();
  return Boolean(
    secret && request.headers.get("authorization") === `Bearer ${secret}`,
  );
};

type TurnAuthority = Pick<
  ControlPlaneTurnAuthority,
  "ownerId" | "ownerGeneration" | "turnId"
>;

/**
 * Last barrier before drive I/O on behalf of a turn: the capability proved the
 * turn; this refuses only once Convex has seen the turn end.
 */
const assertTurnActive = async (
  ctx: { runMutation: (ref: any, args: any) => Promise<any> },
  turn: TurnAuthority,
): Promise<void> => {
  await ctx.runMutation(internal.cloud_apps.assertActiveTurnDispatchInternal, {
    ownerId: turn.ownerId,
    ownerGeneration: turn.ownerGeneration,
    turnId: turn.turnId,
    now: Date.now(),
  });
};

type DriveSkip = { path: string; reason: string };

const checkDriveWriteRef = makeFunctionReference<
  "query",
  { ownerId: string; files: Array<{ path: string; sizeBytes: number }> },
  {
    plan: string;
    accepted: Array<{ path: string; sizeBytes: number }>;
    skipped: DriveSkip[];
  }
>("cloud_drive:checkDriveWriteInternal");
const recordDriveFilesRef = makeFunctionReference<"mutation", any, any>(
  "cloud_drive:recordDriveFilesInternal",
);
const queueDriveObjectCleanupRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    path: string;
    r2Key: string;
    notBefore: number;
    now: number;
  },
  null
>("cloud_drive:queueDriveObjectCleanupInternal");
const cleanupCanceledPendingUploadRef = makeFunctionReference<
  "action",
  { r2Key: string; attempt?: number },
  { deleted: boolean }
>("cloud_drive:cleanupCanceledPendingUploadInternal");
const isDriveObjectKeyReferencedRef = makeFunctionReference<
  "query",
  { r2Key: string },
  boolean
>("cloud_drive:isDriveObjectKeyReferencedInternal");
const driveWriteBaselineRef = makeFunctionReference<
  "query",
  { ownerId: string; ownerGeneration: string; paths: string[] },
  Array<{
    path: string;
    source: string;
    origin: string;
    writeKey?: string;
    updatedAt: number;
  }>
>("cloud_drive:getDriveWriteBaselineInternal");

type DriveRename = { from: string; to: string; reason: string };

/**
 * The key a batch of produced files is recorded under, scoped to the turn that
 * reported it. `batchKey` only has to be stable across redeliveries of one
 * batch and distinct between the batches of one turn — the turn id is what
 * makes it unique across turns, so no caller can pick a key that collides with
 * another turn's write.
 */
const driveWriteKey = (
  turnId: string | undefined,
  batchKey: unknown,
): string | undefined => {
  if (!turnId) return undefined;
  const value = typeof batchKey === "string" ? batchKey.trim() : "";
  return value ? `${turnId}:${value.slice(0, 64)}` : undefined;
};

/**
 * The one rule that keeps the drive coherent in the destructive direction:
 * bytes the user uploaded are only replaceable by a turn that read them.
 *
 * Every reported body is first written under a unique immutable object key.
 * A turn proves it read the current version by echoing the
 * row's `updatedAt` back as `knownUpdatedAt`; anything else is diverted to a
 * sibling path so both versions survive, and the divert is reported so the
 * agent's own summary can say which name its work actually landed under.
 *
 * Rows the agent itself produced (`origin` anything but "upload") are its own
 * output and stay freely overwritable — versioning those would turn every
 * iterative turn into a pile of "(agent copy)" files.
 *
 * The test is `origin`, not `source`: `source` is whoever wrote the bytes
 * that are there now, so the first legitimate edit of an upload would set it
 * to "agent" and spend the protection permanently. What earns the protection
 * is the file having come from the user, which no later edit changes.
 *
 * `writeKey` is the one thing that can excuse a version mismatch. A batch
 * whose response was lost is redelivered with the version token it read before
 * its first attempt, and that attempt has already moved the row past it — so
 * on the second attempt the batch fails its own test and its work is diverted
 * to a sibling nobody asked for. A row that already records this exact write
 * is this batch's own footprint, not a version it never saw.
 */
const applyUploadWriteRule = (
  files: NormalizedDriveFile[],
  baseline: Map<
    string,
    { origin: string; writeKey?: string; updatedAt: number }
  >,
  writeKey: string | undefined,
): {
  files: NormalizedDriveFile[];
  renamed: DriveRename[];
  skipped: DriveSkip[];
} => {
  const protectedByUpload = (path: string, knownUpdatedAt: number | null) => {
    const row = baseline.get(path);
    return (
      row !== undefined &&
      row.origin === "upload" &&
      row.updatedAt !== knownUpdatedAt &&
      !(writeKey !== undefined && row.writeKey === writeKey)
    );
  };
  const renamed: DriveRename[] = [];
  const skipped: DriveSkip[] = [];
  const resolved: NormalizedDriveFile[] = [];
  for (const file of files) {
    if (!protectedByUpload(file.path, file.knownUpdatedAt)) {
      resolved.push(file);
      continue;
    }
    const to = driveRevisionPath(file.path);
    // The sibling is an unread upload too: there is nowhere safe to put this
    // version, so it stays in the workspace rather than displacing either.
    if (protectedByUpload(to, null)) {
      skipped.push({
        path: file.path,
        reason: `${file.path} and ${to} are both files you uploaded that this turn did not read, so it was not saved over either.`,
      });
      continue;
    }
    renamed.push({
      from: file.path,
      to,
      reason: `${file.path} is a file you uploaded that this turn did not read, so this version was saved as ${to}.`,
    });
    resolved.push({
      ...file,
      path: to,
      name: to.slice(to.lastIndexOf("/") + 1),
    });
  }
  return { files: resolved, renamed, skipped };
};

// Chat-turn image attachments: bounded so the signed batch can never
// approach the relay's request cap once base64-expanded.
const CHAT_ATTACHMENT_MAX_COUNT = 4;
const CHAT_ATTACHMENT_MAX_BYTES = 3 * 1024 * 1024;

export function registerCloudDriveRoutes(http: HttpRouter) {
  // The orchestrator DO's image hydration: a chat turn whose prompt carries
  // drive image attachments asks for short-lived GETs so the model actually
  // sees the pixels, not just the paths. Turn-capability scoped — a turn can
  // only read its own owner's drive — and deliberately narrow: images only,
  // hard size/count caps, point lookups by exact path.
  http.route({
    path: "/api/cloud/drive/attachments",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const auth = await authorizeControlPlaneRequest(ctx, request);
      if (!auth.ok) return auth.response;
      const token = auth.authority;
      const body = (await request.json().catch(() => ({}))) as {
        turnId?: string;
        paths?: unknown;
      };
      if (body.turnId && token.turnId !== body.turnId) {
        return json({ error: "Forbidden" }, 403);
      }
      const paths = Array.isArray(body.paths)
        ? body.paths
            .filter((entry): entry is string => typeof entry === "string")
            .slice(0, CHAT_ATTACHMENT_MAX_COUNT)
        : [];
      if (paths.length === 0) return json({ ok: true, attachments: [] });
      const rows = (await ctx.runQuery(
        internal.cloud_drive.listDriveSyncRowsInternal,
        {
          ownerId: token.ownerId,
          ownerGeneration: token.ownerGeneration,
          limit: 1,
          paths,
        },
      )) as Array<{
        path: string;
        r2Key: string;
        sizeBytes: number;
        contentType: string;
      }>;
      const wanted = new Set(paths);
      const attachments: Array<{
        path: string;
        contentType: string;
        sizeBytes: number;
        url: string;
      }> = [];
      const skipped: Array<{ path: string; reason: string }> = [];
      try {
        await assertTurnActive(ctx, token);
      } catch {
        return json({ error: "Cloud turn is no longer active." }, 409);
      }
      for (const row of rows) {
        request.signal.throwIfAborted();
        if (!wanted.has(row.path)) continue;
        wanted.delete(row.path);
        if (!row.contentType.startsWith("image/")) {
          skipped.push({ path: row.path, reason: "not an image" });
          continue;
        }
        if (row.sizeBytes > CHAT_ATTACHMENT_MAX_BYTES) {
          skipped.push({ path: row.path, reason: "too large to inline" });
          continue;
        }
        const url = await r2.getUrl(row.r2Key, { expiresIn: 120 });
        request.signal.throwIfAborted();
        attachments.push({
          path: row.path,
          contentType: row.contentType,
          sizeBytes: row.sizeBytes,
          url,
        });
      }
      for (const path of wanted) {
        skipped.push({ path, reason: "not in the drive" });
      }
      return json({ ok: true, attachments, skipped });
    }),
  });
  // The read half of C3<->C2: what a turn's workspace should contain before
  // the agent runs. Answers with short-lived signed GETs the executor
  // materializes into the sandbox, plus the row versions it is answering
  // with, which are what the turn echoes back when it reports its own writes.
  //
  // It also answers with what the workspace must stop holding. The workspace
  // is checkpointed, so a file the user deleted from the drive survives in it
  // unless something says otherwise: the caller sends the `syncedAt` it kept
  // from its last successful sync as `since`, gets back the paths deleted
  // since then, and persists the new `syncedAt` only once it has applied
  // them. The cursor lives with the checkpoint, so a restored workspace and
  // its cursor are always the same age.
  http.route({
    path: "/api/cloud/drive/sync",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const auth = await authorizeControlPlaneRequest(ctx, request);
      if (!auth.ok) return auth.response;
      const token = auth.authority;
      const body = (await request.json().catch(() => ({}))) as {
        turnId?: string;
        include?: unknown;
        since?: unknown;
        have?: unknown;
      };
      if (body.turnId && token.turnId !== body.turnId) {
        return json({ error: "Forbidden" }, 403);
      }
      // The turn row is a projection that may land after the turn's first
      // sync; when it is here it must agree with the capability.
      const turn = await ctx.runQuery(
        internal.cloud_drive.getTurnDriveIdentityInternal,
        { turnId: token.turnId },
      );
      if (turn && turn.ownerId !== token.ownerId) {
        return json({ error: "Forbidden" }, 403);
      }
      const include = Array.isArray(body.include)
        ? body.include.filter(
            (entry): entry is string => typeof entry === "string",
          )
        : [];
      const since =
        typeof body.since === "number" && Number.isFinite(body.since)
          ? Math.max(0, Math.floor(body.since))
          : 0;
      // The paths the caller's workspace is holding. It gets a per-path answer
      // for these rather than having to read deletion out of what the (capped)
      // file list happens to name — the difference between "this row is gone"
      // and "this row is not in the window I read".
      const have = Array.isArray(body.have)
        ? body.have.filter(
            (entry): entry is string => typeof entry === "string",
          )
        : [];
      try {
        await assertTurnActive(ctx, token);
      } catch {
        return json({ error: "Cloud turn is no longer active." }, 409);
      }
      // The owner's whole drive, which is exactly what the turn capability
      // already reaches: one owner, one drive, one world to hydrate it into.
      const manifest = await buildDriveSyncManifest(
        ctx,
        token.ownerId,
        token.ownerGeneration,
        "",
        include,
        since,
        have,
        request.signal,
      );
      return json({ ok: true, ...manifest });
    }),
  });

  // C4: an agent turn reports the files it produced. Bytes under the inline
  // limit are uploaded here; anything larger registers metadata only and stays
  // in the workspace for the next turn to pick up.
  http.route({
    path: "/api/cloud/drive/files",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      // Two callers: a turn (capability) reporting the files it produced, and
      // the platform (service secret) writing on an owner's behalf.
      const service = serviceAuthorized(request);
      let token: TurnAuthority | null = null;
      if (!service) {
        const auth = await authorizeControlPlaneRequest(ctx, request);
        if (!auth.ok) return auth.response;
        token = auth.authority;
      }
      const body = (await request.json()) as {
        turnId?: string;
        ownerId?: string;
        ownerGeneration?: string;
        source?: string;
        batchKey?: string;
        files?: DriveFileReport[];
      };
      // A turn capability speaks only for its own turn, and only ever for the
      // owner the Durable Object admitted it for.
      if (token && body.turnId && token.turnId !== body.turnId) {
        return json({ error: "Forbidden" }, 403);
      }
      const ownerId = token?.ownerId ?? body.ownerId;
      if (!ownerId) return json({ error: "ownerId required" }, 400);
      const ownerGeneration =
        token?.ownerGeneration ??
        (typeof body.ownerGeneration === "string"
          ? body.ownerGeneration.trim()
          : "");
      if (!ownerGeneration) {
        return json({ error: "ownerGeneration required" }, 400);
      }
      try {
        const current = await assertOwnerDataAccessActive(ctx, ownerId);
        if (current.generation !== ownerGeneration) {
          return json({ error: "Owner data generation is stale" }, 409);
        }
      } catch {
        return json({ error: "Owner data is unavailable" }, 409);
      }
      const writeKey = driveWriteKey(
        token?.turnId ?? body.turnId,
        body.batchKey,
      );

      let files;
      try {
        files = normalizeDriveFileReport(body.files ?? []);
      } catch (error) {
        return json(
          {
            error:
              (error as { data?: { message?: string } }).data?.message ??
              "Invalid files payload.",
          },
          400,
        );
      }

      const skipped: DriveSkip[] = [];
      // Whether this write comes from a turn that was shown the drive before
      // it ran. A service write is nobody's turn and reads nothing. It decides
      // one thing only: whether `replaced` can mean anything here (see below).
      let hydrated = false;
      if (token) {
        // The capability proves which turn is writing and for which owner;
        // the projected turn row, when it has landed, must agree and says
        // whether this kind of turn was shown the drive first.
        const turn = await ctx.runQuery(
          internal.cloud_drive.getTurnDriveIdentityInternal,
          { turnId: token.turnId },
        );
        if (turn && turn.ownerId !== ownerId) {
          return json({ error: "Forbidden" }, 403);
        }
        hydrated = turn?.hydratesDrive ?? false;
      }

      // Non-destructive before quota: a file diverted here is a different
      // path, and the quota answer for the path it lands on is the one that
      // matters.
      const baselineRows = await ctx.runQuery(driveWriteBaselineRef, {
        ownerId,
        ownerGeneration,
        paths: [
          ...new Set(
            files.flatMap((file) => [file.path, driveRevisionPath(file.path)]),
          ),
        ],
      });
      const baseline = new Map(
        baselineRows.map((row) => [
          row.path,
          {
            origin: row.origin,
            ...(row.writeKey ? { writeKey: row.writeKey } : {}),
            updatedAt: row.updatedAt,
          },
        ]),
      );
      const rule = applyUploadWriteRule(files, baseline, writeKey);
      files = rule.files;
      skipped.push(...rule.skipped);

      // Gate before spending R2 writes; recordDriveFilesInternal re-checks
      // transactionally, so a race can still reject after the upload. Both
      // gates answer per file: one oversized deliverable must not strand the
      // rest of the turn's output in a sandbox the user cannot browse.
      const verdict = await ctx.runQuery(checkDriveWriteRef, {
        ownerId,
        files: files.map((file) => ({
          path: file.path,
          sizeBytes: file.sizeBytes,
        })),
      });
      skipped.push(...verdict.skipped);
      const acceptedByPath = new Map(
        verdict.accepted.map((file) => [file.path, file.sizeBytes]),
      );
      files = files.filter(
        (file) => acceptedByPath.get(file.path) === file.sizeBytes,
      );

      // Writes that land on a row the turn never read. An agent-origin row is
      // the turn's own earlier output and stays freely overwritable — a drive
      // is not a version control system and every iterative turn would
      // otherwise pile up "(agent copy)" siblings. But the sync manifest is a
      // bounded window, so on a large drive the turn may never have been told
      // the row existed, and "the agent rewrote its own file" and "the agent
      // replaced a year-old report it was never shown" look identical from
      // here. They are not identical to the user, so this one says so.
      //
      // It can only say so where the turn was shown anything. Missing version
      // token means "this turn never read the row" for a drive turn and
      // nothing at all for the rest: a `project:` or `app:` turn hydrates no
      // drive by design, so every path it re-delivers is missing one, on every
      // turn, forever — a twenty-file iteration ending in twenty sentences
      // about files the agent had just written itself. Firing there does not
      // add a warning, it spends the one this design has left for the real
      // case, because a user (and an orchestrator paraphrasing for one) learns
      // in two turns that the sentence means nothing.
      //
      // For a drive turn it stays quiet for the normal case by construction: a
      // turn that hydrated the file echoes its version, a copy the manifest
      // could not fit but the workspace is still holding echoes the version
      // its ledger recorded, and a redelivered batch carries its own write
      // key. None of the three reaches this list.
      const replaced: DriveSkip[] = [];
      for (const file of hydrated ? files : []) {
        const row = baseline.get(file.path);
        if (!row || row.origin === "upload") continue;
        if (row.updatedAt === file.knownUpdatedAt) continue;
        if (writeKey !== undefined && row.writeKey === writeKey) continue;
        replaced.push({
          path: file.path,
          reason: `${file.path} was already in your drive from an earlier turn, and this turn saved over it without opening it first.`,
        });
      }

      const reported =
        typeof body.source === "string" && body.source.trim()
          ? body.source.trim().slice(0, 40)
          : "agent";
      // "upload" is the one value a report may not claim: it is what sets a
      // row's permanent provenance, and only the user putting bytes there
      // through `finalizeDriveUpload` earns it.
      const source = reported === "upload" ? "agent" : reported;
      const recorded: Array<{
        path: string;
        r2Key: string;
        name: string;
        sizeBytes: number;
        contentType: string;
        source: string;
      }> = [];
      const queuePotentialOrphans = async (
        entries: typeof recorded,
      ): Promise<void> => {
        for (const entry of entries) {
          if (entry.source === "workspace") continue;
          const now = Date.now();
          try {
            await ctx.runMutation(queueDriveObjectCleanupRef, {
              ownerId,
              ownerGeneration,
              path: entry.path,
              r2Key: entry.r2Key,
              notBefore: now,
              now,
            });
          } catch {
            // Generation rotation can reject the cleanup-row write. The key is
            // immutable and unique to this request. After proving no row names
            // it, hand the exact locator to the durable cleanup chain; it
            // cannot race a later relink and never relies on best-effort I/O.
            const referenced = await ctx
              .runQuery(isDriveObjectKeyReferencedRef, {
                r2Key: entry.r2Key,
              })
              .catch(() => true);
            if (!referenced) {
              // The scheduler payload is the durable last locator. The
              // cleanup action publishes its successor before provider I/O,
              // directly confirms R2 absence, and only then removes component
              // metadata. Never let this route forget a key while the
              // component's asynchronous physical-delete retrier is pending.
              await ctx.scheduler.runAfter(0, cleanupCanceledPendingUploadRef, {
                r2Key: entry.r2Key,
              });
            }
          }
        }
      };
      if (token) {
        try {
          await assertTurnActive(ctx, token);
        } catch {
          return json({ error: "Cloud turn is no longer active." }, 409);
        }
      }
      try {
        for (const file of files) {
          request.signal.throwIfAborted();
          // `writeKey` is logical idempotency only. Physical object keys are
          // unique per PUT so a stale batch can never relink a retired key
          // after cleanup has proved it unreferenced.
          const objectWriteId = crypto.randomUUID();
          const r2Key = file.bytes
            ? await driveProducedObjectKey(ownerId, objectWriteId, file.path)
            : await driveObjectKey(ownerId, file.path);
          const entry = {
            path: file.path,
            r2Key,
            name: file.name,
            sizeBytes: file.sizeBytes,
            contentType: file.contentType,
            // Metadata-only rows say so: their bytes are still in the
            // workspace, so a download URL would presign a missing object.
            source: file.bytes ? source : "workspace",
          };
          if (file.bytes) {
            // Track the key before PUT so an ambiguous storage response is
            // still reclaimed.
            recorded.push(entry);
            await putDriveObject(
              ownerId,
              file.path,
              file.bytes,
              file.contentType,
              r2Key,
              request.signal,
            );
          } else {
            recorded.push(entry);
          }
        }
      } catch (error) {
        // No row mutation has run yet; every tracked object is unlinked.
        await queuePotentialOrphans(recorded);
        throw error;
      }

      let result: {
        authorityAccepted: boolean;
        files: Array<Record<string, unknown>>;
        skipped: DriveSkip[];
        replacedR2Keys: string[];
      };
      try {
        result =
          recorded.length > 0
            ? ((await ctx.runMutation(recordDriveFilesRef, {
                ownerId,
                ownerGeneration,
                ...(token ? { turnAuthority: { turnId: token.turnId } } : {}),
                files: recorded,
                ...(writeKey ? { writeKey } : {}),
                now: Date.now(),
              })) as typeof result)
            : {
                authorityAccepted: true,
                files: [],
                skipped: [],
                replacedR2Keys: [],
              };
      } catch (error) {
        // If the transaction response was ambiguous, reference-aware cleanup
        // keeps a committed key and reclaims only keys that never became rows.
        await queuePotentialOrphans(recorded);
        throw error;
      }
      if (!result.authorityAccepted) {
        return json(
          {
            error: "Cloud turn is no longer active.",
            skipped: result.skipped,
            renamed: rule.renamed,
            files: [],
          },
          409,
        );
      }
      // The mutation atomically queued every replaced immutable key for
      // leased, retryable cleanup; no action-plane read/delete race remains.
      skipped.push(...result.skipped);
      // A file the transactional re-check turned away has already had its
      // bytes PUT; leaving them would charge the platform for storage no row
      // and no quota counts. Bytes with no row are dropped — but where a row
      // still names this key, that PUT has already replaced the file it points
      // at, so the row is moved onto the new bytes (and charged for them)
      // instead of the owner losing the file to a quota race.
      const raced = new Set(result.skipped.map((entry) => entry.path));
      for (const entry of recorded) {
        if (entry.source === "workspace" || !raced.has(entry.path)) continue;
        await reconcileDriveObject(ctx, {
          ownerId,
          ownerGeneration,
          path: entry.path,
          r2Key: entry.r2Key,
          storedBytes: entry.sizeBytes,
          claimedBytes: entry.sizeBytes,
        });
      }

      const storedByPath = new Map(
        recorded.map((entry) => [entry.path, entry.source !== "workspace"]),
      );
      // Nothing landed at all: answer as the failure it is, so the turn's
      // report says the delivery failed rather than silently showing no files.
      if (result.files.length === 0 && skipped.length > 0) {
        return json(
          {
            error: skipped[0]!.reason,
            skipped,
            renamed: rule.renamed,
            files: [],
          },
          413,
        );
      }
      // Only for the writes that survived the transactional re-check: a file
      // the quota turned away replaced nothing.
      const written = new Set(result.files.map((file) => file.path as string));
      return json({
        ok: true,
        inlineLimitBytes: DRIVE_INLINE_FILE_LIMIT_BYTES,
        files: result.files.map((file) => ({
          ...file,
          stored: storedByPath.get(file.path as string) === true,
        })),
        skipped,
        renamed: rule.renamed,
        replaced: replaced.filter((entry) => written.has(entry.path)),
      });
    }),
  });
}
