/**
 * The owner's devices: desktops that can run work (their presence-signing
 * keys and capabilities), phones paired to a desktop, and the phones' push
 * tokens. Desktop UI and runtime calls arrive as backend calls; phones use the
 * `/api/mobile/*` routes, which land in `handleMobileRoute`.
 */

import type {
  ActivityNotificationKind,
  DeviceCalls,
  ExecutionCapability,
  PhoneAccessState,
} from "@stella/contracts/backend/devices";
import { sha256Hex } from "@stella/contracts/turn-plane/pairing-proof";
import type { OwnerSnapshot } from "@stella/contracts/turn-plane/owner-snapshot";
import type { DeviceRemoteExecution } from "@stella/contracts/turn-plane/placement";
import { array, boolean, literal, object, optional, string } from "../args.js";
import { RpcError } from "../errors.js";
import { enforceOwnerRateLimit } from "../rate-limit.js";
import type { OwnerCaller, OwnerContext, OwnerDbReader, OwnerDomain } from "../registry.js";

const MAX_DEVICES = 64;
const MAX_SUCCESSION_HOPS = 8;
const MAX_TOKENS = 25;
const PAIRING_TTL_MS = 10 * 60_000;
const SWEEP_INTERVAL_MS = 24 * 60 * 60_000;
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_CODE_LENGTH = 8;
const PAIR_SECRET_LENGTH = 48;
const PAIR_SECRET_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";
const PUSH_QUIET_MS = 60_000;
export const DEVICES_SWEEP_JOB = "devices.sweep";
export const DEVICES_PUSH_DIGEST_JOB = "devices.pushDigest";

export const DEVICES_MIGRATION = {
  id: "devices.1-registry",
  statements: [
    `CREATE TABLE devices (
       device_id TEXT PRIMARY KEY,
       public_key TEXT,
       name TEXT,
       platform TEXT,
       remote_execution_enabled INTEGER NOT NULL,
       capabilities TEXT NOT NULL,
       registered_at INTEGER,
       updated_at INTEGER NOT NULL
     )`,
    `CREATE TABLE device_successors (
       previous_device_id TEXT PRIMARY KEY,
       device_id TEXT NOT NULL,
       rotated_at INTEGER NOT NULL
     )`,
    `CREATE TABLE paired_phones (
       desktop_device_id TEXT NOT NULL,
       mobile_device_id TEXT NOT NULL,
       pair_secret_hash TEXT NOT NULL,
       display_name TEXT,
       platform TEXT,
       approved_at INTEGER NOT NULL,
       last_seen_at INTEGER NOT NULL,
       revoked_at INTEGER,
       PRIMARY KEY (desktop_device_id, mobile_device_id)
     )`,
    `CREATE TABLE pairing_codes (
       code TEXT PRIMARY KEY,
       desktop_device_id TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       expires_at INTEGER NOT NULL,
       used_at INTEGER
     )`,
    `CREATE TABLE connect_intents (
       intent_id TEXT PRIMARY KEY,
       desktop_device_id TEXT NOT NULL,
       mobile_device_id TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       expires_at INTEGER NOT NULL,
       acknowledged_at INTEGER,
       UNIQUE (desktop_device_id, mobile_device_id)
     )`,
    `CREATE TABLE bridge_registrations (
       device_id TEXT PRIMARY KEY,
       base_urls TEXT NOT NULL,
       platform TEXT,
       desktop_public_key TEXT,
       updated_at INTEGER NOT NULL
     )`,
    `CREATE TABLE bridge_sessions (
       session_id TEXT PRIMARY KEY,
       desktop_device_id TEXT NOT NULL,
       mobile_device_id TEXT NOT NULL,
       secret_hash TEXT NOT NULL,
       desktop_challenge TEXT NOT NULL,
       desktop_public_key TEXT NOT NULL,
       mobile_public_key TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       expires_at INTEGER NOT NULL,
       last_seen_at INTEGER NOT NULL
     )`,
    `CREATE TABLE push_tokens (
       token TEXT PRIMARY KEY,
       mobile_device_id TEXT NOT NULL,
       platform TEXT,
       updated_at INTEGER NOT NULL
     )`,
    `CREATE TABLE tunnels (
       device_id TEXT PRIMARY KEY,
       tunnel_name TEXT NOT NULL,
       hostname TEXT NOT NULL,
       state TEXT NOT NULL,
       lease_expires_at INTEGER,
       tunnel_id TEXT,
       tunnel_token TEXT,
       dns_record_id TEXT,
       created_at INTEGER NOT NULL,
       last_used_at INTEGER NOT NULL
     )`,
  ],
};

/**
 * Split "listed" from "willing to run dispatched work".
 *
 * `remote_execution_enabled` has been written as 1 by every registration since
 * the table existed, so it is not a setting anyone ever chose — it is just the
 * absence of the question. The backfill therefore reads it as the migration
 * input it is: every device already in the table, including every desktop a
 * phone had paired with, arrives `enabled` and is never asked. Only devices
 * that register *after* this migration start out `unconfigured`.
 */
export const DEVICES_REMOTE_EXECUTION_MIGRATION = {
  id: "devices.2-remote-execution-consent",
  statements: [
    `ALTER TABLE devices ADD COLUMN remote_execution_state TEXT NOT NULL DEFAULT 'unconfigured'`,
    `ALTER TABLE devices ADD COLUMN remote_execution_asked_at INTEGER`,
    `UPDATE devices SET remote_execution_state = 'enabled' WHERE remote_execution_enabled = 1`,
  ],
};

/**
 * The phone bridge is gone: phones reach a computer through the owner gate's
 * relay over its presence socket, so the bridge's registrations, sessions,
 * connect requests and Cloudflare tunnels have nothing left to describe.
 */
export const DEVICES_DROP_PHONE_BRIDGE_MIGRATION = {
  id: "devices.3-drop-phone-bridge",
  statements: [
    `DROP TABLE IF EXISTS connect_intents`,
    `DROP TABLE IF EXISTS bridge_registrations`,
    `DROP TABLE IF EXISTS bridge_sessions`,
    `DROP TABLE IF EXISTS tunnels`,
  ],
};

export const DEVICES_PUSH_DIGEST_MIGRATION = {
  id: "devices.4-push-digest",
  statements: [
    `CREATE TABLE push_digest (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       last_sent_at INTEGER NOT NULL,
       last_finish_at INTEGER NOT NULL,
       completed INTEGER NOT NULL,
       failed INTEGER NOT NULL
     )`,
  ],
};

type DeviceRow = {
  device_id: string;
  public_key: string | null;
  name: string | null;
  platform: string | null;
  remote_execution_enabled: number;
  remote_execution_state: string;
  remote_execution_asked_at: number | null;
  capabilities: string;
  registered_at: number | null;
  updated_at: number;
};

type PairedPhoneRow = {
  desktop_device_id: string;
  mobile_device_id: string;
  pair_secret_hash: string;
  display_name: string | null;
  platform: string | null;
  approved_at: number;
  last_seen_at: number;
  revoked_at: number | null;
};

const CAPABILITIES: ExecutionCapability[] = [
  "chat",
  "agent",
  "computer-use",
  "local-files",
  "local-apps",
  "attachments",
];

// ── Small helpers ──────────────────────────────────────────────────────────

const randomFrom = (alphabet: string, length: number): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
};

const text = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

const optionalText = (value: unknown, max: number): string | undefined => text(value, max) || undefined;

/** Follow the succession chain to the id a retired desktop id now resolves to. */
export const resolveCurrentDeviceId = (db: OwnerDbReader, deviceId: string): string => {
  let current = deviceId;
  const seen = new Set([current]);
  for (let hop = 0; hop < MAX_SUCCESSION_HOPS; hop++) {
    const next = db.one<{ device_id: string }>(
      "SELECT device_id FROM device_successors WHERE previous_device_id = ?",
      current,
    )?.device_id;
    if (!next || seen.has(next)) return current;
    seen.add(next);
    current = next;
  }
  return current;
};

const scheduleSweep = (ctx: OwnerContext): void => {
  ctx.jobs.schedule(DEVICES_SWEEP_JOB, ctx.now + SWEEP_INTERVAL_MS, null, { id: DEVICES_SWEEP_JOB });
};

const requireCaller = (caller: OwnerCaller | null): OwnerCaller => {
  if (!caller) {
    throw new RpcError("FORBIDDEN", "Sign in with an account to use this.");
  }
  return caller;
};

// ── Desktops ───────────────────────────────────────────────────────────────

const identity = async (
  ctx: OwnerContext,
  args: DeviceCalls["devices.identity"]["args"],
): Promise<DeviceCalls["devices.identity"]["result"]> => {
  const snapshot = await ctx.host.snapshot();
  const requested = args.deviceId?.trim();
  const builderOrigin = ctx.env.CLOUD_BUILDER_PUBLIC_URL?.trim().replace(/\/+$/, "");
  return {
    ownerId: ctx.ownerId,
    ownerGeneration: snapshot.ownerGeneration,
    ...(requested ? { deviceId: resolveCurrentDeviceId(ctx.db, requested) } : {}),
    ...(builderOrigin ? { builderOrigin } : {}),
  };
};

/**
 * Registering is being listed, nothing more. A device the account has never
 * seen starts `unconfigured`; one that already answered keeps its answer, so
 * launching Stella again neither re-asks nor quietly re-enables a machine the
 * owner declined.
 */
const register = async (
  ctx: OwnerContext,
  args: DeviceCalls["devices.register"]["args"],
): Promise<DeviceCalls["devices.register"]["result"]> => {
  const snapshot = await ctx.host.snapshot();
  const capabilities = JSON.stringify([...new Set(args.capabilities ?? [])].sort());
  const existing = ctx.db.one<DeviceRow>("SELECT * FROM devices WHERE device_id = ?", args.deviceId);
  if (!existing) {
    const count = ctx.db.one<{ count: number }>("SELECT COUNT(*) AS count FROM devices")?.count ?? 0;
    if (count >= MAX_DEVICES) {
      throw new RpcError("RATE_LIMITED", "This account has registered too many devices.");
    }
    ctx.db.run(
      `INSERT INTO devices (device_id, public_key, name, platform, remote_execution_enabled,
         remote_execution_state, capabilities, registered_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 'unconfigured', ?, ?, ?)`,
      args.deviceId,
      args.devicePublicKey,
      args.deviceName ?? null,
      args.platform ?? null,
      capabilities,
      ctx.now,
      ctx.now,
    );
    return {
      deviceId: args.deviceId,
      ownerGeneration: snapshot.ownerGeneration,
      remoteExecutionEnabled: false,
      remoteExecution: "unconfigured",
      rotated: false,
    };
  }
  ctx.db.run(
    `UPDATE devices SET public_key = ?, name = COALESCE(?, name), platform = COALESCE(?, platform),
       capabilities = ?, registered_at = ?, updated_at = ? WHERE device_id = ?`,
    args.devicePublicKey,
    args.deviceName ?? null,
    args.platform ?? null,
    capabilities,
    ctx.now,
    ctx.now,
    args.deviceId,
  );
  return {
    deviceId: args.deviceId,
    ownerGeneration: snapshot.ownerGeneration,
    remoteExecutionEnabled: existing.remote_execution_enabled === 1,
    remoteExecution: remoteExecutionOf(existing),
    rotated: Boolean(existing.public_key && existing.public_key !== args.devicePublicKey),
  };
};

/**
 * The stored consent, tolerating a row written before the consent migration
 * (or by an older build) by falling back to the boolean it was derived from.
 */
const remoteExecutionOf = (
  row: Pick<DeviceRow, "remote_execution_enabled" | "remote_execution_state">,
): DeviceRemoteExecution => {
  const state = row.remote_execution_state?.trim();
  if (
    state === "unconfigured" ||
    state === "asking" ||
    state === "enabled" ||
    state === "declined"
  ) {
    return state;
  }
  return row.remote_execution_enabled === 1 ? "enabled" : "unconfigured";
};

const writeRemoteExecution = (
  ctx: OwnerContext,
  deviceId: string,
  state: DeviceRemoteExecution,
  askedAt: number | null,
): void => {
  ctx.db.run(
    `UPDATE devices SET remote_execution_state = ?, remote_execution_enabled = ?,
       remote_execution_asked_at = ?, updated_at = ? WHERE device_id = ?`,
    state,
    state === "enabled" ? 1 : 0,
    askedAt,
    ctx.now,
    deviceId,
  );
};

const requireDevice = (ctx: OwnerContext, deviceId: string): DeviceRow => {
  const row = ctx.db.one<DeviceRow>(
    "SELECT * FROM devices WHERE device_id = ?",
    resolveCurrentDeviceId(ctx.db, deviceId),
  );
  if (!row) throw new RpcError("NOT_FOUND", "That device is not signed in to this account.");
  return row;
};

/**
 * Enable or disable a device's willingness to run dispatched work.
 *
 * Authorized by the account, which is the whole point of the enable control:
 * the owner should not have to walk to the other machine. Cross-account reach
 * is impossible here for a structural reason rather than a check — the row
 * lives in the caller's own owner object, so there is no device of anyone
 * else's to name.
 */
const setRemoteExecution = (
  ctx: OwnerContext,
  args: DeviceCalls["devices.setRemoteExecution"]["args"],
): DeviceCalls["devices.setRemoteExecution"]["result"] => {
  enforceOwnerRateLimit(ctx.db, ctx.now, "devices.setRemoteExecution", { count: 60, windowMs: 60_000 }, "Too many device permission changes. Please wait a minute and try again.");
  const row = requireDevice(ctx, args.deviceId);
  const before = remoteExecutionOf(row);
  const after: DeviceRemoteExecution = args.enabled ? "enabled" : "declined";
  if (before === after) {
    return { deviceId: row.device_id, remoteExecution: before, changed: false };
  }
  writeRemoteExecution(ctx, row.device_id, after, null);
  return { deviceId: row.device_id, remoteExecution: after, changed: true };
};

/**
 * Something tried to dispatch here and this device has not agreed. Recorded so
 * the device raises its own prompt and the list can say an answer is pending.
 * A device that already said yes is left alone; a device that said no is asked
 * again, because a later attempt is new information, not a replay.
 */
const requestRemoteExecution = (
  ctx: OwnerContext,
  args: DeviceCalls["devices.requestRemoteExecution"]["args"],
): DeviceCalls["devices.requestRemoteExecution"]["result"] => {
  const row = requireDevice(ctx, args.deviceId);
  const before = remoteExecutionOf(row);
  if (before === "enabled") {
    return { deviceId: row.device_id, remoteExecution: before };
  }
  writeRemoteExecution(ctx, row.device_id, "asking", ctx.now);
  return { deviceId: row.device_id, remoteExecution: "asking" };
};

/**
 * Move a retired desktop id's pairings and consent onto its
 * successor. A desktop mints a new device id when its local keypair stops
 * being readable; that is the same physical machine, so making the owner
 * consent again because a key file moved would be a bug, not a safeguard.
 */
const adoptSuccession = (
  ctx: OwnerContext,
  args: DeviceCalls["devices.adoptSuccession"]["args"],
): DeviceCalls["devices.adoptSuccession"]["result"] => {
  if (args.previousDeviceId === args.deviceId) {
    throw new RpcError("BAD_REQUEST", "previousDeviceId and deviceId must differ.");
  }
  enforceOwnerRateLimit(ctx.db, ctx.now, "devices.succession", { count: 10, windowMs: 60_000 }, "Too many device identity rotations. Please wait and try again.");
  const existing = ctx.db.one<{ device_id: string }>(
    "SELECT device_id FROM device_successors WHERE previous_device_id = ?",
    args.previousDeviceId,
  );
  if (existing) {
    if (existing.device_id === args.deviceId) {
      return {
        ok: true,
        migratedPairings: 0,
        migratedRemoteExecution: false,
      };
    }
    throw new RpcError("CONFLICT", "This device id has already been succeeded.");
  }
  const phones = ctx.db.all<{ mobile_device_id: string }>(
    "SELECT mobile_device_id FROM paired_phones WHERE desktop_device_id = ?",
    args.previousDeviceId,
  );
  let migratedPairings = 0;
  for (const phone of phones) {
    const already = ctx.db.one(
      "SELECT 1 AS present FROM paired_phones WHERE desktop_device_id = ? AND mobile_device_id = ?",
      args.deviceId,
      phone.mobile_device_id,
    );
    if (already) {
      ctx.db.run(
        "DELETE FROM paired_phones WHERE desktop_device_id = ? AND mobile_device_id = ?",
        args.previousDeviceId,
        phone.mobile_device_id,
      );
      continue;
    }
    ctx.db.run(
      "UPDATE paired_phones SET desktop_device_id = ? WHERE desktop_device_id = ? AND mobile_device_id = ?",
      args.deviceId,
      args.previousDeviceId,
      phone.mobile_device_id,
    );
    migratedPairings += 1;
  }
  const retired = ctx.db.one<DeviceRow>(
    "SELECT * FROM devices WHERE device_id = ?",
    args.previousDeviceId,
  );
  const successor = ctx.db.one<DeviceRow>(
    "SELECT * FROM devices WHERE device_id = ?",
    args.deviceId,
  );
  // Only an answer is inherited. A successor that already carries one of its
  // own keeps it, and `unconfigured` is the absence of an answer, so it has
  // nothing to pass on.
  const inherited = retired ? remoteExecutionOf(retired) : "unconfigured";
  const migratedRemoteExecution = Boolean(
    successor &&
      inherited !== "unconfigured" &&
      remoteExecutionOf(successor) === "unconfigured",
  );
  if (migratedRemoteExecution) {
    writeRemoteExecution(ctx, args.deviceId, inherited, retired?.remote_execution_asked_at ?? null);
  }
  ctx.db.run(
    "INSERT INTO device_successors (previous_device_id, device_id, rotated_at) VALUES (?, ?, ?)",
    args.previousDeviceId,
    args.deviceId,
    ctx.now,
  );
  return {
    ok: true,
    migratedPairings,
    migratedRemoteExecution,
  };
};

/** The devices and pairings the gate admits placements and proofs against. */
export const snapshotDevices = (
  db: OwnerDbReader,
): Pick<OwnerSnapshot, "devices" | "pairedDevices"> => ({
  devices: db
    .all<DeviceRow>("SELECT * FROM devices WHERE public_key IS NOT NULL ORDER BY device_id")
    .map((row) => {
      const capabilities = (JSON.parse(row.capabilities) as string[]).filter(
        (entry): entry is ExecutionCapability => CAPABILITIES.includes(entry as ExecutionCapability),
      );
      const remoteExecution = remoteExecutionOf(row);
      return {
        deviceId: row.device_id,
        publicKey: row.public_key!,
        remoteExecutionEnabled: remoteExecution === "enabled",
        remoteExecution,
        ...(row.remote_execution_asked_at
          ? { remoteExecutionAskedAt: row.remote_execution_asked_at }
          : {}),
        ...(row.name?.trim() ? { label: row.name.trim() } : {}),
        ...(capabilities.length > 0 ? { capabilities } : {}),
      };
    }),
  pairedDevices: db
    .all<PairedPhoneRow>("SELECT * FROM paired_phones WHERE revoked_at IS NULL")
    .map((row) => ({
      mobileDeviceId: row.mobile_device_id,
      desktopDeviceId: row.desktop_device_id,
      // The pairing proof is an HMAC keyed by this value.
      mobilePublicKey: row.pair_secret_hash,
    })),
});

// ── Phones ─────────────────────────────────────────────────────────────────

const pairingUrl = (code: string) => `stella-mobile://stella?code=${encodeURIComponent(code)}`;

const activePairing = (db: OwnerDbReader, desktopDeviceId: string, now: number) =>
  db.one<{ code: string; created_at: number; expires_at: number }>(
    `SELECT code, created_at, expires_at FROM pairing_codes
     WHERE desktop_device_id = ? AND used_at IS NULL AND expires_at > ?
     ORDER BY created_at DESC LIMIT 1`,
    desktopDeviceId,
    now,
  );

const phoneAccess = (db: OwnerDbReader, desktopDeviceId: string, now: number): PhoneAccessState => {
  const pairing = activePairing(db, desktopDeviceId, now);
  return {
    activePairing: pairing
      ? { pairingCode: pairing.code, expiresAt: pairing.expires_at, createdAt: pairing.created_at }
      : null,
    pairedDevices: db
      .all<PairedPhoneRow>(
        "SELECT * FROM paired_phones WHERE desktop_device_id = ? AND revoked_at IS NULL ORDER BY approved_at",
        desktopDeviceId,
      )
      .map((row) => ({
        mobileDeviceId: row.mobile_device_id,
        ...(row.display_name ? { displayName: row.display_name } : {}),
        ...(row.platform ? { platform: row.platform } : {}),
        approvedAt: row.approved_at,
        lastSeenAt: row.last_seen_at,
      })),
  };
};

const createPairing = (
  ctx: OwnerContext,
  args: DeviceCalls["phone.createPairing"]["args"],
): DeviceCalls["phone.createPairing"]["result"] => {
  enforceOwnerRateLimit(ctx.db, ctx.now, "phone.createPairing", { count: 6, windowMs: 60_000 }, "Too many pairing requests. Please wait a minute and try again.");
  const existing = activePairing(ctx.db, args.desktopDeviceId, ctx.now);
  if (existing) {
    return {
      pairingCode: existing.code,
      expiresAt: existing.expires_at,
      createdAt: existing.created_at,
      pairingUrl: pairingUrl(existing.code),
    };
  }
  let code = randomFrom(PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH);
  for (let attempt = 0; ctx.db.one("SELECT 1 AS taken FROM pairing_codes WHERE code = ?", code); attempt++) {
    if (attempt >= 5) throw new RpcError("UNAVAILABLE", "Could not allocate a pairing code. Please try again.");
    code = randomFrom(PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH);
  }
  const expiresAt = ctx.now + PAIRING_TTL_MS;
  ctx.db.run(
    "INSERT INTO pairing_codes (code, desktop_device_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    code,
    args.desktopDeviceId,
    ctx.now,
    expiresAt,
  );
  scheduleSweep(ctx);
  return { pairingCode: code, expiresAt, createdAt: ctx.now, pairingUrl: pairingUrl(code) };
};

const revokePhone = (ctx: OwnerContext, args: DeviceCalls["phone.revoke"]["args"]): null => {
  enforceOwnerRateLimit(ctx.db, ctx.now, "phone.revoke", { count: 20, windowMs: 60_000 }, "Too many revocation requests. Please wait a minute and try again.");
  ctx.db.run(
    "UPDATE paired_phones SET revoked_at = ? WHERE desktop_device_id = ? AND mobile_device_id = ? AND revoked_at IS NULL",
    ctx.now,
    args.desktopDeviceId,
    args.mobileDeviceId,
  );
  return null;
};

/**
 * Issue this phone a credential for one of the account's desktops.
 *
 * The pair secret is not an authorization step; it is the phone's *transport*
 * key. A phone has no Stella device key the cloud can verify, so this HMAC key
 * is what stands in for one on the mobile dispatch proof and on its requests
 * to the computer. Both callers below mint exactly the same row and differ
 * only in what they accepted as evidence beforehand.
 */
const grantPhoneAccess = async (
  ctx: OwnerContext,
  input: {
    desktopDeviceId: string;
    mobileDeviceId: string;
    displayName?: string;
    platform?: string;
  },
) => {
  const pairSecret = randomFrom(PAIR_SECRET_ALPHABET, PAIR_SECRET_LENGTH);
  const pairSecretHash = await sha256Hex(pairSecret);
  ctx.db.run(
    `INSERT INTO paired_phones (desktop_device_id, mobile_device_id, pair_secret_hash, display_name, platform, approved_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (desktop_device_id, mobile_device_id) DO UPDATE SET
       pair_secret_hash = excluded.pair_secret_hash,
       display_name = COALESCE(excluded.display_name, paired_phones.display_name),
       platform = COALESCE(excluded.platform, paired_phones.platform),
       last_seen_at = excluded.last_seen_at,
       revoked_at = NULL`,
    input.desktopDeviceId,
    input.mobileDeviceId,
    pairSecretHash,
    input.displayName ?? null,
    input.platform ?? null,
    ctx.now,
    ctx.now,
  );
  return { desktopDeviceId: input.desktopDeviceId, approvedAt: ctx.now, pairSecret };
};

/**
 * A phone signed into this account asks for a credential for a desktop it can
 * already see in the device list, with no code to carry between the two.
 *
 * This is the replacement for the pairing code, and it is a demotion rather
 * than a removal: the code only ever proved that whoever held the phone could
 * also see the desktop's screen, on top of an account check both ends already
 * passed. Dropping it makes account access sufficient — the trade the owner
 * chose — and it is still only a credential to *reach* that desktop. Whether
 * the desktop will run anything is `remote_execution_state`, which this does
 * not touch.
 *
 * The named desktop must be a registered device of this same owner. There is
 * no cross-account reach to check for: the row lives in the caller's own owner
 * object, so another account's desktop is not nameable from here.
 */
const attachPhone = async (
  ctx: OwnerContext,
  input: {
    desktopDeviceId: string;
    mobileDeviceId: string;
    displayName?: string;
    platform?: string;
  },
) => {
  enforceOwnerRateLimit(ctx.db, ctx.now, "phone.attach", { count: 30, windowMs: 60_000 }, "Too many connection attempts. Please wait a minute and try again.");
  const desktopDeviceId = resolveCurrentDeviceId(ctx.db, input.desktopDeviceId);
  const desktop = ctx.db.one<{ device_id: string }>(
    "SELECT device_id FROM devices WHERE device_id = ? AND public_key IS NOT NULL",
    desktopDeviceId,
  );
  if (!desktop) {
    throw new RpcError("NOT_FOUND", "That computer is not signed in to this account.");
  }
  return await grantPhoneAccess(ctx, { ...input, desktopDeviceId });
};

/** A phone signed into this account redeems a desktop's pairing code. */
const completePairing = async (
  ctx: OwnerContext,
  input: { pairingCode: string; mobileDeviceId: string; displayName?: string; platform?: string },
) => {
  enforceOwnerRateLimit(ctx.db, ctx.now, "phone.completePairing", { count: 30, windowMs: 60_000 }, "Too many pairing attempts. Please wait a minute and try again.");
  const session = ctx.db.one<{ desktop_device_id: string; expires_at: number; used_at: number | null }>(
    "SELECT desktop_device_id, expires_at, used_at FROM pairing_codes WHERE code = ?",
    input.pairingCode,
  );
  if (!session || session.used_at !== null || session.expires_at <= ctx.now) {
    throw new RpcError("BAD_REQUEST", "This pairing code is unavailable.");
  }
  const granted = await grantPhoneAccess(ctx, {
    ...input,
    desktopDeviceId: session.desktop_device_id,
  });
  ctx.db.run("UPDATE pairing_codes SET used_at = ? WHERE code = ?", ctx.now, input.pairingCode);
  return granted;
};

// ── Push ───────────────────────────────────────────────────────────────────

const ACTIVITY_COPY: Record<ActivityNotificationKind, { title: string; body: string }> = {
  started: { title: "Stella is working", body: "Stella started on your desktop." },
  completed: { title: "Stella finished", body: "Stella finished on your desktop." },
  failed: { title: "Stella needs attention", body: "Stella could not finish on your desktop." },
};

const registerPushToken = (ctx: OwnerContext, input: { token: string; mobileDeviceId: string; platform?: string }) => {
  ctx.db.run(
    `INSERT INTO push_tokens (token, mobile_device_id, platform, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (token) DO UPDATE SET mobile_device_id = excluded.mobile_device_id,
       platform = COALESCE(excluded.platform, push_tokens.platform), updated_at = excluded.updated_at`,
    input.token,
    input.mobileDeviceId,
    input.platform ?? null,
    ctx.now,
  );
  // One phone keeps one token; keep the newest few per owner.
  ctx.db.run(
    "DELETE FROM push_tokens WHERE mobile_device_id = ? AND token != ?",
    input.mobileDeviceId,
    input.token,
  );
  ctx.db.run(
    "DELETE FROM push_tokens WHERE token NOT IN (SELECT token FROM push_tokens ORDER BY updated_at DESC LIMIT ?)",
    MAX_TOKENS,
  );
};

type PushDigest = { last_sent_at: number; last_finish_at: number; completed: number; failed: number };

const readDigest = (ctx: OwnerContext): PushDigest =>
  ctx.db.one<PushDigest>("SELECT last_sent_at, last_finish_at, completed, failed FROM push_digest WHERE id = 1") ??
  { last_sent_at: 0, last_finish_at: 0, completed: 0, failed: 0 };

const writeDigest = (ctx: OwnerContext, digest: PushDigest): void => {
  ctx.db.run(
    `INSERT INTO push_digest (id, last_sent_at, last_finish_at, completed, failed) VALUES (1, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET last_sent_at = excluded.last_sent_at, last_finish_at = excluded.last_finish_at,
       completed = excluded.completed, failed = excluded.failed`,
    digest.last_sent_at,
    digest.last_finish_at,
    digest.completed,
    digest.failed,
  );
};

const taskCount = (count: number): string => `${count} ${count === 1 ? "task" : "tasks"}`;

const digestCopy = ({ completed, failed }: PushDigest): { title: string; body: string } => {
  if (completed + failed === 1) return ACTIVITY_COPY[failed ? "failed" : "completed"];
  if (failed === 0) {
    return { title: `Stella finished ${taskCount(completed)}`, body: `${taskCount(completed)} finished. Open Stella to see the results.` };
  }
  return {
    title: "Stella needs attention",
    body: completed === 0
      ? `${taskCount(failed)} could not finish.`
      : `${taskCount(completed)} finished, ${failed} could not finish.`,
  };
};

const notifyActivity = async (ctx: OwnerContext, kind: ActivityNotificationKind): Promise<null> => {
  enforceOwnerRateLimit(ctx.db, ctx.now, "phone.notifyActivity", { count: 30, windowMs: 60_000 }, "Slow down a moment and try again.");
  const digest = readDigest(ctx);
  if (kind === "started") {
    if (ctx.now - digest.last_sent_at < PUSH_QUIET_MS) return null;
    writeDigest(ctx, { ...digest, last_sent_at: ctx.now });
    return sendPush(ctx, ACTIVITY_COPY.started);
  }
  if (digest.completed + digest.failed === 0 && ctx.now - digest.last_finish_at >= PUSH_QUIET_MS) {
    writeDigest(ctx, { ...digest, last_sent_at: ctx.now, last_finish_at: ctx.now });
    return sendPush(ctx, ACTIVITY_COPY[kind]);
  }
  writeDigest(ctx, {
    ...digest,
    completed: digest.completed + (kind === "completed" ? 1 : 0),
    failed: digest.failed + (kind === "failed" ? 1 : 0),
  });
  ctx.jobs.schedule(DEVICES_PUSH_DIGEST_JOB, digest.last_finish_at + PUSH_QUIET_MS, null, { id: DEVICES_PUSH_DIGEST_JOB });
  return null;
};

const flushDigest = async (ctx: OwnerContext): Promise<void> => {
  const digest = readDigest(ctx);
  if (digest.completed + digest.failed === 0) return;
  writeDigest(ctx, { last_sent_at: ctx.now, last_finish_at: ctx.now, completed: 0, failed: 0 });
  await sendPush(ctx, digestCopy(digest));
};

const sendPush = async (ctx: OwnerContext, copy: { title: string; body: string }): Promise<null> => {
  const tokens = ctx.db.all<{ token: string }>("SELECT token FROM push_tokens ORDER BY updated_at DESC LIMIT ?", MAX_TOKENS);
  if (tokens.length === 0) return null;
  const response = await fetch(EXPO_PUSH_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(
      tokens.map(({ token }) => ({
        to: token,
        title: copy.title,
        body: copy.body,
        sound: "default",
        data: { kind: "agent_activity" },
        categoryId: "agent_activity",
        threadId: "agent_activity",
        collapseId: "agent_activity",
      })),
    ),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!response?.ok) return null;
  const parsed = (await response.json().catch(() => null)) as {
    data?: Array<{ status?: string; details?: { error?: string } }>;
  } | null;
  (parsed?.data ?? []).forEach((ticket, index) => {
    const error = ticket?.details?.error;
    if (ticket?.status === "error" && (error === "DeviceNotRegistered" || error === "InvalidCredentials")) {
      ctx.db.run("DELETE FROM push_tokens WHERE token = ?", tokens[index]!.token);
    }
  });
  return null;
};

const sweep = (ctx: OwnerContext): void => {
  ctx.db.run("DELETE FROM pairing_codes WHERE expires_at < ?", ctx.now - PAIRING_TTL_MS);
  const remaining = ctx.db.one<{ count: number }>("SELECT COUNT(*) AS count FROM pairing_codes")?.count ?? 0;
  if (remaining > 0) scheduleSweep(ctx);
};

// ── /api/mobile/* ──────────────────────────────────────────────────────────

export type MobileRouteInput = {
  route: string;
  caller: OwnerCaller;
  query: Record<string, string>;
  body: Record<string, unknown>;
  /** The `x-stella-mobile-*` request headers, lower-cased. */
  headers: Record<string, string>;
};

export type MobileRouteResult = { status: number; body: unknown };

const error = (status: number, message: string): MobileRouteResult => ({ status, body: { error: message } });

/** The phone routes, for a signed-in account. */
export const handleMobileRoute = async (ctx: OwnerContext, input: MobileRouteInput): Promise<MobileRouteResult> => {
  requireCaller(input.caller);
  const body = input.body;
  switch (input.route) {
    case "POST push-token": {
      const token = text(body.token, 512);
      const mobileDeviceId = text(body.mobileDeviceId, 256) || text(input.headers["x-stella-mobile-device-id"], 256);
      if (!token) return error(400, "Push token required");
      if (!mobileDeviceId) return error(400, "mobileDeviceId required");
      enforceOwnerRateLimit(ctx.db, ctx.now, "push.register", { count: 60, windowMs: 60_000 }, "Too many requests.");
      const platform = optionalText(body.platform, 64);
      registerPushToken(ctx, { token, mobileDeviceId, ...(platform ? { platform } : {}) });
      return { status: 200, body: { ok: true } };
    }
    case "POST push-token/unregister": {
      const mobileDeviceId = text(body.mobileDeviceId, 256) || text(input.headers["x-stella-mobile-device-id"], 256);
      if (!mobileDeviceId) return error(400, "mobileDeviceId required");
      ctx.db.run("DELETE FROM push_tokens WHERE mobile_device_id = ?", mobileDeviceId);
      return { status: 200, body: { ok: true } };
    }
    case "POST pairing/attach": {
      const desktopDeviceId = text(body.desktopDeviceId, 256);
      const mobileDeviceId = text(body.mobileDeviceId, 256) || text(input.headers["x-stella-mobile-device-id"], 256);
      if (!desktopDeviceId || !mobileDeviceId) {
        return error(400, "desktopDeviceId and mobileDeviceId are required");
      }
      const displayName = optionalText(body.displayName, 64);
      const platform = optionalText(body.platform, 64);
      try {
        return {
          status: 200,
          body: await attachPhone(ctx, {
            desktopDeviceId,
            mobileDeviceId,
            ...(displayName ? { displayName } : {}),
            ...(platform ? { platform } : {}),
          }),
        };
      } catch (caught) {
        if (caught instanceof RpcError && caught.code !== "RATE_LIMITED") return error(400, caught.message);
        throw caught;
      }
    }
    case "POST pairing/complete": {
      const pairingCode = text(body.pairingCode, 12).toUpperCase();
      const mobileDeviceId = text(body.mobileDeviceId, 256);
      if (!pairingCode || !mobileDeviceId) return error(400, "pairingCode and mobileDeviceId are required");
      const displayName = optionalText(body.displayName, 64);
      const platform = optionalText(body.platform, 64);
      try {
        return {
          status: 200,
          body: await completePairing(ctx, {
            pairingCode,
            mobileDeviceId,
            ...(displayName ? { displayName } : {}),
            ...(platform ? { platform } : {}),
          }),
        };
      } catch (caught) {
        if (caught instanceof RpcError && caught.code !== "RATE_LIMITED") return error(400, caught.message);
        throw caught;
      }
    }
    default:
      return error(404, "Not found");
  }
};

const deviceIdArg = string({ min: 1, max: 256 });

export const devicesDomain = {
  name: "devices",
  migrations: [
    DEVICES_MIGRATION,
    DEVICES_REMOTE_EXECUTION_MIGRATION,
    DEVICES_DROP_PHONE_BRIDGE_MIGRATION,
    DEVICES_PUSH_DIGEST_MIGRATION,
  ],
  calls: {
    "devices.identity": {
      scope: "owner",
      parse: object({ deviceId: optional(string({ max: 256 })) }),
      handler: (ctx: OwnerContext, args: DeviceCalls["devices.identity"]["args"]) => identity(ctx, args),
    },
    "devices.register": {
      scope: "owner",
      parse: object({
        deviceId: deviceIdArg,
        devicePublicKey: string({ min: 1, max: 512 }),
        deviceName: optional(string({ max: 96 })),
        platform: optional(string({ max: 32 })),
        capabilities: optional(array(literal(...CAPABILITIES), { max: 8 })),
      }),
      handler: (ctx: OwnerContext, args: DeviceCalls["devices.register"]["args"]) => register(ctx, args),
    },
    "devices.setRemoteExecution": {
      scope: "owner",
      parse: object({ deviceId: deviceIdArg, enabled: boolean() }),
      handler: (ctx: OwnerContext, args: DeviceCalls["devices.setRemoteExecution"]["args"]) => setRemoteExecution(ctx, args),
    },
    "devices.requestRemoteExecution": {
      scope: "owner",
      parse: object({ deviceId: deviceIdArg }),
      handler: (ctx: OwnerContext, args: DeviceCalls["devices.requestRemoteExecution"]["args"]) => requestRemoteExecution(ctx, args),
    },
    "devices.adoptSuccession": {
      scope: "owner",
      parse: object({ previousDeviceId: deviceIdArg, deviceId: deviceIdArg }),
      handler: (ctx: OwnerContext, args: DeviceCalls["devices.adoptSuccession"]["args"]) => adoptSuccession(ctx, args),
    },
    "phone.createPairing": {
      scope: "owner",
      parse: object({ desktopDeviceId: deviceIdArg }),
      handler: (ctx: OwnerContext, args: DeviceCalls["phone.createPairing"]["args"]) => createPairing(ctx, args),
    },
    "phone.revoke": {
      scope: "owner",
      parse: object({ desktopDeviceId: deviceIdArg, mobileDeviceId: deviceIdArg }),
      handler: (ctx: OwnerContext, args: DeviceCalls["phone.revoke"]["args"]) => revokePhone(ctx, args),
    },
    "phone.notifyActivity": {
      scope: "owner",
      parse: object({ kind: literal("started", "completed", "failed") }),
      handler: (ctx: OwnerContext, args: DeviceCalls["phone.notifyActivity"]["args"]) => notifyActivity(ctx, args.kind),
    },
  },
  /**
   * The gate owns the presence socket, so it is the gate that raises the
   * consent question and the gate that receives the answer the device signs
   * for on that socket. Both land here as internal writes rather than as
   * account calls, because the authority in those two moments is the device
   * key, not a user token.
   */
  internal: {
    "devices.setRemoteExecution": (ctx: OwnerContext, raw: unknown) =>
      setRemoteExecution(
        ctx,
        object({ deviceId: deviceIdArg, enabled: boolean() })(raw),
      ),
    "devices.requestRemoteExecution": (ctx: OwnerContext, raw: unknown) =>
      requestRemoteExecution(ctx, object({ deviceId: deviceIdArg })(raw)),
  },
  views: {
    "phone.access": {
      parse: object({ desktopDeviceId: deviceIdArg }),
      read: (ctx, args) => phoneAccess(ctx.db, args.desktopDeviceId, ctx.now),
    },
  },
  jobs: {
    [DEVICES_SWEEP_JOB]: { run: (ctx) => sweep(ctx), maxAttempts: 10 },
    [DEVICES_PUSH_DIGEST_JOB]: { run: (ctx) => flushDigest(ctx), maxAttempts: 3 },
  },
} satisfies OwnerDomain;
