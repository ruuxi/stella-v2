import {
  OWNER_PRODUCT_TRANSFER_LEASE_MS,
  assertOwnerTransferReservation,
  ownerTransferLeaseConflicts,
} from "./owner-product-transfer.js";
import {
  normalizeOwnerGeneration,
  ownerGenerationMatches,
  ownerPurgeBeginDisposition,
  ownerPurgeReleaseDisposition,
} from "./owner-generation.js";
import {
  OwnerFenceStore,
  type LegacyOwnerFenceActiveMirror,
  type OwnerFenceLeaseNamespace,
  type OwnerFenceLeaseRole,
} from "./owner-fence-store.js";
import { handleTurnStateOwnerRoute } from "./turn-state-owner-routes.js";

export const HEADER_OWNER_FENCE_ID = "x-stella-owner-fence-id";
export const OWNER_FENCE_LEASE_TTL_MS = 30 * 60_000;

export type OwnerPurgeMode = "temporary" | "permanent";
export type OwnerPurgeFence = {
  /** Bound on the first trusted direct call into this owner-named DO. */
  ownerId?: string;
  generation: string;
  /** Convex lifecycle operation that created the current blocked fence. */
  beginRequestId?: string;
  /** Makes a durable retry of the last temporary release idempotent. */
  lastReleasedGeneration?: string;
  /** Released generation whose rejoin produced the current blocked fence. */
  rejoinedFromGeneration?: string;
  state: "open" | "blocked";
  mode?: OwnerPurgeMode;
  /** SQL rows are authoritative; `active` remains a bounded rollback mirror. */
  leaseStorageVersion?: 2;
  active: Record<
    string,
    {
      leaseId: string;
      sessionId: string;
      turnId: string;
      namespace: "build" | "orchestrator" | "activity";
      role: "run" | "aux" | "orchestrator" | "activity" | "transfer";
      /** Convex owner-lifecycle generation carried by the admitted activity. */
      ownerGeneration?: string;
      /** Fence generation returned when this exact lease was admitted. */
      reservationGeneration?: string;
      workspace?: string;
      /** Optional bounded lease used by cross-service control-plane work. */
      expiresAt?: number;
    }
  >;
};

type OwnerFenceHostEnv = Pick<
  Cloudflare.Env,
  "BACKUP_BUCKET" | "BUILDER_SERVICE_SECRET"
>;

export type OwnerFenceHost = {
  fetch(path: string, request: Request): Promise<Response>;
  alarm(now: number): Promise<number | null>;
  nextDeadline(): Promise<number | null>;
};

/**
 * A local owner-gate barrier that must complete before the fence commits an
 * authority-changing begin or transfer lease. It receives only parsed route
 * data, never request headers or credentials.
 */
export type OwnerFenceAuthorityChangeHook = (args: {
  path: "begin" | "register";
  body: Readonly<Record<string, unknown>>;
}) => Promise<void>;

const json = (body: unknown, status = 200): Response =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

const log = (
  level: "info" | "error",
  event: string,
  fields: Record<string, unknown> = {},
) => {
  console[level](
    JSON.stringify({
      service: "stella-v2-cloud-builder",
      event,
      timestamp: new Date().toISOString(),
      ...fields,
    }),
  );
};

class DurableObjectOwnerFenceHost implements OwnerFenceHost {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: OwnerFenceHostEnv,
    private readonly beforeAuthorityChange?: OwnerFenceAuthorityChangeHook,
  ) {}

  async fetch(path: string, request: Request): Promise<Response> {
    const turnStateRoute = path.startsWith("turn-state/");
    const body = (turnStateRoute ? {} : await request.json()) as {
      ownerId?: string;
      generation?: string;
      expectedGeneration?: string;
      requestId?: string;
      leaseId?: string;
      ownerGeneration?: string;
      mode?: OwnerPurgeMode;
      sessionId?: string;
      turnId?: string;
      namespace?: "build" | "orchestrator" | "activity";
      role?: "run" | "aux" | "orchestrator" | "activity" | "transfer";
      workspace?: string;
      expiresAt?: number;
    };
    const current = (await this.ctx.storage.get<OwnerPurgeFence>(
      "ownerPurgeFence",
    )) ?? {
      generation: crypto.randomUUID(),
      state: "open",
      active: {},
    };
    const scopedOwnerId =
      (turnStateRoute
        ? request.headers.get(HEADER_OWNER_FENCE_ID)
        : body.ownerId
      )?.trim() ?? "";
    if (
      !scopedOwnerId ||
      scopedOwnerId.length > 512 ||
      /[\u0000-\u001f\u007f]/u.test(scopedOwnerId) ||
      (current.ownerId !== undefined && current.ownerId !== scopedOwnerId)
    ) {
      return json({ error: "Owner fence identity does not match." }, 409);
    }
    const now = Date.now();
    const leaseStore = new OwnerFenceStore(this.ctx.storage.sql);
    leaseStore.initialize(now);
    if (current.ownerId === undefined || current.leaseStorageVersion !== 2) {
      let migrationFailed = false;
      await this.ctx.storage.transaction(async (txn) => {
        if (current.ownerId === undefined) current.ownerId = scopedOwnerId;
        if (current.leaseStorageVersion !== 2) {
          const migrated = leaseStore.migrateLegacyActiveMirror({
            ownerId: scopedOwnerId,
            fenceGeneration: current.generation,
            active: current.active as LegacyOwnerFenceActiveMirror,
            now,
          });
          if (migrated.invalid.length > 0 || migrated.conflicts.length > 0) {
            migrationFailed = true;
            return;
          }
          current.leaseStorageVersion = 2;
        }
        const mirror = leaseStore.boundedLegacyActiveMirror(now);
        if (mirror.status !== "complete") {
          migrationFailed = true;
          return;
        }
        current.active = mirror.active;
        await txn.put("ownerPurgeFence", current);
        const nextExpiry = leaseStore.nextExpiry();
        if (nextExpiry !== null) {
          const existingAlarm = await txn.getAlarm();
          if (existingAlarm === null || existingAlarm > nextExpiry) {
            await txn.setAlarm(nextExpiry);
          }
        }
      });
      if (migrationFailed) {
        log("error", "owner_fence_lease_migration_blocked", {
          activeLeaseCount: Object.keys(current.active).length,
        });
        return json(
          {
            code: "lease_migration_blocked",
            error: "Owner lease migration is blocked.",
          },
          503,
        );
      }
    } else {
      const expired = leaseStore.expireDueLeases(now);
      if (expired.length > 0) {
        const mirror = leaseStore.boundedLegacyActiveMirror(now);
        if (mirror.status !== "complete") {
          return json(
            { code: "lease_capacity", error: "Owner lease capacity exceeded." },
            503,
          );
        }
        current.active = mirror.active;
        await this.ctx.storage.put("ownerPurgeFence", current);
      }
    }
    if (turnStateRoute) {
      const response = await handleTurnStateOwnerRoute({
        path,
        request,
        scopedOwnerId,
        fence: {
          ownerId: scopedOwnerId,
          generation: current.generation,
          state: current.state,
          active: current.active as LegacyOwnerFenceActiveMirror,
        },
        storage: this.ctx.storage,
        bucket: this.env.BACKUP_BUCKET,
        nativeIntegritySecret: this.env.BUILDER_SERVICE_SECRET,
      });
      if (response) return response;
    }
    if (path === "register") {
      const ownerGeneration = normalizeOwnerGeneration(body.ownerGeneration);
      const activeLeases = Object.values(current.active);
      const isTransferControlActivity =
        body.role === "activity" &&
        (body.turnId?.startsWith("owner-product-transfer:") ||
          body.turnId?.startsWith("owner-transfer:"));
      const transferBusy =
        body.role === "transfer"
          ? activeLeases.some((lease) =>
              lease.role === "transfer"
                ? ownerTransferLeaseConflicts(lease, body)
                : !(
                    lease.role === "activity" &&
                    (lease.turnId.startsWith("owner-product-transfer:") ||
                      lease.turnId.startsWith("owner-transfer:"))
                  ),
            )
          : activeLeases.some((lease) => lease.role === "transfer") &&
            !isTransferControlActivity;
      const invalidTransferExpiry =
        body.role === "transfer" &&
        (typeof body.expiresAt !== "number" ||
          !Number.isFinite(body.expiresAt) ||
          body.expiresAt <= now ||
          body.expiresAt > now + OWNER_PRODUCT_TRANSFER_LEASE_MS);
      if (current.state !== "open") {
        return json(
          {
            code:
              current.mode === "permanent"
                ? "owner_purge_permanent"
                : "owner_purge_temporary",
            error: "Owner purge is active.",
          },
          409,
        );
      }
      if (transferBusy) {
        return json(
          { code: "transfer_busy", error: "Owner activity is busy." },
          409,
        );
      }
      if (
        (body.generation !== undefined &&
          body.generation !== current.generation) ||
        !body.leaseId ||
        !body.sessionId ||
        !body.turnId ||
        !ownerGeneration ||
        invalidTransferExpiry
      ) {
        return json(
          { code: "bad_request", error: "Invalid owner lease." },
          400,
        );
      }
      const namespace: OwnerFenceLeaseNamespace =
        body.namespace === "orchestrator"
          ? "orchestrator"
          : body.namespace === "activity"
            ? "activity"
            : "build";
      const role: OwnerFenceLeaseRole =
        body.role === "run"
          ? "run"
          : body.role === "orchestrator"
            ? "orchestrator"
            : body.role === "transfer"
              ? "transfer"
              : body.role === "activity"
                ? "activity"
                : "aux";
      const expiresAt =
        typeof body.expiresAt === "number" &&
        Number.isFinite(body.expiresAt) &&
        body.expiresAt > now
          ? body.expiresAt
          : now + OWNER_FENCE_LEASE_TTL_MS;
      const registration = {
        leaseId: body.leaseId,
        ownerId: scopedOwnerId,
        ownerGeneration,
        reservationGeneration: current.generation,
        sessionId: body.sessionId,
        turnId: body.turnId,
        namespace,
        role,
        expiresAt,
      };
      if (
        !leaseStore.activeLease(body.leaseId, now) &&
        leaseStore.activeLeaseCount(now) >= 512
      ) {
        return json(
          { code: "lease_capacity", error: "Owner lease capacity exceeded." },
          503,
        );
      }
      if (role === "transfer") {
        await this.beforeAuthorityChange?.({
          path: "register",
          body: body as Readonly<Record<string, unknown>>,
        });
      }
      let result!: ReturnType<OwnerFenceStore["registerLeaseExact"]>;
      await this.ctx.storage.transaction(async (txn) => {
        result = leaseStore.registerLeaseExact(registration, now);
        if (result.status === "replayed") {
          const renewed = leaseStore.renewLeaseExact(
            result.lease,
            expiresAt,
            now,
          );
          if (renewed.status === "renewed") {
            result = { status: "replayed", lease: renewed.lease };
          }
        }
        if (result.status === "conflict") return;
        const mirror = leaseStore.boundedLegacyActiveMirror(now);
        if (mirror.status !== "complete") {
          throw new Error("Owner fence rollback mirror exceeded its bound.");
        }
        current.active = mirror.active;
        await txn.put("ownerPurgeFence", current);
        const nextExpiry = leaseStore.nextExpiry();
        if (nextExpiry !== null) {
          const existingAlarm = await txn.getAlarm();
          if (existingAlarm === null || existingAlarm > nextExpiry) {
            await txn.setAlarm(nextExpiry);
          }
        }
      });
      if (result.status === "conflict") {
        return json(
          {
            code: "bad_request",
            error: "Owner lease identity conflicts.",
          },
          409,
        );
      }
      return json({
        generation: current.generation,
        expiresAt: result.lease.expiresAt,
      });
    }
    if (path === "unregister") {
      if (!body.leaseId || !body.sessionId || !body.turnId) {
        return json({ error: "Invalid owner lease." }, 400);
      }
      const active = leaseStore.lease(body.leaseId);
      if (!active || active.state === "retired") {
        return json({ ok: true, alreadyUnregistered: true });
      }
      if (
        active.sessionId !== body.sessionId ||
        active.turnId !== body.turnId ||
        (active.ownerGeneration !== undefined &&
          !ownerGenerationMatches(active.ownerGeneration, body.ownerGeneration))
      ) {
        return json({ error: "Owner lease identity does not match." }, 409);
      }
      await this.ctx.storage.transaction(async (txn) => {
        const retired = leaseStore.retireLeaseExact(active, now);
        if (
          retired.status !== "retired" &&
          retired.status !== "already_retired"
        ) {
          throw new Error("Exact owner lease retirement failed.");
        }
        const mirror = leaseStore.boundedLegacyActiveMirror(now);
        if (mirror.status !== "complete") {
          throw new Error("Owner fence rollback mirror exceeded its bound.");
        }
        current.active = mirror.active;
        await txn.put("ownerPurgeFence", current);
      });
      return json({ ok: true });
    }
    if (path === "renew") {
      if (
        current.state !== "open" ||
        body.generation !== current.generation ||
        !body.leaseId ||
        !body.sessionId ||
        !body.turnId
      ) {
        return json({ error: "Owner purge fence changed." }, 409);
      }
      const lease = leaseStore.activeLease(body.leaseId, now);
      if (
        !lease ||
        lease.sessionId !== body.sessionId ||
        lease.turnId !== body.turnId ||
        !ownerGenerationMatches(lease.ownerGeneration, body.ownerGeneration)
      ) {
        return json({ error: "Owner lease identity does not match." }, 409);
      }
      const expiresAt = now + OWNER_FENCE_LEASE_TTL_MS;
      let renewed!: ReturnType<OwnerFenceStore["renewLeaseExact"]>;
      await this.ctx.storage.transaction(async (txn) => {
        renewed = leaseStore.renewLeaseExact(lease, expiresAt, now);
        if (renewed.status !== "renewed") return;
        const mirror = leaseStore.boundedLegacyActiveMirror(now);
        if (mirror.status !== "complete") {
          throw new Error("Owner fence rollback mirror exceeded its bound.");
        }
        current.active = mirror.active;
        await txn.put("ownerPurgeFence", current);
        const nextExpiry = leaseStore.nextExpiry();
        if (nextExpiry !== null) {
          const existingAlarm = await txn.getAlarm();
          if (existingAlarm === null || existingAlarm > nextExpiry) {
            await txn.setAlarm(nextExpiry);
          }
        }
      });
      return renewed.status === "renewed"
        ? json({ ok: true, expiresAt: renewed.lease.expiresAt })
        : json({ error: "Owner purge fence changed." }, 409);
    }
    if (path === "assert") {
      if (
        current.state !== "open" ||
        body.generation !== current.generation ||
        !body.leaseId
      ) {
        return json({ error: "Owner purge fence changed." }, 409);
      }
      const lease = leaseStore.activeLease(body.leaseId, now);
      if (
        !lease ||
        !ownerGenerationMatches(lease.ownerGeneration, body.ownerGeneration)
      ) {
        return json({ error: "Owner purge fence changed." }, 409);
      }
      // Assertions still check the live fence and exact lease every time.
      // Renew only when half the lease remains instead of adding a replicated
      // write to every validation within the same short turn.
      if (lease.expiresAt - now > OWNER_FENCE_LEASE_TTL_MS / 2) {
        return json({ ok: true, expiresAt: lease.expiresAt });
      }
      const expiresAt = now + OWNER_FENCE_LEASE_TTL_MS;
      let renewed!: ReturnType<OwnerFenceStore["renewLeaseExact"]>;
      await this.ctx.storage.transaction(async (txn) => {
        renewed = leaseStore.renewLeaseExact(lease, expiresAt, now);
        if (renewed.status !== "renewed") return;
        const mirror = leaseStore.boundedLegacyActiveMirror(now);
        if (mirror.status !== "complete") {
          throw new Error("Owner fence rollback mirror exceeded its bound.");
        }
        current.active = mirror.active;
        await txn.put("ownerPurgeFence", current);
        const nextExpiry = leaseStore.nextExpiry();
        if (nextExpiry !== null) {
          const existingAlarm = await txn.getAlarm();
          if (existingAlarm === null || existingAlarm > nextExpiry) {
            await txn.setAlarm(nextExpiry);
          }
        }
      });
      return renewed.status === "renewed"
        ? json({ ok: true, expiresAt: renewed.lease.expiresAt })
        : json({ error: "Owner purge fence changed." }, 409);
    }
    if (path === "assert-transfer") {
      const lease = body.leaseId ? current.active[body.leaseId] : undefined;
      const assertion = assertOwnerTransferReservation(lease, body, current);
      if (assertion.ok) {
        // A purge that began after this reservation must wait for transfer
        // acknowledgement (or its bounded expiry). Normal turn assertions
        // still fail as soon as the purge fence closes.
        return json({ ok: true, generation: current.generation });
      }
      return json(
        {
          code: assertion.code,
          error: "Ownership-transfer reservation is no longer active.",
        },
        409,
      );
    }
    if (path === "assert-blocked") {
      return current.state === "blocked" &&
        body.generation === current.generation
        ? json({
            ok: true,
            active: current.active,
            ...(current.beginRequestId
              ? { beginRequestId: current.beginRequestId }
              : {}),
          })
        : json({ error: "Owner purge generation is not active." }, 409);
    }
    if (path === "begin") {
      const requestedMode =
        body.mode === "permanent" ? "permanent" : "temporary";
      const disposition = ownerPurgeBeginDisposition({
        state: current.state,
        mode: current.mode,
        generation: current.generation,
        beginRequestId: current.beginRequestId,
        lastReleasedGeneration: current.lastReleasedGeneration,
        rejoinedFromGeneration: current.rejoinedFromGeneration,
        requestId: body.requestId,
        expectedGeneration: body.expectedGeneration,
        requestedMode,
      });
      if (disposition.action === "reject") {
        return json({ error: "Owner purge generation cannot be joined." }, 409);
      }
      if (
        disposition.action === "start" ||
        disposition.upgradeToPermanent
      ) {
        await this.beforeAuthorityChange?.({
          path: "begin",
          body: body as Readonly<Record<string, unknown>>,
        });
      }
      if (disposition.action === "start") {
        current.generation = crypto.randomUUID();
        current.beginRequestId = normalizeOwnerGeneration(body.requestId)!;
        current.state = "blocked";
        current.mode = disposition.mode;
        if (disposition.rejoined) {
          current.rejoinedFromGeneration = normalizeOwnerGeneration(
            body.expectedGeneration,
          )!;
        } else {
          delete current.rejoinedFromGeneration;
        }
      } else if (disposition.upgradeToPermanent) {
        current.mode = "permanent";
      }
      await this.ctx.storage.put("ownerPurgeFence", current);
      return json({
        generation: current.generation,
        mode: current.mode,
        active: current.active,
        ...(disposition.rejoined ? { rejoined: true } : {}),
      });
    }
    if (path === "release") {
      const disposition = ownerPurgeReleaseDisposition({
        state: current.state,
        mode: current.mode,
        generation: current.generation,
        lastReleasedGeneration: current.lastReleasedGeneration,
        requestedGeneration: body.generation,
        activeLeaseCount: leaseStore.activeLeaseCount(now),
      });
      if (disposition === "already-released") {
        return json({
          ok: true,
          generation: current.generation,
          alreadyReleased: true,
        });
      }
      if (disposition !== "release") {
        return json({ error: "Owner purge fence cannot be released." }, 409);
      }
      current.lastReleasedGeneration = current.generation;
      current.generation = crypto.randomUUID();
      current.state = "open";
      delete current.beginRequestId;
      delete current.mode;
      delete current.rejoinedFromGeneration;
      await this.ctx.storage.put("ownerPurgeFence", current);
      return json({ ok: true, generation: current.generation });
    }
    return json({ error: "Not found." }, 404);
  }

  async alarm(now: number): Promise<number | null> {
    const fence =
      await this.ctx.storage.get<OwnerPurgeFence>("ownerPurgeFence");
    if (fence?.leaseStorageVersion !== 2) return null;
    const store = new OwnerFenceStore(this.ctx.storage.sql);
    store.initialize(now);
    await this.ctx.storage.transaction(async (txn) => {
      store.expireDueLeases(now);
      const mirror = store.boundedLegacyActiveMirror(now);
      if (mirror.status !== "complete") {
        throw new Error("Owner fence rollback mirror exceeded its bound.");
      }
      fence.active = mirror.active;
      await txn.put("ownerPurgeFence", fence);
    });
    return store.nextExpiry();
  }

  async nextDeadline(): Promise<number | null> {
    const fence =
      await this.ctx.storage.get<OwnerPurgeFence>("ownerPurgeFence");
    if (fence?.leaseStorageVersion !== 2) return null;
    const store = new OwnerFenceStore(this.ctx.storage.sql);
    store.initialize();
    return store.nextExpiry();
  }
}

export const createOwnerFenceHost = (args: {
  ctx: DurableObjectState;
  env: OwnerFenceHostEnv;
  beforeAuthorityChange?: OwnerFenceAuthorityChangeHook;
}): OwnerFenceHost => new DurableObjectOwnerFenceHost(
  args.ctx,
  args.env,
  args.beforeAuthorityChange,
);
