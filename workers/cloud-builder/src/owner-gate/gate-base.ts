import { OwnerHomeContextCache } from "../owner-home-context.js";
import type { ModelGatewayControl } from "../managed-request-cancellation.js";
import { OwnerStore } from "../owner-store/store.js";
import { ownerRegistry } from "../owner-store/domains.js";
import type {
  OwnerHost,
  OwnerPurgeMode,
  OwnerRegistry,
} from "../owner-store/registry.js";
import { RpcError } from "../owner-store/errors.js";
import {
  SOCKET_KEEPALIVE_PING,
  SOCKET_KEEPALIVE_PONG,
} from "@stella/contracts/backend/protocol";
import { DurableObject } from "cloudflare:workers";
import type { GatewayUsageEvent } from "@stella/contracts/gateway/usage";
import type { TelemetryEventV1 } from "@stella/contracts/telemetry";
import { DeviceRequestRelay } from "../device-request-relay.js";
import type { DeviceToolRelay } from "../device-tool-relay.js";
import type { AgentMessageDeviceOutcome } from "@stella/contracts/turn-plane/placement";
import { sha256Hex } from "@stella/contracts/turn-plane/pairing-proof";
import { OwnerFenceStore } from "../owner-fence-store.js";
import {
  type OwnerModelGrant,
  type OwnerModelGrantRevokeAllInput,
  OwnerModelGrantStore,
} from "../owner-model-grants.js";
import { MemoryPolicyError, OwnerMemoryPolicy } from "../memory-policy.js";
import {
  applyMemoryPolicyChange,
  readMemoryPolicy,
} from "../owner-store/domains/home.js";
import type {
  MemoryPolicy,
  MemoryPolicyChange,
} from "@stella/contracts/turn-plane/memory-policy";
import {
  createOwnerFenceHost,
  HEADER_OWNER_FENCE_ID,
} from "../owner-fence-do.js";
import type {
  OwnerGateEnv,
  OwnerGateFenceLeaseRequest,
  OwnerGateFenceLeaseOutcome,
} from "./types.js";
import {
  OWNER_GATE_RUNNING_GRACE_MS,
  DEFAULT_TURN_TIMEOUT_MS,
  OWNER_MODEL_GRANT_FREEZE_TIMEOUT_MS,
  CLOUD_CHAT_READER_PREPARE_TIMEOUT_MS,
  CLOUD_CHAT_READER_PREPARE_CACHE_MAX,
} from "./constants.js";
import { DDL } from "./schema.js";
import { withTimeout, ownerFenceRequest, log } from "./support.js";

/**
 * `OwnerGate` (see `../owner-gate.ts`) is one Durable Object class split by
 * concern into a chain of layers, each extending the one below it:
 *
 *   gate-base → device-sockets → dispatch → cloud-dispatch → OwnerGate
 *
 * `OwnerGate` itself declares every public (RPC) method. This bottom layer
 * holds every field, so fields are initialized exactly once and in their
 * original order, plus the owner store, model grant, memory policy and owner
 * fence plumbing. A layer calls only down the chain, except for the few
 * methods declared abstract where a lower layer needs one implemented above
 * it.
 */
export abstract class OwnerGateBase extends DurableObject<OwnerGateEnv> {
  protected schemaReady = false;
  /** Steers waiting for their device's `steer.ack`, by dispatch and message. */
  protected readonly steerAcks = new Map<
    string,
    (delivered: boolean) => void
  >();
  /** Local-agent messages waiting for `agent-message.ack`, by device and message. */
  protected readonly localAgentMessageAcks = new Map<
    string,
    (outcome: AgentMessageDeviceOutcome) => void
  >();
  protected deviceRequestRelayState?: DeviceRequestRelay;
  /** Loaded with the first device tool call; until then no call is pending. */
  protected deviceToolRelayState?: DeviceToolRelay;
  protected ownerStoreState?: OwnerStore;
  protected ownerHostState?: OwnerHost;

  protected gatewayOwnerPreparation?: Promise<void>;
  protected memoryPolicyState?: OwnerMemoryPolicy;
  protected homeContextState?: OwnerHomeContextCache;

  protected ownerModelGrantState?: OwnerModelGrantStore;
  // A prepared reader nonce is advisory and only usable by the turn that
  // started its wake. Later turns must read the durable registration, since an
  // Orchestrator restart can replace that nonce.
  protected cloudChatReaderPreparationState?: Map<string, Promise<void>>;
  protected cloudChatReaderPreparedState?: Set<string>;

  constructor(ctx: DurableObjectState, env: OwnerGateEnv) {
    super(ctx, env);
    // Keepalives from the live socket and device presence sockets are
    // answered by the platform, so a connected but idle owner can hibernate.
    // A JSON heartbeat ran this object every 10 seconds, which never let it
    // go idle long enough to hibernate and billed it around the clock. Set on
    // every cold start, as the conversation hub does, so whether the pair
    // survives eviction never matters.
    try {
      ctx.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair(
          SOCKET_KEEPALIVE_PING,
          SOCKET_KEEPALIVE_PONG,
        ),
      );
    } catch (error) {
      log("error", "owner_gate_autoresponse_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  /** The domains this object serves. Test fixtures substitute their own. */
  protected backendRegistry(): OwnerRegistry {
    return ownerRegistry;
  }

  /** Run a write on the owner's database outside a backend call, then push views and arm jobs. */
  protected async billingWrite<T>(
    write: (ctx: ReturnType<OwnerStore["context"]>) => T | Promise<T>,
  ): Promise<T> {
    const store = this.ownerStore();
    try {
      return await write(store.context(null));
    } finally {
      store.flush();
      await this.scheduleAlarm(Date.now());
    }
  }

  /**
   * Charged model calls to analytics, under this owner's pseudonym: what
   * the old usage ledger used to log. Best effort.
   */
  protected async reportCharges(events: GatewayUsageEvent[]): Promise<void> {
    const telemetry = this.env.TELEMETRY as
      | {
          ingestForOwner(
            ownerId: string,
            events: TelemetryEventV1[],
          ): Promise<void>;
        }
      | undefined;
    const charged = events.filter(
      (event) => event.billable && event.outcome !== "failed",
    );
    if (!telemetry || charged.length === 0) return;
    const environment =
      this.env.TELEMETRY_ENVIRONMENT === "production"
        ? "production"
        : "development";
    await telemetry
      .ingestForOwner(
        this.ownerId(),
        charged.map((event) => ({
          schemaVersion: 1,
          eventId: crypto.randomUUID(),
          occurredAtMs: event.finishedAt,
          project: "stella",
          environment,
          source: "cloud-builder",
          event: {
            type: "inference.completed",
            provider: event.provider,
            model: event.resolvedModel,
            agentType: event.agentType,
            durationMs: Math.max(0, event.finishedAt - event.startedAt),
            success: event.outcome === "succeeded",
            inputTokens: event.usage.inputTokens,
            outputTokens: event.usage.outputTokens,
            ...(event.usage.cachedInputTokens !== undefined
              ? { cachedInputTokens: event.usage.cachedInputTokens }
              : {}),
            ...(event.usage.cacheWriteTokens !== undefined
              ? { cacheWriteInputTokens: event.usage.cacheWriteTokens }
              : {}),
            ...(event.usage.reasoningTokens !== undefined
              ? { reasoningTokens: event.usage.reasoningTokens }
              : {}),
            totalTokens: event.usage.inputTokens + event.usage.outputTokens,
            costMicroCents: event.chargedMicroCents,
          },
        })),
      )
      .catch((error: unknown) => {
        log("error", "billing_telemetry_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }

  /** One reset or deletion pass across every store; see src/owner-purge.ts. */
  protected async purgeOwnerPass(
    mode: OwnerPurgeMode,
    requestId: string,
  ): Promise<{ pending: string[] }> {
    const { runOwnerPurge } = await import("../owner-purge.js");
    return await runOwnerPurge({
      env: this.env as unknown as import("../build-session/shared/env.js").Env,
      ownerId: this.ownerId(),
      mode,
      requestId,
      purgeOwnerData: () => this.purgeOwnerData({ mode }),
    });
  }

  protected homeContextCache() {
    return (this.homeContextState ??= new OwnerHomeContextCache(
      this.ctx.storage,
    ));
  }

  protected modelGrants(): OwnerModelGrantStore {
    return (this.ownerModelGrantState ??= new OwnerModelGrantStore(
      this.ctx,
      this.ownerId(),
    ));
  }

  protected prepareCloudChatReader(
    sessions: NonNullable<OwnerGateEnv["ORCHESTRATOR_SESSIONS"]>,
    conversationId: string,
  ): Promise<string | undefined> {
    const preparations = (this.cloudChatReaderPreparationState ??= new Map<
      string,
      Promise<void>
    >());
    const prepared = (this.cloudChatReaderPreparedState ??= new Set<string>());
    if (prepared.has(conversationId)) return Promise.resolve(undefined);
    const existing = preparations.get(conversationId);
    // The first caller owns the nonce from a shared wake. Other concurrent
    // callers wait for the wake but resolve their reader from durable state.
    if (existing) return existing.then(() => undefined);
    const preparation = withTimeout(
      (
        sessions.getByName(conversationId) as unknown as {
          prepareCloudChatReader(): Promise<unknown>;
        }
      ).prepareCloudChatReader(),
      CLOUD_CHAT_READER_PREPARE_TIMEOUT_MS,
      "Cloud chat reader preparation timed out.",
    )
      .then((readerId) =>
        typeof readerId === "string" &&
        readerId.length > 0 &&
        readerId.length <= 512
          ? readerId
          : undefined,
      )
      .catch(() => undefined);
    const completion = preparation
      .then((readerId) => {
        if (readerId === undefined) return;
        if (prepared.size >= CLOUD_CHAT_READER_PREPARE_CACHE_MAX) {
          const oldest = prepared.values().next().value;
          if (oldest !== undefined) prepared.delete(oldest);
        }
        prepared.add(conversationId);
      })
      .finally(() => {
        if (preparations.get(conversationId) === completion)
          preparations.delete(conversationId);
      });
    preparations.set(conversationId, completion);
    return preparation;
  }

  protected async revokeModelReaders(
    args: Omit<OwnerModelGrantRevokeAllInput, "freeze">,
  ): Promise<void> {
    const sessions = this.env.ORCHESTRATOR_SESSIONS;
    await this.modelGrants().revokeAll({
      ...args,
      freeze: async (request) => {
        if (!sessions)
          throw new Error("Conversation execution is not configured.");
        await withTimeout(
          sessions
            .getByName(request.conversationId)
            .freezeOwnerModelGrants(request),
          OWNER_MODEL_GRANT_FREEZE_TIMEOUT_MS,
          "Owner model grant freeze timed out.",
        );
      },
    });
  }

  /** One owner-fence host call from this object; `fetch()` routes external ones. */
  protected ownerFenceCall(
    path: string,
    body: unknown,
    headers?: Record<string, string>,
  ): Promise<Response> {
    return createOwnerFenceHost({ ctx: this.ctx, env: this.env }).fetch(
      path,
      ownerFenceRequest(path, body, headers),
    );
  }

  protected async issueModelGrant(args: {
    ownerId: string;
    ownerGeneration: string;
    conversationId: string;
    readerId: string;
    turnId: string;
    leaseId: string;
    fenceGeneration: string;
    policy: MemoryPolicy;
    expiresAt: number;
  }): Promise<OwnerModelGrant> {
    return await this.memoryPolicy().authorizeGrant(
      args.policy,
      args.fenceGeneration,
      async () => {
        const lease = new OwnerFenceStore(this.ctx.storage.sql).activeLease(
          args.leaseId,
        );
        const sessions = this.env.ORCHESTRATOR_SESSIONS;
        if (
          !lease ||
          !sessions ||
          lease.ownerId !== args.ownerId ||
          lease.ownerGeneration !== args.ownerGeneration ||
          lease.turnId !== args.turnId ||
          lease.sessionId !==
            sessions.idFromName(args.conversationId).toString() ||
          lease.reservationGeneration !== args.fenceGeneration ||
          lease.expiresAt !== args.expiresAt ||
          lease.namespace !== "orchestrator" ||
          lease.role !== "orchestrator"
        )
          throw new MemoryPolicyError("OWNER_FENCE_CHANGED");
        await this.modelGrants().registerReader({
          conversationId: args.conversationId,
          readerId: args.readerId,
        });
        const result = await this.modelGrants().issueGrant({
          ownerId: args.ownerId,
          ownerGeneration: args.ownerGeneration,
          conversationId: args.conversationId,
          readerId: args.readerId,
          turnId: args.turnId,
          leaseId: args.leaseId,
          fenceGeneration: args.fenceGeneration,
          memoryPolicy: args.policy,
          expiresAt: args.expiresAt,
          grantId: `${args.leaseId}:${args.readerId}:${args.expiresAt}`,
        });
        if (result.status !== "issued" && result.status !== "replayed")
          throw new MemoryPolicyError("OWNER_MODEL_GRANT_UNAVAILABLE", 503);
        return result.grant;
      },
    );
  }

  /**
   * The memory policy's transport is this object's own `home_state`. A
   * refusal from the home domain is definitive (400); anything else leaves
   * the change pending for the alarm to retry.
   */
  protected memoryPolicy(): OwnerMemoryPolicy {
    return (this.memoryPolicyState ??= new OwnerMemoryPolicy(
      this.ctx,
      this.ownerId(),
      {
        read: async (ownerGeneration) => {
          try {
            return readMemoryPolicy(
              this.ownerStore().context(null).db,
              ownerGeneration,
            );
          } catch (error) {
            throw new MemoryPolicyError(
              error instanceof RpcError
                ? (error.reason ?? error.code)
                : "MEMORY_POLICY_UNAVAILABLE",
              503,
            );
          }
        },
        apply: async (change) => {
          try {
            await this.billingWrite((ctx) =>
              applyMemoryPolicyChange(ctx, change),
            );
          } catch (error) {
            if (error instanceof RpcError && !error.retryable) {
              throw new MemoryPolicyError(
                error.reason ?? error.code,
                400,
                error.message,
              );
            }
            throw new MemoryPolicyError("MEMORY_POLICY_UNAVAILABLE", 503);
          }
        },
      },
      {
        issuanceOpen: () => this.modelGrants().issuanceOpen(),
        revokeReaders: (change) =>
          this.revokeModelReaders({
            operationId: change.requestId,
            ownerGeneration: change.expectedOwnerGeneration,
            reason:
              change.kind === "wipe" ? "memory_wipe" : "memory_policy_change",
          }),
      },
    ));
  }

  /** `memory.setEnabled` / `memory.startWipe`: a policy change, refusals as `RpcError`. */
  protected async changeMemoryPolicyForCall(
    change: MemoryPolicyChange,
  ): Promise<void> {
    const result = await this.changeMemoryPolicy(change);
    if (result.ok) return;
    throw result.code === "BAD_REQUEST"
      ? new RpcError("BAD_REQUEST", result.message)
      : result.status === 400
        ? new RpcError("CONFLICT", result.message, {
            reason: result.code,
            retryable: false,
          })
        : result.status === 503
          ? new RpcError(
              "UNAVAILABLE",
              "Cloud memory settings are still being applied. Try again.",
              { reason: result.code },
            )
          : new RpcError(
              "CONFLICT",
              "Cloud memory settings are still being applied. Try again.",
              {
                reason: result.code,
                retryable: true,
                retryAfterMs: 2_000,
              },
            );
  }

  /** The owner this object gates. The namespace is addressed by name only. */
  protected ownerId(): string {
    const name = this.ctx.id.name ?? "";
    if (!name)
      throw new Error("Owner gate objects must be addressed by owner id.");
    return name;
  }

  /**
   * Start the owner-scoped gateway cache warm-up while this gate performs its
   * required durable admission. It is intentionally one-shot per DO instance:
   * preparation is advisory and a failure must never delay or refuse a turn.
   */
  protected prepareGatewayOwner(): void {
    if (this.gatewayOwnerPreparation) return;
    const control = this.env.MODEL_GATEWAY_CONTROL;
    if (!control) return;
    const ownerId = this.ownerId();
    const preparation = Promise.resolve()
      .then(() =>
        (control as ModelGatewayControl & Fetcher).prepareOwner({ ownerId }),
      )
      .catch((error) => {
        log("error", "owner_gateway_preparation_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    this.gatewayOwnerPreparation = preparation;
    this.ctx.waitUntil(preparation);
  }

  protected ensureSchema(): void {
    if (this.schemaReady) return;
    const startedAt = performance.now();
    for (const statement of DDL) this.ctx.storage.sql.exec(statement);
    // Existing owner objects predate durable desktop completion receipts.
    const dispatchColumns = this.ctx.storage.sql
      .exec<{ name: string }>("PRAGMA table_info(dispatches)")
      .toArray();
    if (!dispatchColumns.some((column) => column.name === "result_json")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE dispatches ADD COLUMN result_json TEXT",
      );
    }
    this.schemaReady = true;
    const schemaMs = Math.round(performance.now() - startedAt);
    log("info", "owner_gate_wake_timing", {
      schemaMs,
      totalMs: schemaMs,
    });
  }

  protected turnTimeoutMs(): number {
    const parsed = Number(this.env.TURN_TIMEOUT_MS ?? "");
    return Number.isSafeInteger(parsed) && parsed > 0
      ? parsed
      : DEFAULT_TURN_TIMEOUT_MS;
  }

  protected async registerFenceLease(
    lease: OwnerGateFenceLeaseRequest,
  ): Promise<OwnerGateFenceLeaseOutcome> {
    const ownerId = this.ownerId();
    const response = await this.ownerFenceCall(
      "register",
      { ...lease, ownerId },
      { [HEADER_OWNER_FENCE_ID]: ownerId },
    );
    const body = (await response.json().catch(() => null)) as {
      generation?: unknown;
      expiresAt?: unknown;
      code?: unknown;
      error?: unknown;
    } | null;
    if (
      response.ok &&
      typeof body?.generation === "string" &&
      typeof body.expiresAt === "number"
    ) {
      return {
        status: "registered",
        generation: body.generation,
        expiresAt: body.expiresAt,
      };
    }
    return {
      status: "refused",
      httpStatus: response.status,
      ...(typeof body?.code === "string" ? { code: body.code } : {}),
      ...(typeof body?.error === "string" ? { error: body.error } : {}),
    };
  }

  protected prune(now: number): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM running WHERE started_at < ?`,
      now - (this.turnTimeoutMs() + OWNER_GATE_RUNNING_GRACE_MS),
    );
  }

  /** `body` is `request`'s parsed JSON when the path can change authority. */
  protected async fetchOwnerFence(
    path: string,
    request: Request,
    body: unknown,
  ): Promise<Response> {
    if (path !== "begin")
      return createOwnerFenceHost({ ctx: this.ctx, env: this.env }).fetch(
        path,
        request,
      );
    // Owner admission and revocation share this section. Reader freeze RPCs
    // only touch local conversation state; they never call back into OwnerGate.
    const outcome = await this.ctx.blockConcurrencyWhile(async () => {
      try {
        const operationId = await sha256Hex(JSON.stringify({ path, body }));
        const response = await createOwnerFenceHost({
          ctx: this.ctx,
          env: this.env,
          beforeAuthorityChange: async (change) => {
            await this.modelGrants().beginFenceBarrier({
              operationId,
              path: change.path,
              body: change.body,
            });
            await this.revokeModelReaders({
              operationId,
              reason: "owner_purge",
            });
          },
        }).fetch(path, request);
        // A definite result closes this exact replay marker, including a
        // successful replay after the fence commit outlived the previous caller.
        if (response.ok || response.status < 500)
          await this.modelGrants().completeFenceBarrier(operationId);
        return { ok: true as const, response };
      } catch (error) {
        return { ok: false as const, error };
      }
    });
    if (!outcome.ok) throw outcome.error;
    return outcome.response;
  }

  // Implemented further up the chain.
  abstract ownerStore(): OwnerStore;
  abstract changeMemoryPolicy(
    change: MemoryPolicyChange,
  ): Promise<
    { ok: true } | { ok: false; code: string; status: number; message: string }
  >;
  abstract purgeOwnerData(input: {
    mode: OwnerPurgeMode;
  }): Promise<{ pending: string[] }>;
  protected abstract scheduleAlarm(
    now: number,
    options?: {
      fenceDeadline?: number | null;
      preserveExisting?: boolean;
    },
  ): Promise<void>;
}
