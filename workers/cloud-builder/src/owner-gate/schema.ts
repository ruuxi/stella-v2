/** The owner gate's own SQLite tables. */
export const DDL = [
  `CREATE TABLE IF NOT EXISTS running (
     turn_id         TEXT    PRIMARY KEY,
     lane            TEXT    NOT NULL,
     conversation_id TEXT    NOT NULL,
     started_at      INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS running_lane ON running(lane)`,
  // One row per agent container that is running a turn
  // (`acquireAgentContainer`). Keyed by the container, so an attach retry or
  // an OOM restart of the same agent never takes a second slot.
  `CREATE TABLE IF NOT EXISTS agent_containers (
     sandbox_id  TEXT    PRIMARY KEY,
     acquired_at INTEGER NOT NULL
   )`,
  // One row per device that has ever proven itself here. `connected` goes
  // false on close rather than deleting the row, so an offline device still
  // reports its last availability to `GET /owners/me/devices`.
  `CREATE TABLE IF NOT EXISTS device_presence (
     device_id           TEXT    PRIMARY KEY,
     presence_session_id TEXT    NOT NULL,
     connection_id       TEXT    NOT NULL,
     connected           INTEGER NOT NULL,
     ready               INTEGER NOT NULL,
     chat_slots          INTEGER NOT NULL,
     agent_slots         INTEGER NOT NULL,
     capabilities        TEXT    NOT NULL,
     protocol_version    INTEGER NOT NULL,
     last_seen_at        INTEGER NOT NULL,
     updated_at          INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS dispatches (
     dispatch_id                  TEXT    PRIMARY KEY,
     idempotency_key              TEXT    NOT NULL,
     owner_generation             TEXT    NOT NULL,
     kind                         TEXT    NOT NULL,
     ingress                      TEXT    NOT NULL,
     subject                      TEXT    NOT NULL,
     requested_target_mode        TEXT,
     requested_executor_device_id TEXT,
     conversation_id              TEXT    NOT NULL,
     parent_turn_id               TEXT,
     thread_id                    TEXT,
     requesting_device_id         TEXT,
     pair_grant_device_id         TEXT,
     required_capabilities        TEXT    NOT NULL,
     routing_fingerprint          TEXT    NOT NULL,
     state                        TEXT    NOT NULL,
     placement                    TEXT,
     executor_device_id           TEXT,
     executor_presence_session_id TEXT,
     on_no_eligible_computer      TEXT    NOT NULL,
     revision                     INTEGER NOT NULL,
     fallback_reason              TEXT,
     cancel_request_id            TEXT,
     cancel_reason                TEXT,
     error_code                   TEXT,
     error_message                TEXT,
     result_json                  TEXT,
     cloud_turn_id                TEXT,
     cloud_thread_id              TEXT,
     payload_json                 TEXT,
     payload_hash                 TEXT    NOT NULL,
     payload_expires_at           INTEGER,
     offer_deadline_at            INTEGER,
     lease_expires_at             INTEGER,
     started_at                   INTEGER,
     cloud_attempts               INTEGER NOT NULL DEFAULT 0,
     cloud_retry_at               INTEGER,
     gate_held                    INTEGER NOT NULL,
     created_at                   INTEGER NOT NULL,
     updated_at                   INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS cloud_dispatch_terminals (
     turn_id TEXT NOT NULL, owner_generation TEXT NOT NULL,
     outcome TEXT NOT NULL, result_json TEXT, error_message TEXT,
     created_at INTEGER NOT NULL, PRIMARY KEY (turn_id, owner_generation)
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS dispatches_idempotency
     ON dispatches(idempotency_key)`,
  `CREATE INDEX IF NOT EXISTS dispatches_state ON dispatches(state)`,
  // Deadline lookups run on every alarm and every authenticated call, so each
  // one is answered by a seek into a partial index keyed by state. Terminal
  // dispatches (blocked, canceled, completed, failed) carry no deadline that
  // can fire, and this object keeps them forever.
  `CREATE INDEX IF NOT EXISTS dispatches_offer_deadline
     ON dispatches(state, offer_deadline_at)
     WHERE offer_deadline_at IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS dispatches_lease_deadline
     ON dispatches(state, lease_expires_at)
     WHERE lease_expires_at IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS dispatches_cloud_retry
     ON dispatches(state, cloud_retry_at)
     WHERE cloud_retry_at IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS dispatches_payload_expiry
     ON dispatches(payload_expires_at)
     WHERE payload_json IS NOT NULL AND payload_expires_at IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS dispatch_offers (
     dispatch_id         TEXT    NOT NULL,
     device_id           TEXT    NOT NULL,
     presence_session_id TEXT    NOT NULL,
     status              TEXT    NOT NULL,
     expires_at          INTEGER NOT NULL,
     created_at          INTEGER NOT NULL,
     updated_at          INTEGER NOT NULL,
     PRIMARY KEY (dispatch_id, device_id)
   )`,
  `CREATE INDEX IF NOT EXISTS dispatch_offers_device
     ON dispatch_offers(device_id, status)`,
];
