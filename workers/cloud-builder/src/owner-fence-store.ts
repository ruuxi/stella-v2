/**
 * SQLite authority for one owner-fence Durable Object's bounded leases.
 *
 * The store is deliberately synchronous: callers can compose these operations
 * with KV fence metadata inside one `DurableObjectStorage.transaction()`.
 * Remote I/O must happen before or after that transaction, never inside it.
 */

export const OWNER_FENCE_LEASE_SCHEMA_VERSION = 1;
export const OWNER_FENCE_DEFAULT_MAX_LEASE_MS = 30 * 60_000;
export const OWNER_FENCE_LEGACY_GRACE_MS = 60 * 60_000;
export const OWNER_FENCE_LEGACY_MIRROR_MAX_ENTRIES = 512;

export type OwnerFenceLeaseNamespace = "build" | "orchestrator" | "activity";

export type OwnerFenceLeaseRole =
  | "run"
  | "aux"
  | "orchestrator"
  | "activity"
  | "transfer";

export type OwnerFenceLeaseState = "active" | "retired";

export type OwnerFenceLeaseIdentity = Readonly<{
  leaseId: string;
  ownerId: string;
  ownerGeneration: string;
  reservationGeneration: string;
  sessionId: string;
  turnId: string;
  namespace: OwnerFenceLeaseNamespace;
  role: OwnerFenceLeaseRole;
}>;

export type OwnerFenceLease = OwnerFenceLeaseIdentity &
  Readonly<{
    state: OwnerFenceLeaseState;
    expiresAt: number;
    createdAt: number;
    renewedAt: number;
    retiredAt: number | null;
  }>;

export type OwnerFenceLeaseRegistration = OwnerFenceLeaseIdentity &
  Readonly<{ expiresAt: number }>;

export type OwnerFenceLeaseRegistrationResult =
  | Readonly<{
      status: "registered" | "replayed";
      lease: OwnerFenceLease;
    }>
  | Readonly<{
      status: "conflict";
      code: "lease_id_conflict" | "lease_retired";
      existing?: OwnerFenceLease;
    }>;

export type OwnerFenceLeaseMutationResult =
  | Readonly<{
      status: "renewed" | "retired";
      lease: OwnerFenceLease;
    }>
  | Readonly<{
      status: "missing" | "expired" | "already_retired" | "identity_mismatch";
      existing?: OwnerFenceLease;
    }>;

/** The shape retained temporarily so the immediately previous Worker can roll back. */
export type LegacyOwnerFenceLease = Readonly<{
  leaseId: string;
  sessionId: string;
  turnId: string;
  namespace: OwnerFenceLeaseNamespace;
  role: OwnerFenceLeaseRole;
  ownerGeneration?: string;
  reservationGeneration?: string;
  workspace?: string;
  expiresAt?: number;
}>;

export type LegacyOwnerFenceActiveMirror = Record<
  string,
  LegacyOwnerFenceLease
>;

type OwnerFenceLeaseRow = {
  lease_id: string;
  owner_id: string;
  owner_generation: string;
  reservation_generation: string;
  session_id: string;
  turn_id: string;
  namespace: string;
  role: string;
  state: string;
  expires_at: number;
  created_at: number;
  renewed_at: number;
  retired_at: number | null;
};

export type OwnerFenceStoreOptions = Readonly<{
  maxLeaseMs?: number;
  legacyGraceMs?: number;
  maxLegacyLeaseMs?: number;
}>;

export class OwnerFenceLeaseValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnerFenceLeaseValidationError";
  }
}

const DDL = [
  `CREATE TABLE IF NOT EXISTS owner_fence_schema_migrations (
     version    INTEGER PRIMARY KEY,
     applied_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS owner_fence_leases (
     lease_id                 TEXT    PRIMARY KEY,
     owner_id                 TEXT    NOT NULL,
     owner_generation         TEXT    NOT NULL,
     reservation_generation   TEXT    NOT NULL,
     session_id               TEXT    NOT NULL,
     turn_id                  TEXT    NOT NULL,
     namespace                TEXT    NOT NULL CHECK (namespace IN ('build', 'orchestrator', 'activity')),
     role                     TEXT    NOT NULL CHECK (role IN ('run', 'aux', 'orchestrator', 'activity', 'transfer')),
     state                    TEXT    NOT NULL CHECK (state IN ('active', 'retired')),
     expires_at               INTEGER NOT NULL,
     created_at               INTEGER NOT NULL,
     renewed_at               INTEGER NOT NULL,
     retired_at               INTEGER,
     CHECK ((state = 'active' AND retired_at IS NULL) OR state = 'retired')
   )`,
  `CREATE INDEX IF NOT EXISTS owner_fence_leases_by_expiry
     ON owner_fence_leases(state, expires_at)`,
] as const;

const NAMESPACES = new Set<OwnerFenceLeaseNamespace>([
  "build",
  "orchestrator",
  "activity",
]);
const ROLES = new Set<OwnerFenceLeaseRole>([
  "run",
  "aux",
  "orchestrator",
  "activity",
  "transfer",
]);

const assertSafeTime = (value: number, field: string): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new OwnerFenceLeaseValidationError(`${field} is invalid.`);
  }
};

const assertText = (value: string, field: string): void => {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new OwnerFenceLeaseValidationError(`${field} is invalid.`);
  }
};

const assertIdentity = (identity: OwnerFenceLeaseIdentity): void => {
  assertText(identity.leaseId, "leaseId");
  assertText(identity.ownerId, "ownerId");
  assertText(identity.ownerGeneration, "ownerGeneration");
  assertText(identity.reservationGeneration, "reservationGeneration");
  assertText(identity.sessionId, "sessionId");
  assertText(identity.turnId, "turnId");
  if (!NAMESPACES.has(identity.namespace)) {
    throw new OwnerFenceLeaseValidationError("namespace is invalid.");
  }
  if (!ROLES.has(identity.role)) {
    throw new OwnerFenceLeaseValidationError("role is invalid.");
  }
};

const exactIdentityMatches = (
  lease: OwnerFenceLease,
  identity: OwnerFenceLeaseIdentity,
): boolean =>
  lease.leaseId === identity.leaseId &&
  lease.ownerId === identity.ownerId &&
  lease.ownerGeneration === identity.ownerGeneration &&
  lease.reservationGeneration === identity.reservationGeneration &&
  lease.sessionId === identity.sessionId &&
  lease.turnId === identity.turnId &&
  lease.namespace === identity.namespace &&
  lease.role === identity.role;

const mapRow = (row: OwnerFenceLeaseRow): OwnerFenceLease => ({
  leaseId: row.lease_id,
  ownerId: row.owner_id,
  ownerGeneration: row.owner_generation,
  reservationGeneration: row.reservation_generation,
  sessionId: row.session_id,
  turnId: row.turn_id,
  namespace: row.namespace as OwnerFenceLeaseNamespace,
  role: row.role as OwnerFenceLeaseRole,
  state: row.state as OwnerFenceLeaseState,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
  renewedAt: row.renewed_at,
  retiredAt: row.retired_at,
});

const isConstraintError = (error: unknown): boolean =>
  error instanceof Error && /constraint|unique/iu.test(error.message);

export class OwnerFenceStore {
  readonly maxLeaseMs: number;
  readonly legacyGraceMs: number;
  readonly maxLegacyLeaseMs: number;

  constructor(
    private readonly sql: SqlStorage,
    options: OwnerFenceStoreOptions = {},
  ) {
    this.maxLeaseMs = options.maxLeaseMs ?? OWNER_FENCE_DEFAULT_MAX_LEASE_MS;
    this.legacyGraceMs = options.legacyGraceMs ?? OWNER_FENCE_LEGACY_GRACE_MS;
    this.maxLegacyLeaseMs =
      options.maxLegacyLeaseMs ?? OWNER_FENCE_LEGACY_GRACE_MS;
    for (const [field, value] of Object.entries({
      maxLeaseMs: this.maxLeaseMs,
      legacyGraceMs: this.legacyGraceMs,
      maxLegacyLeaseMs: this.maxLegacyLeaseMs,
    })) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new OwnerFenceLeaseValidationError(`${field} is invalid.`);
      }
    }
  }

  /** Call from constructor initialization before any lease operation. */
  initialize(now = Date.now()): void {
    assertSafeTime(now, "now");
    for (const statement of DDL) this.sql.exec(statement);
    const current = this.sql
      .exec<{
        version: number;
      }>(
        "SELECT COALESCE(MAX(version), 0) AS version FROM owner_fence_schema_migrations",
      )
      .one().version;
    if (current < OWNER_FENCE_LEASE_SCHEMA_VERSION) {
      this.sql.exec(
        "INSERT INTO owner_fence_schema_migrations (version, applied_at) VALUES (?, ?)",
        OWNER_FENCE_LEASE_SCHEMA_VERSION,
        now,
      );
    }
  }

  lease(leaseId: string): OwnerFenceLease | null {
    assertText(leaseId, "leaseId");
    const rows = this.sql
      .exec<OwnerFenceLeaseRow>(
        "SELECT * FROM owner_fence_leases WHERE lease_id = ?",
        leaseId,
      )
      .toArray();
    return rows[0] ? mapRow(rows[0]) : null;
  }

  activeLease(leaseId: string, now = Date.now()): OwnerFenceLease | null {
    this.expireDueLeases(now);
    const lease = this.lease(leaseId);
    return lease?.state === "active" ? lease : null;
  }

  activeLeases(now = Date.now()): OwnerFenceLease[] {
    this.expireDueLeases(now);
    return this.sql
      .exec<OwnerFenceLeaseRow>(
        `SELECT * FROM owner_fence_leases
           WHERE state = 'active'
           ORDER BY created_at, lease_id`,
      )
      .toArray()
      .map(mapRow);
  }

  activeLeaseCount(now = Date.now()): number {
    this.expireDueLeases(now);
    return this.sql
      .exec<{
        count: number;
      }>(
        "SELECT COUNT(*) AS count FROM owner_fence_leases WHERE state = 'active'",
      )
      .one().count;
  }

  registerLeaseExact(
    registration: OwnerFenceLeaseRegistration,
    now = Date.now(),
  ): OwnerFenceLeaseRegistrationResult {
    return this.registerLeaseExactBounded(registration, now, this.maxLeaseMs);
  }

  private registerLeaseExactBounded(
    registration: OwnerFenceLeaseRegistration,
    now: number,
    maxLeaseMs: number,
  ): OwnerFenceLeaseRegistrationResult {
    assertIdentity(registration);
    this.assertBoundedExpiry(registration.expiresAt, now, maxLeaseMs);
    this.expireDueLeases(now);
    const existing = this.lease(registration.leaseId);
    if (existing) {
      if (!exactIdentityMatches(existing, registration)) {
        return { status: "conflict", code: "lease_id_conflict", existing };
      }
      if (existing.state !== "active") {
        return { status: "conflict", code: "lease_retired", existing };
      }
      return { status: "replayed", lease: existing };
    }
    try {
      this.sql.exec(
        `INSERT INTO owner_fence_leases (
           lease_id, owner_id, owner_generation, reservation_generation,
           session_id, turn_id, namespace, role, state, expires_at,
           created_at, renewed_at, retired_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL)`,
        registration.leaseId,
        registration.ownerId,
        registration.ownerGeneration,
        registration.reservationGeneration,
        registration.sessionId,
        registration.turnId,
        registration.namespace,
        registration.role,
        registration.expiresAt,
        now,
        now,
      );
    } catch (error) {
      if (!isConstraintError(error)) throw error;
      const idConflict = this.lease(registration.leaseId);
      if (idConflict) {
        return {
          status: "conflict",
          code: "lease_id_conflict",
          existing: idConflict,
        };
      }
      return {
        status: "conflict",
        code: "lease_id_conflict",
      };
    }
    return { status: "registered", lease: this.lease(registration.leaseId)! };
  }

  renewLeaseExact(
    identity: OwnerFenceLeaseIdentity,
    expiresAt: number,
    now = Date.now(),
  ): OwnerFenceLeaseMutationResult {
    assertIdentity(identity);
    this.assertBoundedExpiry(expiresAt, now, this.maxLeaseMs);
    const existing = this.lease(identity.leaseId);
    if (!existing) return { status: "missing" };
    if (!exactIdentityMatches(existing, identity)) {
      return { status: "identity_mismatch", existing };
    }
    if (existing.state === "retired") {
      return { status: "already_retired", existing };
    }
    if (existing.expiresAt <= now) {
      this.retireExpired(existing, now);
      return { status: "expired", existing: this.lease(identity.leaseId)! };
    }
    this.sql.exec(
      `UPDATE owner_fence_leases
          SET expires_at = ?, renewed_at = ?
        WHERE lease_id = ? AND state = 'active'`,
      expiresAt,
      now,
      identity.leaseId,
    );
    return { status: "renewed", lease: this.lease(identity.leaseId)! };
  }

  retireLeaseExact(
    identity: OwnerFenceLeaseIdentity,
    now = Date.now(),
  ): OwnerFenceLeaseMutationResult {
    assertIdentity(identity);
    assertSafeTime(now, "now");
    const existing = this.lease(identity.leaseId);
    if (!existing) return { status: "missing" };
    if (!exactIdentityMatches(existing, identity)) {
      return { status: "identity_mismatch", existing };
    }
    if (existing.state === "retired") {
      return { status: "already_retired", existing };
    }
    this.sql.exec(
      `UPDATE owner_fence_leases
          SET state = 'retired', retired_at = ?
        WHERE lease_id = ? AND state = 'active'`,
      now,
      identity.leaseId,
    );
    return { status: "retired", lease: this.lease(identity.leaseId)! };
  }

  expireDueLeases(now = Date.now()): OwnerFenceLease[] {
    assertSafeTime(now, "now");
    const due = this.sql
      .exec<OwnerFenceLeaseRow>(
        `SELECT * FROM owner_fence_leases
           WHERE state = 'active' AND expires_at <= ?
           ORDER BY expires_at, lease_id`,
        now,
      )
      .toArray()
      .map(mapRow);
    if (due.length === 0) return [];
    this.sql.exec(
      `UPDATE owner_fence_leases
          SET state = 'retired', retired_at = ?
        WHERE state = 'active' AND expires_at <= ?`,
      now,
      now,
    );
    return due.map((lease) => ({
      ...lease,
      state: "retired",
      retiredAt: now,
    }));
  }

  nextExpiry(): number | null {
    const row = this.sql
      .exec<{ expires_at: number | null }>(
        `SELECT MIN(expires_at) AS expires_at
           FROM owner_fence_leases
          WHERE state = 'active'`,
      )
      .one();
    return row.expires_at;
  }

  /**
   * Convert the legacy KV map to SQL. Call this inside the same transaction
   * that writes `leaseStorageVersion: 2` and the compatibility mirror.
   */
  migrateLegacyActiveMirror(args: {
    ownerId: string;
    fenceGeneration: string;
    active: LegacyOwnerFenceActiveMirror;
    now?: number;
  }): Readonly<{
    inserted: number;
    replayed: number;
    expired: number;
    invalid: readonly string[];
    conflicts: readonly string[];
  }> {
    assertText(args.ownerId, "ownerId");
    assertText(args.fenceGeneration, "fenceGeneration");
    const now = args.now ?? Date.now();
    assertSafeTime(now, "now");
    let inserted = 0;
    let replayed = 0;
    let expired = 0;
    const invalid: string[] = [];
    const conflicts: string[] = [];
    for (const [mapLeaseId, legacy] of Object.entries(args.active).sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      if (
        mapLeaseId !== legacy.leaseId ||
        !legacy.ownerGeneration ||
        !NAMESPACES.has(legacy.namespace) ||
        !ROLES.has(legacy.role)
      ) {
        invalid.push(mapLeaseId);
        continue;
      }
      if (
        legacy.expiresAt !== undefined &&
        (!Number.isSafeInteger(legacy.expiresAt) || legacy.expiresAt <= now)
      ) {
        expired += 1;
        continue;
      }
      const expiresAt = Math.min(
        legacy.expiresAt ?? now + this.legacyGraceMs,
        now + this.maxLegacyLeaseMs,
      );
      let result: OwnerFenceLeaseRegistrationResult;
      try {
        result = this.registerLeaseExactBounded(
          {
            leaseId: legacy.leaseId,
            ownerId: args.ownerId,
            ownerGeneration: legacy.ownerGeneration,
            reservationGeneration:
              legacy.reservationGeneration ?? args.fenceGeneration,
            sessionId: legacy.sessionId,
            turnId: legacy.turnId,
            namespace: legacy.namespace,
            role: legacy.role,
            expiresAt,
          },
          now,
          this.maxLegacyLeaseMs,
        );
      } catch (error) {
        if (!(error instanceof OwnerFenceLeaseValidationError)) throw error;
        invalid.push(mapLeaseId);
        continue;
      }
      if (result.status === "registered") inserted += 1;
      else if (result.status === "replayed") replayed += 1;
      else conflicts.push(mapLeaseId);
    }
    return { inserted, replayed, expired, invalid, conflicts };
  }

  /**
   * Build the rollback mirror. A caller must not persist anything when the
   * result is `too_many_active_leases`; active identities are never truncated.
   */
  boundedLegacyActiveMirror(
    now = Date.now(),
    maxEntries = OWNER_FENCE_LEGACY_MIRROR_MAX_ENTRIES,
  ):
    | Readonly<{ status: "complete"; active: LegacyOwnerFenceActiveMirror }>
    | Readonly<{
        status: "too_many_active_leases";
        activeLeaseCount: number;
        maxEntries: number;
      }> {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new OwnerFenceLeaseValidationError("maxEntries is invalid.");
    }
    const leases = this.activeLeases(now);
    if (leases.length > maxEntries) {
      return {
        status: "too_many_active_leases",
        activeLeaseCount: leases.length,
        maxEntries,
      };
    }
    return {
      status: "complete",
      active: Object.fromEntries(
        leases.map((lease) => [
          lease.leaseId,
          ownerFenceLeaseToLegacyLease(lease),
        ]),
      ),
    };
  }

  private assertBoundedExpiry(
    expiresAt: number,
    now: number,
    maxLeaseMs: number,
  ): void {
    assertSafeTime(now, "now");
    assertSafeTime(expiresAt, "expiresAt");
    if (expiresAt <= now || expiresAt > now + maxLeaseMs) {
      throw new OwnerFenceLeaseValidationError("expiresAt is out of bounds.");
    }
  }

  private retireExpired(lease: OwnerFenceLease, now: number): void {
    this.sql.exec(
      `UPDATE owner_fence_leases
          SET state = 'retired', retired_at = ?
        WHERE lease_id = ? AND state = 'active' AND expires_at <= ?`,
      now,
      lease.leaseId,
      now,
    );
  }
}

export const ownerFenceLeaseToLegacyLease = (
  lease: OwnerFenceLease,
): LegacyOwnerFenceLease => ({
  leaseId: lease.leaseId,
  sessionId: lease.sessionId,
  turnId: lease.turnId,
  namespace: lease.namespace,
  role: lease.role,
  ownerGeneration: lease.ownerGeneration,
  reservationGeneration: lease.reservationGeneration,
  expiresAt: lease.expiresAt,
});
