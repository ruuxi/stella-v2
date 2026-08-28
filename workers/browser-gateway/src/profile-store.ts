import { GatewayError } from "./errors.js";

export type ProfilePhase = "AGENT_CONTROL" | "HUMAN_CONTROL";
export type InteractionKind = "login_takeover" | "device_code";
export type InteractionState =
  | "pending"
  | "human_control"
  | "resuming"
  | "completed"
  | "canceled"
  | "expired"
  | "failed";

export type SnapshotPointer = Readonly<{
  key: string;
  revision: number;
  objectSha256: string;
}>;

export type ProfileState = Readonly<{
  ownerDigest: string;
  ownerGenerationDigest: string;
  profileDigest: string;
  profileEpoch: number;
  phase: ProfilePhase;
  allowedOrigins: readonly string[];
  browserSessionId?: string;
  browserPolicyDigest?: string;
  snapshot?: SnapshotPointer;
  activeInteractionId?: string;
  updatedAt: number;
}>;

export type InteractionRecord = Readonly<{
  interactionId: string;
  revision: number;
  kind: InteractionKind;
  state: InteractionState;
  conversationDigest: string;
  threadDigest: string;
  turnDigest: string;
  attemptGeneration: number;
  toolCallId: string;
  requestDigest: string;
  displayOrigin: string;
  displayTitle?: string;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
  verification?: Readonly<Record<string, unknown>>;
  publicDetails?: Readonly<Record<string, unknown>>;
  handoffId?: string;
  targetId?: string;
}>;

export type CommandReceipt = Readonly<{
  requestId: string;
  requestDigest: string;
  response: unknown;
  createdAt: number;
}>;

export interface ProfileStore {
  bootstrap(): void;
  getState(): ProfileState | null;
  putState(state: ProfileState): void;
  getInteraction(interactionId: string): InteractionRecord | null;
  putInteraction(interaction: InteractionRecord): void;
  getReceipt(requestId: string): CommandReceipt | null;
  putReceipt(receipt: CommandReceipt): void;
  deleteReceipts(): void;
  deleteInteractions(): void;
  destroy(): Promise<void>;
}

const DDL = [
  `CREATE TABLE IF NOT EXISTS profile_state (
    id INTEGER PRIMARY KEY CHECK (id = 0),
    owner_digest TEXT NOT NULL,
    owner_generation_digest TEXT NOT NULL,
    profile_digest TEXT NOT NULL,
    profile_epoch INTEGER NOT NULL,
    phase TEXT NOT NULL,
    allowed_origins_json TEXT NOT NULL,
    browser_session_id TEXT,
    browser_policy_digest TEXT,
    snapshot_key TEXT,
    snapshot_revision INTEGER,
    snapshot_object_sha256 TEXT,
    active_interaction_id TEXT,
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS interactions (
    interaction_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    conversation_digest TEXT NOT NULL,
    thread_digest TEXT NOT NULL,
    turn_digest TEXT NOT NULL,
    attempt_generation INTEGER NOT NULL,
    tool_call_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    display_origin TEXT NOT NULL,
    display_title TEXT,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    verification_json TEXT,
    public_details_json TEXT,
    handoff_id TEXT,
    target_id TEXT
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS command_receipts (
    request_id TEXT PRIMARY KEY,
    request_digest TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS interactions_by_state
   ON interactions (state, updated_at)`,
] as const;

type StateRow = {
  owner_digest: string;
  owner_generation_digest: string;
  profile_digest: string;
  profile_epoch: number;
  phase: string;
  allowed_origins_json: string;
  browser_session_id: string | null;
  browser_policy_digest: string | null;
  snapshot_key: string | null;
  snapshot_revision: number | null;
  snapshot_object_sha256: string | null;
  active_interaction_id: string | null;
  updated_at: number;
};

type InteractionRow = {
  interaction_id: string;
  revision: number;
  kind: string;
  state: string;
  conversation_digest: string;
  thread_digest: string;
  turn_digest: string;
  attempt_generation: number;
  tool_call_id: string;
  request_digest: string;
  display_origin: string;
  display_title: string | null;
  expires_at: number;
  created_at: number;
  updated_at: number;
  verification_json: string | null;
  public_details_json: string | null;
  handoff_id: string | null;
  target_id: string | null;
};

const parseJsonRecord = (
  value: string | null,
): Readonly<Record<string, unknown>> | undefined => {
  if (value === null) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>)
      : undefined;
  } catch {
    return undefined;
  }
};

export class SqliteProfileStore implements ProfileStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  bootstrap(): void {
    for (const statement of DDL) this.storage.sql.exec(statement);
  }

  getState(): ProfileState | null {
    const rows = this.storage.sql
      .exec<StateRow>("SELECT * FROM profile_state WHERE id = 0")
      .toArray();
    const row = rows[0];
    if (!row) return null;
    let allowedOrigins: unknown;
    try {
      allowedOrigins = JSON.parse(row.allowed_origins_json);
    } catch {
      throw new GatewayError("internal_error", 500);
    }
    if (!Array.isArray(allowedOrigins)) {
      throw new GatewayError("internal_error", 500);
    }
    const snapshot =
      row.snapshot_key && row.snapshot_revision && row.snapshot_object_sha256
        ? {
            key: row.snapshot_key,
            revision: row.snapshot_revision,
            objectSha256: row.snapshot_object_sha256,
          }
        : undefined;
    return {
      ownerDigest: row.owner_digest,
      ownerGenerationDigest: row.owner_generation_digest,
      profileDigest: row.profile_digest,
      profileEpoch: row.profile_epoch,
      phase: row.phase as ProfilePhase,
      allowedOrigins: allowedOrigins.filter(
        (origin): origin is string => typeof origin === "string",
      ),
      ...(row.browser_session_id
        ? { browserSessionId: row.browser_session_id }
        : {}),
      ...(row.browser_policy_digest
        ? { browserPolicyDigest: row.browser_policy_digest }
        : {}),
      ...(snapshot ? { snapshot } : {}),
      ...(row.active_interaction_id
        ? { activeInteractionId: row.active_interaction_id }
        : {}),
      updatedAt: row.updated_at,
    };
  }

  putState(state: ProfileState): void {
    this.storage.sql.exec(
      `INSERT INTO profile_state (
        id, owner_digest, owner_generation_digest, profile_digest,
        profile_epoch, phase, allowed_origins_json, browser_session_id,
        browser_policy_digest, snapshot_key, snapshot_revision,
        snapshot_object_sha256, active_interaction_id, updated_at
      ) VALUES (0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        owner_digest = excluded.owner_digest,
        owner_generation_digest = excluded.owner_generation_digest,
        profile_digest = excluded.profile_digest,
        profile_epoch = excluded.profile_epoch,
        phase = excluded.phase,
        allowed_origins_json = excluded.allowed_origins_json,
        browser_session_id = excluded.browser_session_id,
        browser_policy_digest = excluded.browser_policy_digest,
        snapshot_key = excluded.snapshot_key,
        snapshot_revision = excluded.snapshot_revision,
        snapshot_object_sha256 = excluded.snapshot_object_sha256,
        active_interaction_id = excluded.active_interaction_id,
        updated_at = excluded.updated_at`,
      state.ownerDigest,
      state.ownerGenerationDigest,
      state.profileDigest,
      state.profileEpoch,
      state.phase,
      JSON.stringify(state.allowedOrigins),
      state.browserSessionId ?? null,
      state.browserPolicyDigest ?? null,
      state.snapshot?.key ?? null,
      state.snapshot?.revision ?? null,
      state.snapshot?.objectSha256 ?? null,
      state.activeInteractionId ?? null,
      state.updatedAt,
    );
  }

  getInteraction(interactionId: string): InteractionRecord | null {
    const row = this.storage.sql
      .exec<InteractionRow>(
        "SELECT * FROM interactions WHERE interaction_id = ?",
        interactionId,
      )
      .toArray()[0];
    if (!row) return null;
    return {
      interactionId: row.interaction_id,
      revision: row.revision,
      kind: row.kind as InteractionKind,
      state: row.state as InteractionState,
      conversationDigest: row.conversation_digest,
      threadDigest: row.thread_digest,
      turnDigest: row.turn_digest,
      attemptGeneration: row.attempt_generation,
      toolCallId: row.tool_call_id,
      requestDigest: row.request_digest,
      displayOrigin: row.display_origin,
      ...(row.display_title ? { displayTitle: row.display_title } : {}),
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(parseJsonRecord(row.verification_json)
        ? { verification: parseJsonRecord(row.verification_json) }
        : {}),
      ...(parseJsonRecord(row.public_details_json)
        ? { publicDetails: parseJsonRecord(row.public_details_json) }
        : {}),
      ...(row.handoff_id ? { handoffId: row.handoff_id } : {}),
      ...(row.target_id ? { targetId: row.target_id } : {}),
    };
  }

  putInteraction(interaction: InteractionRecord): void {
    this.storage.sql.exec(
      `INSERT INTO interactions (
        interaction_id, revision, kind, state, conversation_digest,
        thread_digest, turn_digest, attempt_generation, tool_call_id,
        request_digest, display_origin, display_title, expires_at,
        created_at, updated_at, verification_json, public_details_json,
        handoff_id, target_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(interaction_id) DO UPDATE SET
        revision = excluded.revision,
        state = excluded.state,
        updated_at = excluded.updated_at,
        verification_json = excluded.verification_json,
        public_details_json = excluded.public_details_json,
        handoff_id = excluded.handoff_id,
        target_id = excluded.target_id`,
      interaction.interactionId,
      interaction.revision,
      interaction.kind,
      interaction.state,
      interaction.conversationDigest,
      interaction.threadDigest,
      interaction.turnDigest,
      interaction.attemptGeneration,
      interaction.toolCallId,
      interaction.requestDigest,
      interaction.displayOrigin,
      interaction.displayTitle ?? null,
      interaction.expiresAt,
      interaction.createdAt,
      interaction.updatedAt,
      interaction.verification
        ? JSON.stringify(interaction.verification)
        : null,
      interaction.publicDetails
        ? JSON.stringify(interaction.publicDetails)
        : null,
      interaction.handoffId ?? null,
      interaction.targetId ?? null,
    );
  }

  getReceipt(requestId: string): CommandReceipt | null {
    const row = this.storage.sql
      .exec<{
        request_id: string;
        request_digest: string;
        response_json: string;
        created_at: number;
      }>("SELECT * FROM command_receipts WHERE request_id = ?", requestId)
      .toArray()[0];
    if (!row) return null;
    try {
      return {
        requestId: row.request_id,
        requestDigest: row.request_digest,
        response: JSON.parse(row.response_json) as unknown,
        createdAt: row.created_at,
      };
    } catch {
      throw new GatewayError("internal_error", 500);
    }
  }

  putReceipt(receipt: CommandReceipt): void {
    this.storage.sql.exec(
      `INSERT INTO command_receipts
       (request_id, request_digest, response_json, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(request_id) DO NOTHING`,
      receipt.requestId,
      receipt.requestDigest,
      JSON.stringify(receipt.response),
      receipt.createdAt,
    );
  }

  deleteReceipts(): void {
    this.storage.sql.exec("DELETE FROM command_receipts");
  }

  deleteInteractions(): void {
    this.storage.sql.exec("DELETE FROM interactions");
  }

  async destroy(): Promise<void> {
    await this.storage.deleteAll();
  }
}

export class MemoryProfileStore implements ProfileStore {
  state: ProfileState | null = null;
  readonly interactions = new Map<string, InteractionRecord>();
  readonly receipts = new Map<string, CommandReceipt>();

  bootstrap(): void {}
  getState(): ProfileState | null {
    return this.state;
  }
  putState(state: ProfileState): void {
    this.state = structuredClone(state);
  }
  getInteraction(interactionId: string): InteractionRecord | null {
    return this.interactions.get(interactionId) ?? null;
  }
  putInteraction(interaction: InteractionRecord): void {
    this.interactions.set(
      interaction.interactionId,
      structuredClone(interaction),
    );
  }
  getReceipt(requestId: string): CommandReceipt | null {
    return this.receipts.get(requestId) ?? null;
  }
  putReceipt(receipt: CommandReceipt): void {
    if (!this.receipts.has(receipt.requestId)) {
      this.receipts.set(receipt.requestId, structuredClone(receipt));
    }
  }
  deleteReceipts(): void {
    this.receipts.clear();
  }
  deleteInteractions(): void {
    this.interactions.clear();
  }
  async destroy(): Promise<void> {
    this.state = null;
    this.interactions.clear();
    this.receipts.clear();
  }
}
