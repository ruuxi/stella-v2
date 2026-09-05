import {
  memoryPoliciesMatch,
  parseMemoryPolicy,
  type MemoryPolicy,
} from "@stella/contracts/turn-plane/memory-policy";
import { GATEWAY_UPSTREAM_MAX_DURATION_MS } from "@stella/contracts/gateway/api";

const RETRY_MS = 5_000;
const MAX_TEXT_CHARS = 1_024;
const MAX_BARRIER_BODY_BYTES = 16_384;
const SCHEMA_VERSION = 1;

const DDL = [
  `CREATE TABLE IF NOT EXISTS owner_model_grant_schema_migrations (
     version    INTEGER PRIMARY KEY,
     applied_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS owner_model_grant_readers (
     conversation_id TEXT PRIMARY KEY,
     owner_id        TEXT NOT NULL,
     reader_id       TEXT NOT NULL,
     updated_at      INTEGER NOT NULL,
     expires_at      INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS owner_model_grants (
     grant_id          TEXT PRIMARY KEY,
     owner_id          TEXT NOT NULL,
     owner_generation  TEXT NOT NULL,
     conversation_id   TEXT NOT NULL,
     turn_id           TEXT NOT NULL,
     lease_id          TEXT NOT NULL,
     fence_generation  TEXT NOT NULL,
     memory_policy     TEXT NOT NULL,
     reader_id         TEXT NOT NULL,
     state             TEXT NOT NULL CHECK (state IN ('active', 'revoking', 'revoked', 'retired')),
     expires_at        INTEGER NOT NULL,
     issued_at         INTEGER NOT NULL,
     updated_at        INTEGER NOT NULL,
     retired_at        INTEGER,
     revoke_operation_id TEXT,
     revoke_reason       TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS owner_model_grants_by_state_expiry
     ON owner_model_grants(state, expires_at)`,
  `CREATE INDEX IF NOT EXISTS owner_model_grants_by_generation_state
     ON owner_model_grants(owner_generation, state)`,
  `CREATE INDEX IF NOT EXISTS owner_model_grants_by_turn_lease
     ON owner_model_grants(owner_generation, conversation_id, turn_id, lease_id)`,
  `CREATE TABLE IF NOT EXISTS owner_model_grant_fence_barrier (
     id           INTEGER PRIMARY KEY CHECK (id = 1),
     operation_id TEXT NOT NULL,
     path         TEXT NOT NULL,
     body_json    TEXT NOT NULL,
     created_at   INTEGER NOT NULL,
     updated_at   INTEGER NOT NULL
   )`,
] as const;

export type OwnerModelGrantReader = Readonly<{
  ownerId: string;
  conversationId: string;
  /** Orchestrator isolate nonce. A restarted reader must register a new value. */
  readerId: string;
  updatedAt: number;
  expiresAt?: number;
}>;

export type OwnerModelGrantIdentity = Readonly<{
  ownerId: string;
  ownerGeneration: string;
  conversationId: string;
  turnId: string;
  leaseId: string;
  fenceGeneration: string;
  memoryPolicy: MemoryPolicy;
  /** Must equal the latest reader nonce registered for this conversation. */
  readerId: string;
  grantId: string;
  /** Must be no later than the owner-fence lease expiry that protects the turn. */
  expiresAt: number;
}>;

export type OwnerModelGrant = OwnerModelGrantIdentity &
  Readonly<{
    state: "active";
    issuedAt: number;
    updatedAt: number;
  }>;

export type OwnerModelGrantState =
  | "active"
  | "revoking"
  | "revoked"
  | "retired";

export type OwnerModelGrantRecord = OwnerModelGrantIdentity &
  Readonly<{
    state: OwnerModelGrantState;
    issuedAt: number;
    updatedAt: number;
    retiredAt?: number;
    revokeOperationId?: string;
    revokeReason?: OwnerModelGrantRevokeReason;
  }>;

export type OwnerModelGrantIssueResult =
  | Readonly<{ status: "issued" | "replayed"; grant: OwnerModelGrant }>
  | Readonly<{
      status: "closed" | "stale_reader" | "conflict" | "expired" | "revoked";
      existing?: OwnerModelGrantRecord;
    }>;

export type OwnerModelGrantRevokeReason =
  | "memory_policy_change"
  | "memory_wipe"
  | "owner_purge"
  | "owner_transfer"
  | "manual";

export type OwnerModelGrantFreezeGrant = Readonly<{
  grantId: string;
  expiresAt: number;
}>;

export type OwnerModelGrantFreezeRequest = Readonly<{
  ownerId: string;
  ownerGeneration: string;
  conversationId: string;
  /** Latest Orchestrator isolate nonce known to OwnerGate for the conversation. */
  readerId: string;
  grants: readonly OwnerModelGrantFreezeGrant[];
}>;

export type OwnerModelGrantFreeze = (
  request: OwnerModelGrantFreezeRequest,
) => Promise<void>;

export type OwnerModelGrantFenceOperation = Readonly<{
  operationId: string;
  path: string;
  body: unknown;
  createdAt: number;
  updatedAt: number;
}>;

export type OwnerModelGrantRevokeAllInput = Readonly<{
  operationId: string;
  reason: OwnerModelGrantRevokeReason;
  ownerGeneration?: string;
  freeze: OwnerModelGrantFreeze;
}>;

export type OwnerModelGrantRevokeAllResult = Readonly<{
  revokedGrantIds: readonly string[];
}>;

export class OwnerModelGrantError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

type ReaderRow = {
  owner_id: string;
  conversation_id: string;
  reader_id: string;
  updated_at: number;
  expires_at: number | null;
};

type GrantRow = {
  grant_id: string;
  owner_id: string;
  owner_generation: string;
  conversation_id: string;
  turn_id: string;
  lease_id: string;
  fence_generation: string;
  memory_policy: string;
  reader_id: string;
  state: string;
  expires_at: number;
  issued_at: number;
  updated_at: number;
  retired_at: number | null;
  revoke_operation_id: string | null;
  revoke_reason: string | null;
};

type BarrierRow = {
  operation_id: string;
  path: string;
  body_json: string;
  created_at: number;
  updated_at: number;
};

const text = (value: unknown, max = MAX_TEXT_CHARS): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  value.trim() === value &&
  !/[\u0000-\u001f\u007f]/u.test(value);

const safeTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const FORBIDDEN_BARRIER_KEYS =
  /^(authorization|cookie|set-cookie|token|secret|credential|password)$/iu;

const safeBarrierBodyJson = (value: unknown): string => {
  const serialized = JSON.stringify(value);
  if (
    serialized === undefined ||
    new TextEncoder().encode(serialized).byteLength > MAX_BARRIER_BODY_BYTES
  ) {
    throw new OwnerModelGrantError("FENCE_BARRIER_INVALID");
  }
  const parsed = JSON.parse(serialized) as unknown;
  const stack: unknown[] = [parsed];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    for (const [key, child] of Object.entries(current)) {
      if (FORBIDDEN_BARRIER_KEYS.test(key)) {
        throw new OwnerModelGrantError("FENCE_BARRIER_CREDENTIAL_FIELD");
      }
      stack.push(child);
    }
  }
  return serialized;
};

const parseBarrierBody = (value: string): unknown =>
  JSON.parse(value) as unknown;

const state = (value: string): OwnerModelGrantState | null =>
  value === "active" ||
  value === "revoking" ||
  value === "revoked" ||
  value === "retired"
    ? value
    : null;

const revokeReason = (
  value: string | null,
): OwnerModelGrantRevokeReason | undefined =>
  value === "memory_policy_change" ||
  value === "memory_wipe" ||
  value === "owner_purge" ||
  value === "owner_transfer" ||
  value === "manual"
    ? value
    : undefined;

const readerFromRow = (row: ReaderRow): OwnerModelGrantReader => ({
  ownerId: row.owner_id,
  conversationId: row.conversation_id,
  readerId: row.reader_id,
  updatedAt: row.updated_at,
  ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {}),
});

const grantFromRow = (row: GrantRow): OwnerModelGrantRecord | null => {
  const memoryPolicy = parseMemoryPolicy(
    JSON.parse(row.memory_policy) as unknown,
  );
  const grantState = state(row.state);
  if (!memoryPolicy || !grantState) return null;
  return {
    ownerId: row.owner_id,
    ownerGeneration: row.owner_generation,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    leaseId: row.lease_id,
    fenceGeneration: row.fence_generation,
    memoryPolicy,
    readerId: row.reader_id,
    grantId: row.grant_id,
    expiresAt: row.expires_at,
    state: grantState,
    issuedAt: row.issued_at,
    updatedAt: row.updated_at,
    ...(row.retired_at !== null ? { retiredAt: row.retired_at } : {}),
    ...(row.revoke_operation_id
      ? { revokeOperationId: row.revoke_operation_id }
      : {}),
    ...(revokeReason(row.revoke_reason)
      ? { revokeReason: revokeReason(row.revoke_reason) }
      : {}),
  };
};

export const parseOwnerModelGrant = (
  value: unknown,
): OwnerModelGrant | null => {
  const input = asRecord(value);
  if (!input || input.state !== "active") return null;
  const policy = parseMemoryPolicy(input.memoryPolicy);
  if (
    !text(input.ownerId) ||
    !text(input.ownerGeneration) ||
    !text(input.conversationId) ||
    !text(input.turnId) ||
    !text(input.leaseId) ||
    !text(input.fenceGeneration) ||
    !text(input.readerId) ||
    !text(input.grantId) ||
    !safeTime(input.expiresAt) ||
    !safeTime(input.issuedAt) ||
    !safeTime(input.updatedAt) ||
    !policy
  ) {
    return null;
  }
  return {
    ownerId: input.ownerId,
    ownerGeneration: input.ownerGeneration,
    conversationId: input.conversationId,
    turnId: input.turnId,
    leaseId: input.leaseId,
    fenceGeneration: input.fenceGeneration,
    memoryPolicy: policy,
    readerId: input.readerId,
    grantId: input.grantId,
    expiresAt: input.expiresAt,
    state: "active",
    issuedAt: input.issuedAt,
    updatedAt: input.updatedAt,
  };
};

const grantIdentityMatches = (
  grant: OwnerModelGrantRecord,
  expected: OwnerModelGrantIdentity,
): boolean =>
  grant.ownerId === expected.ownerId &&
  grant.ownerGeneration === expected.ownerGeneration &&
  grant.conversationId === expected.conversationId &&
  grant.turnId === expected.turnId &&
  grant.leaseId === expected.leaseId &&
  grant.fenceGeneration === expected.fenceGeneration &&
  grant.readerId === expected.readerId &&
  grant.grantId === expected.grantId &&
  grant.expiresAt === expected.expiresAt &&
  memoryPoliciesMatch(grant.memoryPolicy, expected.memoryPolicy);

const activeGrant = (grant: OwnerModelGrantRecord): OwnerModelGrant | null =>
  grant.state === "active"
    ? {
        ownerId: grant.ownerId,
        ownerGeneration: grant.ownerGeneration,
        conversationId: grant.conversationId,
        turnId: grant.turnId,
        leaseId: grant.leaseId,
        fenceGeneration: grant.fenceGeneration,
        memoryPolicy: grant.memoryPolicy,
        readerId: grant.readerId,
        grantId: grant.grantId,
        expiresAt: grant.expiresAt,
        state: "active",
        issuedAt: grant.issuedAt,
        updatedAt: grant.updatedAt,
      }
    : null;

export class OwnerModelGrantStore {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly ownerId: string,
    private readonly now: () => number = Date.now,
  ) {
    if (!text(ownerId, 512)) throw new OwnerModelGrantError("OWNER_INVALID");
    this.initialize();
  }

  private initialize(): void {
    for (const statement of DDL) this.ctx.storage.sql.exec(statement);
    const current = this.ctx.storage.sql
      .exec<{
        version: number;
      }>(
        "SELECT COALESCE(MAX(version), 0) AS version FROM owner_model_grant_schema_migrations",
      )
      .one().version;
    if (current < SCHEMA_VERSION) {
      this.ctx.storage.sql.exec(
        "INSERT INTO owner_model_grant_schema_migrations (version, applied_at) VALUES (?, ?)",
        SCHEMA_VERSION,
        this.now(),
      );
    }
  }

  private async arm(): Promise<void> {
    const at = this.now() + RETRY_MS;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  private retireExpired(): void {
    const now = this.now();
    this.ctx.storage.sql.exec(
      "DELETE FROM owner_model_grants WHERE expires_at <= ? OR state = 'retired'",
      // Expiry closes new dispatch, but a request admitted just before it may
      // still be running. Keep its reader discoverable for privacy revocation
      // through the gateway's existing maximum request lifetime.
      now - GATEWAY_UPSTREAM_MAX_DURATION_MS,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM owner_model_grant_readers WHERE expires_at IS NOT NULL AND expires_at <= ?",
      now,
    );
  }

  async registerReader(input: {
    conversationId: string;
    readerId: string;
    expiresAt?: number;
  }): Promise<OwnerModelGrantReader> {
    if (!text(input.conversationId) || !text(input.readerId)) {
      throw new OwnerModelGrantError("READER_INVALID");
    }
    if (input.expiresAt !== undefined && !safeTime(input.expiresAt)) {
      throw new OwnerModelGrantError("READER_INVALID");
    }
    const now = this.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO owner_model_grant_readers
         (conversation_id, owner_id, reader_id, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET
         owner_id = excluded.owner_id,
         reader_id = excluded.reader_id,
         updated_at = excluded.updated_at,
         expires_at = excluded.expires_at`,
      input.conversationId,
      this.ownerId,
      input.readerId,
      now,
      input.expiresAt ?? null,
    );
    return {
      ownerId: this.ownerId,
      conversationId: input.conversationId,
      readerId: input.readerId,
      updatedAt: now,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    };
  }

  async latestReader(
    conversationId: string,
  ): Promise<OwnerModelGrantReader | undefined> {
    if (!text(conversationId)) return undefined;
    this.retireExpired();
    const row = this.ctx.storage.sql
      .exec<ReaderRow>(
        `SELECT owner_id, conversation_id, reader_id, updated_at, expires_at
           FROM owner_model_grant_readers
          WHERE conversation_id = ? AND owner_id = ?`,
        conversationId,
        this.ownerId,
      )
      .toArray()[0];
    return row ? readerFromRow(row) : undefined;
  }

  async pendingFenceBarrier(): Promise<
    OwnerModelGrantFenceOperation | undefined
  > {
    const row = this.ctx.storage.sql
      .exec<BarrierRow>(
        `SELECT operation_id, path, body_json, created_at, updated_at
           FROM owner_model_grant_fence_barrier
          WHERE id = 1`,
      )
      .toArray()[0];
    return row
      ? {
          operationId: row.operation_id,
          path: row.path,
          body: parseBarrierBody(row.body_json),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      : undefined;
  }

  async issuanceOpen(): Promise<boolean> {
    return (await this.pendingFenceBarrier()) === undefined;
  }

  async beginFenceBarrier(input: {
    operationId: string;
    path: string;
    body: unknown;
  }): Promise<OwnerModelGrantFenceOperation> {
    if (!text(input.operationId) || !text(input.path, 2_048)) {
      throw new OwnerModelGrantError("FENCE_BARRIER_INVALID");
    }
    const bodyJson = safeBarrierBodyJson(input.body);
    const existing = this.ctx.storage.sql
      .exec<BarrierRow>(
        `SELECT operation_id, path, body_json, created_at, updated_at
           FROM owner_model_grant_fence_barrier
          WHERE id = 1`,
      )
      .toArray()[0];
    if (existing) {
      if (
        existing.operation_id !== input.operationId ||
        existing.path !== input.path ||
        existing.body_json !== bodyJson
      ) {
        throw new OwnerModelGrantError("FENCE_BARRIER_BUSY");
      }
      await this.arm();
      return {
        operationId: existing.operation_id,
        path: existing.path,
        body: parseBarrierBody(existing.body_json),
        createdAt: existing.created_at,
        updatedAt: existing.updated_at,
      };
    }
    const now = this.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO owner_model_grant_fence_barrier
         (id, operation_id, path, body_json, created_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?)`,
      input.operationId,
      input.path,
      bodyJson,
      now,
      now,
    );
    await this.arm();
    return {
      operationId: input.operationId,
      path: input.path,
      body: parseBarrierBody(bodyJson),
      createdAt: now,
      updatedAt: now,
    };
  }

  async completeFenceBarrier(operationId: string): Promise<boolean> {
    const existing = await this.pendingFenceBarrier();
    if (!existing) return true;
    if (existing.operationId !== operationId) return false;
    this.ctx.storage.sql.exec(
      "DELETE FROM owner_model_grant_fence_barrier WHERE id = 1",
    );
    return true;
  }

  async issueGrant(
    identity: OwnerModelGrantIdentity,
  ): Promise<OwnerModelGrantIssueResult> {
    if (identity.ownerId !== this.ownerId || !this.validIdentity(identity)) {
      return { status: "conflict" };
    }
    this.retireExpired();
    if (identity.expiresAt <= this.now()) return { status: "expired" };
    if (!(await this.issuanceOpen())) return { status: "closed" };
    const latest = await this.latestReader(identity.conversationId);
    if (!latest || latest.readerId !== identity.readerId) {
      return { status: "stale_reader" };
    }
    const existing = this.record(identity.grantId);
    if (existing) {
      if (!grantIdentityMatches(existing, identity)) {
        return { status: "conflict", existing };
      }
      const grant = activeGrant(existing);
      return grant
        ? { status: "replayed", grant }
        : { status: "revoked", existing };
    }
    const now = this.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO owner_model_grants
         (grant_id, owner_id, owner_generation, conversation_id, turn_id,
          lease_id, fence_generation, memory_policy, reader_id, state,
          expires_at, issued_at, updated_at, retired_at, revoke_operation_id,
          revoke_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL, NULL, NULL)`,
      identity.grantId,
      identity.ownerId,
      identity.ownerGeneration,
      identity.conversationId,
      identity.turnId,
      identity.leaseId,
      identity.fenceGeneration,
      JSON.stringify(identity.memoryPolicy),
      identity.readerId,
      identity.expiresAt,
      now,
      now,
    );
    const grant = activeGrant(this.record(identity.grantId)!);
    if (!grant) throw new OwnerModelGrantError("GRANT_STATE_INVALID");
    return { status: "issued", grant };
  }

  async retireExactTurnLease(input: {
    ownerGeneration: string;
    turnId: string;
    leaseId: string;
    conversationId?: string;
  }): Promise<{ retiredGrantIds: readonly string[] }> {
    this.retireExpired();
    const rows = this.ctx.storage.sql
      .exec<{ grant_id: string }>(
        `SELECT grant_id FROM owner_model_grants
          WHERE owner_id = ? AND owner_generation = ?
            AND (? IS NULL OR conversation_id = ?)
            AND turn_id = ? AND lease_id = ? AND state != 'retired'
          ORDER BY grant_id`,
        this.ownerId,
        input.ownerGeneration,
        input.conversationId ?? null,
        input.conversationId ?? null,
        input.turnId,
        input.leaseId,
      )
      .toArray();
    this.ctx.storage.sql.exec(
      `DELETE FROM owner_model_grants
        WHERE owner_id = ? AND owner_generation = ?
          AND (? IS NULL OR conversation_id = ?)
          AND turn_id = ? AND lease_id = ?`,
      this.ownerId,
      input.ownerGeneration,
      input.conversationId ?? null,
      input.conversationId ?? null,
      input.turnId,
      input.leaseId,
    );
    return { retiredGrantIds: rows.map((row) => row.grant_id) };
  }

  async revokeAll(
    input: OwnerModelGrantRevokeAllInput,
  ): Promise<OwnerModelGrantRevokeAllResult> {
    if (!text(input.operationId))
      throw new OwnerModelGrantError("REVOKE_INVALID");
    this.retireExpired();
    const targets = this.ctx.storage.sql
      .exec<GrantRow>(
        `SELECT * FROM owner_model_grants
          WHERE owner_id = ?
            AND state IN ('active', 'revoking')
            AND (? IS NULL OR owner_generation = ?)
          ORDER BY owner_generation, reader_id, grant_id`,
        this.ownerId,
        input.ownerGeneration ?? null,
        input.ownerGeneration ?? null,
      )
      .toArray()
      .map(grantFromRow)
      .filter((grant): grant is OwnerModelGrantRecord => grant !== null);
    if (targets.length === 0) return { revokedGrantIds: [] };
    const now = this.now();
    this.ctx.storage.sql.exec(
      `UPDATE owner_model_grants
          SET state = 'revoking', revoke_operation_id = ?, revoke_reason = ?, updated_at = ?
        WHERE owner_id = ?
          AND state IN ('active', 'revoking')
          AND (? IS NULL OR owner_generation = ?)`,
      input.operationId,
      input.reason,
      now,
      this.ownerId,
      input.ownerGeneration ?? null,
      input.ownerGeneration ?? null,
    );

    const groups = new Map<string, OwnerModelGrantRecord[]>();
    for (const grant of targets) {
      const key = `${grant.ownerGeneration}\u0000${grant.conversationId}\u0000${grant.readerId}`;
      groups.set(key, [...(groups.get(key) ?? []), grant]);
    }
    const failures: string[] = [];
    const revoked: string[] = [];
    // All grants are durably closed before contacting readers. Freeze in
    // parallel so a slow reader does not multiply the owner's exclusive wait.
    await Promise.all(
      Array.from(groups.values(), async (group) => {
        const first = group[0];
        if (!first) return;
        const grants = group
          .map((grant) => ({
            grantId: grant.grantId,
            expiresAt: grant.expiresAt,
          }))
          .sort((left, right) => left.grantId.localeCompare(right.grantId));
        try {
          await input.freeze({
            ownerId: this.ownerId,
            ownerGeneration: first.ownerGeneration,
            conversationId: first.conversationId,
            readerId: first.readerId,
            grants,
          });
          revoked.push(...grants.map((grant) => grant.grantId));
        } catch {
          failures.push(...grants.map((grant) => grant.grantId));
        }
      }),
    );

    if (revoked.length > 0) {
      const revokedAt = this.now();
      for (const grantId of revoked) {
        this.ctx.storage.sql.exec(
          `UPDATE owner_model_grants
              SET state = 'revoked', revoke_operation_id = ?, revoke_reason = ?, updated_at = ?
            WHERE owner_id = ? AND grant_id = ? AND state IN ('active', 'revoking')`,
          input.operationId,
          input.reason,
          revokedAt,
          this.ownerId,
          grantId,
        );
      }
    }
    if (failures.length > 0) {
      await this.arm();
      throw new OwnerModelGrantError("REVOKE_INCOMPLETE");
    }
    return { revokedGrantIds: revoked };
  }

  private record(grantId: string): OwnerModelGrantRecord | null {
    const row = this.ctx.storage.sql
      .exec<GrantRow>(
        "SELECT * FROM owner_model_grants WHERE grant_id = ?",
        grantId,
      )
      .toArray()[0];
    return row ? grantFromRow(row) : null;
  }

  private validIdentity(identity: OwnerModelGrantIdentity): boolean {
    return (
      text(identity.ownerId) &&
      text(identity.ownerGeneration) &&
      text(identity.conversationId) &&
      text(identity.turnId) &&
      text(identity.leaseId) &&
      text(identity.fenceGeneration) &&
      text(identity.readerId) &&
      text(identity.grantId) &&
      safeTime(identity.expiresAt) &&
      identity.memoryPolicy.ownerGeneration === identity.ownerGeneration
    );
  }
}
