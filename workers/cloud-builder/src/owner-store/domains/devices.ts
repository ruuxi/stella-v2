/**
 * The owner's devices: desktops that can run work (their presence-signing
 * keys and capabilities), phones paired to a desktop, each desktop's phone
 * bridge and its Cloudflare tunnel, and the phones' push tokens. Desktop UI
 * and runtime calls arrive as backend calls; phones and the desktop's bridge
 * service use the `/api/mobile/*` routes, which land in `handleMobileRoute`.
 */

import type {
  ActivityNotificationKind,
  ConnectIntent,
  DeviceCalls,
  ExecutionCapability,
  PhoneAccessState,
} from "@stella/contracts/backend/devices";
import { hmacSha256Hex, sha256Hex } from "@stella/contracts/turn-plane/pairing-proof";
import type { OwnerSnapshot } from "@stella/contracts/turn-plane/owner-snapshot";
import {
  createTunnel,
  deleteTunnel,
  repairTunnelDns,
  tunnelCredentials,
  tunnelExists,
  tunnelNames,
  writeTunnelDns,
} from "../../devices/cloudflare-tunnels.js";
import { array, literal, object, optional, string } from "../args.js";
import { RpcError } from "../errors.js";
import { enforceOwnerRateLimit } from "../rate-limit.js";
import type { OwnerCaller, OwnerContext, OwnerDbReader, OwnerDomain } from "../registry.js";

const MAX_DEVICES = 64;
const MAX_TUNNELS = 3;
const MAX_SUCCESSION_HOPS = 8;
const MAX_TOKENS = 25;
const PAIRING_TTL_MS = 10 * 60_000;
const CONNECT_INTENT_TTL_MS = 90_000;
const BRIDGE_LEASE_MS = 15 * 60_000;
const BRIDGE_MIN_REFRESH_MS = BRIDGE_LEASE_MS / 3;
const BRIDGE_SESSION_TTL_MS = 60 * 60_000;
const PROOF_MAX_SKEW_MS = 5 * 60_000;
const TUNNEL_PROVISION_LEASE_MS = 3 * 60_000;
const TUNNEL_IDLE_RETENTION_MS = 30 * 24 * 60 * 60_000;
const SWEEP_INTERVAL_MS = 24 * 60 * 60_000;
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_CODE_LENGTH = 8;
const PAIR_SECRET_LENGTH = 48;
const PAIR_SECRET_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const BRIDGE_PROOF_VERSION = "stella-mobile-bridge-pair-proof-v1";
const BRIDGE_PROTOCOL = "x25519-hkdf-sha256-aes-256-gcm-v1";
const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";
export const DEVICES_SWEEP_JOB = "devices.sweep";

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

type DeviceRow = {
  device_id: string;
  public_key: string | null;
  name: string | null;
  platform: string | null;
  remote_execution_enabled: number;
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

type BridgeRow = {
  device_id: string;
  base_urls: string;
  platform: string | null;
  desktop_public_key: string | null;
  updated_at: number;
};

type TunnelRow = {
  device_id: string;
  tunnel_name: string;
  hostname: string;
  state: "provisioning" | "ready";
  lease_expires_at: number | null;
  tunnel_id: string | null;
  tunnel_token: string | null;
  dns_record_id: string | null;
  created_at: number;
  last_used_at: number;
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

const randomBase64Url = (bytes: number): string =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
};

const text = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

const optionalText = (value: unknown, max: number): string | undefined => text(value, max) || undefined;

const publicKeyText = (value: unknown): string => {
  const key = text(value, 129);
  return key && key.length <= 128 && /^[A-Za-z0-9_-]+$/.test(key) ? key : "";
};

const tokenPart = (value: unknown): string => {
  const part = text(value, 257);
  return part && part.length <= 256 && /^[A-Za-z0-9_-]+$/.test(part) ? part : "";
};

const baseUrlList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const urls = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim() || entry.length > 2048) continue;
    try {
      const url = new URL(entry.trim());
      if (url.protocol === "http:" || url.protocol === "https:") urls.add(url.toString().replace(/\/+$/, ""));
    } catch {
      continue;
    }
    if (urls.size >= 8) break;
  }
  return [...urls];
};

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

const requireAccountCaller = (caller: OwnerCaller | null): OwnerCaller => {
  if (!caller || caller.isAnonymous) {
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
      `INSERT INTO devices (device_id, public_key, name, platform, remote_execution_enabled, capabilities, registered_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
      args.deviceId,
      args.devicePublicKey,
      args.deviceName ?? null,
      args.platform ?? null,
      capabilities,
      ctx.now,
      ctx.now,
    );
    return { deviceId: args.deviceId, ownerGeneration: snapshot.ownerGeneration, remoteExecutionEnabled: true, rotated: false };
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
    rotated: Boolean(existing.public_key && existing.public_key !== args.devicePublicKey),
  };
};

/** Move a retired desktop id's pairings, bridge and tunnel onto its successor. */
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
      return { ok: true, migratedPairings: 0, migratedRegistration: false, migratedTunnel: false };
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
  const move = (table: string) => {
    if (!ctx.db.one(`SELECT 1 AS present FROM ${table} WHERE device_id = ?`, args.previousDeviceId)) return false;
    if (ctx.db.one(`SELECT 1 AS present FROM ${table} WHERE device_id = ?`, args.deviceId)) {
      ctx.db.run(`DELETE FROM ${table} WHERE device_id = ?`, args.previousDeviceId);
      return false;
    }
    ctx.db.run(`UPDATE ${table} SET device_id = ? WHERE device_id = ?`, args.deviceId, args.previousDeviceId);
    return true;
  };
  const migratedRegistration = move("bridge_registrations");
  const migratedTunnel = move("tunnels");
  ctx.db.run(
    "INSERT INTO device_successors (previous_device_id, device_id, rotated_at) VALUES (?, ?, ?)",
    args.previousDeviceId,
    args.deviceId,
    ctx.now,
  );
  return { ok: true, migratedPairings, migratedRegistration, migratedTunnel };
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
      return {
        deviceId: row.device_id,
        publicKey: row.public_key!,
        remoteExecutionEnabled: row.remote_execution_enabled === 1,
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

const connectIntent = (db: OwnerDbReader, desktopDeviceId: string): ConnectIntent => {
  const row = db.one<{ intent_id: string; mobile_device_id: string; created_at: number; expires_at: number }>(
    `SELECT intent_id, mobile_device_id, created_at, expires_at FROM connect_intents
     WHERE desktop_device_id = ? AND acknowledged_at IS NULL
     ORDER BY expires_at DESC LIMIT 1`,
    desktopDeviceId,
  );
  return row
    ? { intentId: row.intent_id, mobileDeviceId: row.mobile_device_id, createdAt: row.created_at, expiresAt: row.expires_at }
    : null;
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
    session.desktop_device_id,
    input.mobileDeviceId,
    pairSecretHash,
    input.displayName ?? null,
    input.platform ?? null,
    ctx.now,
    ctx.now,
  );
  ctx.db.run("UPDATE pairing_codes SET used_at = ? WHERE code = ?", ctx.now, input.pairingCode);
  return { desktopDeviceId: session.desktop_device_id, approvedAt: ctx.now, pairSecret };
};

type PairProof = {
  mobileDeviceId: string;
  proof: string;
  issuedAt: number;
  challenge: string;
  mobilePublicKey?: string;
};

/** A paired phone's HMAC proof over this request, keyed by its pair secret's hash. */
const verifyPairProof = async (
  ctx: OwnerContext,
  desktopDeviceId: string,
  proof: PairProof,
): Promise<boolean> => {
  if (!proof.mobileDeviceId || !proof.proof || !proof.challenge) return false;
  if (!(proof.issuedAt > 0) || Math.abs(ctx.now - proof.issuedAt) > PROOF_MAX_SKEW_MS) return false;
  const paired = ctx.db.one<{ pair_secret_hash: string }>(
    "SELECT pair_secret_hash FROM paired_phones WHERE desktop_device_id = ? AND mobile_device_id = ? AND revoked_at IS NULL",
    desktopDeviceId,
    proof.mobileDeviceId,
  );
  if (!paired) return false;
  const message = [
    BRIDGE_PROOF_VERSION,
    desktopDeviceId,
    proof.mobileDeviceId,
    proof.challenge,
    proof.mobilePublicKey ?? "",
    String(proof.issuedAt),
  ].join("\n");
  return constantTimeEqual(await hmacSha256Hex(paired.pair_secret_hash, message), proof.proof.toLowerCase());
};

// ── The desktop's phone bridge ─────────────────────────────────────────────

const registerBridge = (
  ctx: OwnerContext,
  input: { deviceId: string; baseUrls: string[]; platform?: string; desktopPublicKey?: string },
) => {
  const existing = ctx.db.one<BridgeRow>("SELECT * FROM bridge_registrations WHERE device_id = ?", input.deviceId);
  const baseUrls = JSON.stringify(input.baseUrls);
  const unchanged =
    existing &&
    existing.base_urls === baseUrls &&
    (existing.platform ?? undefined) === input.platform &&
    (existing.desktop_public_key ?? undefined) === input.desktopPublicKey &&
    ctx.now - existing.updated_at < BRIDGE_MIN_REFRESH_MS;
  if (!unchanged) {
    enforceOwnerRateLimit(ctx.db, ctx.now, "bridge.register", { count: 60, windowMs: 60_000 }, "Too many desktop bridge registrations. Please wait a moment.");
    ctx.db.run(
      `INSERT INTO bridge_registrations (device_id, base_urls, platform, desktop_public_key, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (device_id) DO UPDATE SET base_urls = excluded.base_urls, platform = excluded.platform,
         desktop_public_key = excluded.desktop_public_key, updated_at = excluded.updated_at`,
      input.deviceId,
      baseUrls,
      input.platform ?? null,
      input.desktopPublicKey ?? null,
      ctx.now,
    );
  }
  const updatedAt = unchanged ? existing!.updated_at : ctx.now;
  return { ok: true, written: !unchanged, leaseDurationMs: BRIDGE_LEASE_MS, leaseExpiresAt: updatedAt + BRIDGE_LEASE_MS };
};

const bridgeStatus = (db: OwnerDbReader, now: number, requested: string | undefined) => {
  const row = requested
    ? db.one<BridgeRow>("SELECT * FROM bridge_registrations WHERE device_id = ?", resolveCurrentDeviceId(db, requested))
    : db.one<BridgeRow>("SELECT * FROM bridge_registrations ORDER BY updated_at DESC LIMIT 1");
  if (!row) {
    return { available: false, baseUrls: [], platform: null, updatedAt: null, lastKnownRegistration: null };
  }
  const available = row.updated_at + BRIDGE_LEASE_MS > now;
  const baseUrls = JSON.parse(row.base_urls) as string[];
  const platform =
    row.platform ??
    db.one<{ platform: string | null }>("SELECT platform FROM devices WHERE device_id = ?", row.device_id)?.platform ??
    null;
  return {
    available,
    baseUrls: available ? baseUrls : [],
    platform,
    updatedAt: row.updated_at,
    lastKnownRegistration: {
      desktopDeviceId: row.device_id,
      baseUrls,
      platform,
      desktopPublicKey: row.desktop_public_key,
      updatedAt: row.updated_at,
    },
  };
};

const createBridgeSession = async (
  ctx: OwnerContext,
  input: { desktopDeviceId: string; mobileDeviceId: string; desktopChallenge: string; desktopPublicKey: string; mobilePublicKey: string },
) => {
  ctx.db.run(
    "DELETE FROM bridge_sessions WHERE desktop_device_id = ? AND mobile_device_id = ? AND expires_at <= ?",
    input.desktopDeviceId,
    input.mobileDeviceId,
    ctx.now,
  );
  const sessionId = randomBase64Url(18);
  const sessionSecret = randomBase64Url(32);
  const expiresAt = ctx.now + BRIDGE_SESSION_TTL_MS;
  ctx.db.run(
    `INSERT INTO bridge_sessions (session_id, desktop_device_id, mobile_device_id, secret_hash, desktop_challenge,
       desktop_public_key, mobile_public_key, created_at, expires_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    sessionId,
    input.desktopDeviceId,
    input.mobileDeviceId,
    await sha256Hex(sessionSecret),
    input.desktopChallenge,
    input.desktopPublicKey,
    input.mobilePublicKey,
    ctx.now,
    expiresAt,
    ctx.now,
  );
  ctx.db.run(
    "UPDATE paired_phones SET last_seen_at = ? WHERE desktop_device_id = ? AND mobile_device_id = ?",
    ctx.now,
    input.desktopDeviceId,
    input.mobileDeviceId,
  );
  scheduleSweep(ctx);
  return { sessionId, sessionSecret, expiresAt, desktopPublicKey: input.desktopPublicKey };
};

const consumeBridgeSession = async (
  ctx: OwnerContext,
  input: { desktopDeviceId: string; sessionId: string; sessionSecret: string; desktopChallenge: string },
) => {
  const session = ctx.db.one<{
    desktop_device_id: string;
    mobile_device_id: string;
    secret_hash: string;
    desktop_challenge: string;
    desktop_public_key: string;
    mobile_public_key: string;
    expires_at: number;
  }>("SELECT * FROM bridge_sessions WHERE session_id = ?", input.sessionId);
  if (
    !session ||
    session.desktop_device_id !== input.desktopDeviceId ||
    session.desktop_challenge !== input.desktopChallenge ||
    session.expires_at <= ctx.now ||
    !constantTimeEqual(await sha256Hex(input.sessionSecret), session.secret_hash)
  ) {
    return null;
  }
  ctx.db.run("UPDATE bridge_sessions SET last_seen_at = ? WHERE session_id = ?", ctx.now, input.sessionId);
  return {
    sessionId: input.sessionId,
    mobileDeviceId: session.mobile_device_id,
    mobilePublicKey: session.mobile_public_key,
    desktopPublicKey: session.desktop_public_key,
    desktopChallenge: session.desktop_challenge,
    expiresAt: session.expires_at,
  };
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

/** Send a notification to every phone of this owner through Expo. */
const notifyPhones = async (ctx: OwnerContext, kind: ActivityNotificationKind): Promise<null> => {
  enforceOwnerRateLimit(ctx.db, ctx.now, "phone.notifyActivity", { count: 30, windowMs: 60_000 }, "Slow down a moment and try again.");
  const tokens = ctx.db.all<{ token: string }>("SELECT token FROM push_tokens ORDER BY updated_at DESC LIMIT ?", MAX_TOKENS);
  if (tokens.length === 0) return null;
  const copy = ACTIVITY_COPY[kind];
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

// ── Tunnels ────────────────────────────────────────────────────────────────

type TunnelResult = {
  tunnelToken: string;
  hostname: string;
  repair?: { dnsRepaired: boolean; reprovisioned: boolean };
};

/**
 * The desktop's tunnel token, provisioning the tunnel on first use. A repair
 * pass checks the remote tunnel and its DNS first, reprovisioning a tunnel
 * that is gone. A `provisioning` row with a live lease means another request
 * is creating it right now.
 */
const tunnelToken = async (
  ctx: OwnerContext,
  input: { deviceId: string; repair: boolean },
): Promise<TunnelResult> => {
  const snapshot = await ctx.host.snapshot();
  if (snapshot.identityLevel < 2) {
    throw new RpcError("FORBIDDEN", "A Google or Apple account is required for tunnels.", { reason: "sign_in_required" });
  }
  enforceOwnerRateLimit(ctx.db, ctx.now, "bridge.tunnelToken", { count: 12, windowMs: 60_000 }, "Too many tunnel requests. Please wait a moment.");
  const credentials = tunnelCredentials(ctx.env);
  let reprovisioned = false;
  let row = ctx.db.one<TunnelRow>("SELECT * FROM tunnels WHERE device_id = ?", input.deviceId);
  if (row?.state === "ready" && row.tunnel_id && row.tunnel_token) {
    if (!input.repair) {
      ctx.db.run("UPDATE tunnels SET last_used_at = ? WHERE device_id = ?", ctx.now, input.deviceId);
      return { tunnelToken: row.tunnel_token, hostname: row.hostname };
    }
    if (await tunnelExists(credentials, row.tunnel_id)) {
      const dns = await repairTunnelDns(credentials, {
        tunnelName: row.tunnel_name,
        hostname: row.hostname,
        tunnelId: row.tunnel_id,
      });
      ctx.db.run(
        "UPDATE tunnels SET dns_record_id = ?, last_used_at = ? WHERE device_id = ?",
        dns.recordId,
        ctx.now,
        input.deviceId,
      );
      return { tunnelToken: row.tunnel_token, hostname: row.hostname, repair: { dnsRepaired: dns.repaired, reprovisioned: false } };
    }
    await deleteTunnel(credentials, {
      tunnelName: row.tunnel_name,
      hostname: row.hostname,
      tunnelId: row.tunnel_id,
      dnsRecordId: row.dns_record_id,
    });
    ctx.db.run("DELETE FROM tunnels WHERE device_id = ?", input.deviceId);
    row = null;
    reprovisioned = true;
  }
  if (row?.state === "provisioning") {
    if ((row.lease_expires_at ?? 0) > ctx.now) {
      throw new RpcError("CONFLICT", "Tunnel provisioning is already in progress.");
    }
    // A crashed attempt: clean up whatever it may have created, by name.
    await deleteTunnel(credentials, {
      tunnelName: row.tunnel_name,
      hostname: row.hostname,
      tunnelId: row.tunnel_id,
      dnsRecordId: row.dns_record_id,
    });
    ctx.db.run("DELETE FROM tunnels WHERE device_id = ?", input.deviceId);
  }
  const count = ctx.db.one<{ count: number }>("SELECT COUNT(*) AS count FROM tunnels")?.count ?? 0;
  if (count >= MAX_TUNNELS) {
    throw new RpcError("CONFLICT", "This account already has the most tunnels it can.", { reason: "tunnel_limit" });
  }
  const { tunnelName, hostname } = await tunnelNames(ctx.ownerId, input.deviceId);
  ctx.db.run(
    `INSERT INTO tunnels (device_id, tunnel_name, hostname, state, lease_expires_at, created_at, last_used_at)
     VALUES (?, ?, ?, 'provisioning', ?, ?, ?)`,
    input.deviceId,
    tunnelName,
    hostname,
    ctx.now + TUNNEL_PROVISION_LEASE_MS,
    ctx.now,
    ctx.now,
  );
  try {
    const tunnel = await createTunnel(credentials, tunnelName);
    ctx.db.run("UPDATE tunnels SET tunnel_id = ? WHERE device_id = ?", tunnel.tunnelId, input.deviceId);
    const dnsRecordId = await writeTunnelDns(credentials, { tunnelName, tunnelId: tunnel.tunnelId });
    ctx.db.run(
      `UPDATE tunnels SET state = 'ready', lease_expires_at = NULL, tunnel_token = ?, dns_record_id = ?, last_used_at = ?
       WHERE device_id = ?`,
      tunnel.tunnelToken,
      dnsRecordId,
      Date.now(),
      input.deviceId,
    );
    scheduleSweep(ctx);
    return {
      tunnelToken: tunnel.tunnelToken,
      hostname,
      ...(input.repair ? { repair: { dnsRepaired: reprovisioned, reprovisioned } } : {}),
    };
  } catch (error) {
    const partial = ctx.db.one<TunnelRow>("SELECT * FROM tunnels WHERE device_id = ?", input.deviceId);
    await deleteTunnel(credentials, {
      tunnelName,
      hostname,
      tunnelId: partial?.tunnel_id ?? null,
      dnsRecordId: partial?.dns_record_id ?? null,
    }).then(
      () => ctx.db.run("DELETE FROM tunnels WHERE device_id = ?", input.deviceId),
      () => undefined,
    );
    throw error;
  }
};

/** Delete every tunnel of this owner (account deletion), or only idle ones. */
export const deleteTunnels = async (ctx: OwnerContext, options: { idleOnly: boolean }): Promise<number> => {
  const rows = options.idleOnly
    ? ctx.db.all<TunnelRow>("SELECT * FROM tunnels WHERE last_used_at < ?", ctx.now - TUNNEL_IDLE_RETENTION_MS)
    : ctx.db.all<TunnelRow>("SELECT * FROM tunnels");
  if (rows.length === 0) return 0;
  const credentials = tunnelCredentials(ctx.env);
  for (const row of rows) {
    await deleteTunnel(credentials, {
      tunnelName: row.tunnel_name,
      hostname: row.hostname,
      tunnelId: row.tunnel_id,
      dnsRecordId: row.dns_record_id,
    });
    ctx.db.run("DELETE FROM tunnels WHERE device_id = ?", row.device_id);
  }
  return rows.length;
};

const sweep = async (ctx: OwnerContext): Promise<void> => {
  ctx.db.run("DELETE FROM pairing_codes WHERE expires_at < ?", ctx.now - PAIRING_TTL_MS);
  ctx.db.run("DELETE FROM connect_intents WHERE expires_at < ?", ctx.now);
  ctx.db.run("DELETE FROM bridge_sessions WHERE expires_at < ?", ctx.now);
  await deleteTunnels(ctx, { idleOnly: true });
  const remaining =
    (ctx.db.one<{ count: number }>(
      "SELECT (SELECT COUNT(*) FROM tunnels) + (SELECT COUNT(*) FROM pairing_codes) + (SELECT COUNT(*) FROM bridge_sessions) AS count",
    )?.count ?? 0);
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

const proofFrom = (input: MobileRouteInput, overrides: { challenge?: string; mobilePublicKey?: string } = {}): PairProof => {
  const mobilePublicKey = overrides.mobilePublicKey ?? (publicKeyText(input.headers["x-stella-mobile-public-key"]) || undefined);
  return {
    mobileDeviceId: text(input.headers["x-stella-mobile-device-id"], 256),
    proof: text(input.headers["x-stella-mobile-pair-proof"], 256),
    issuedAt: Number(input.headers["x-stella-mobile-pair-proof-issued-at"] ?? "") || 0,
    challenge: overrides.challenge ?? text(input.headers["x-stella-mobile-pair-proof-challenge"], 512),
    ...(mobilePublicKey ? { mobilePublicKey } : {}),
  };
};

const error = (status: number, message: string): MobileRouteResult => ({ status, body: { error: message } });

/** The phone and desktop-bridge routes, for a signed-in account. */
export const handleMobileRoute = async (ctx: OwnerContext, input: MobileRouteInput): Promise<MobileRouteResult> => {
  requireAccountCaller(input.caller);
  const body = input.body;
  switch (input.route) {
    case "GET desktop-bridge": {
      enforceOwnerRateLimit(ctx.db, ctx.now, "bridge.status", { count: 60, windowMs: 60_000 }, "Too many requests.");
      return { status: 200, body: bridgeStatus(ctx.db, ctx.now, optionalText(input.query.desktopDeviceId, 256)) };
    }
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
    case "POST desktop-bridge/register": {
      const deviceId = text(body.deviceId, 256);
      const baseUrls = baseUrlList(body.baseUrls);
      if (!deviceId || baseUrls.length === 0) return error(400, "deviceId and baseUrls are required");
      const platform = optionalText(body.platform, 64);
      const desktopPublicKey = publicKeyText(body.desktopPublicKey) || undefined;
      return {
        status: 200,
        body: registerBridge(ctx, {
          deviceId,
          baseUrls,
          ...(platform ? { platform } : {}),
          ...(desktopPublicKey ? { desktopPublicKey } : {}),
        }),
      };
    }
    case "POST desktop-bridge/clear": {
      const deviceId = text(body.deviceId, 256);
      if (!deviceId) return error(400, "deviceId is required");
      ctx.db.run("DELETE FROM bridge_registrations WHERE device_id = ?", deviceId);
      return { status: 200, body: { ok: true } };
    }
    case "POST desktop-bridge/request": {
      const desktopDeviceId = text(body.desktopDeviceId, 256);
      if (!desktopDeviceId) return error(400, "desktopDeviceId is required");
      enforceOwnerRateLimit(ctx.db, ctx.now, "bridge.request", { count: 60, windowMs: 60_000 }, "Too many requests.");
      const proof = proofFrom(input);
      if (!(await verifyPairProof(ctx, desktopDeviceId, proof))) return error(403, "This phone credential is invalid");
      ctx.db.run(
        `INSERT INTO connect_intents (intent_id, desktop_device_id, mobile_device_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (desktop_device_id, mobile_device_id) DO UPDATE SET
           created_at = excluded.created_at, expires_at = excluded.expires_at, acknowledged_at = NULL`,
        crypto.randomUUID(),
        desktopDeviceId,
        proof.mobileDeviceId,
        ctx.now,
        ctx.now + CONNECT_INTENT_TTL_MS,
      );
      scheduleSweep(ctx);
      return { status: 200, body: { ok: true } };
    }
    case "POST desktop-bridge/session": {
      const desktopDeviceId = text(body.desktopDeviceId, 256);
      const desktopChallenge = text(body.desktopChallenge, 512);
      const mobilePublicKey = publicKeyText(body.mobilePublicKey);
      if (!desktopDeviceId || !desktopChallenge || !mobilePublicKey) {
        return error(400, "desktopDeviceId, desktopChallenge and mobilePublicKey are required");
      }
      enforceOwnerRateLimit(ctx.db, ctx.now, "bridge.session", { count: 60, windowMs: 60_000 }, "Too many requests.");
      const registration = ctx.db.one<BridgeRow>("SELECT * FROM bridge_registrations WHERE device_id = ?", desktopDeviceId);
      if (!registration) return error(403, "Desktop bridge is unavailable");
      if (!registration.desktop_public_key) return error(409, "Update Stella desktop to use the secure mobile bridge.");
      const proof = proofFrom(input, { challenge: desktopChallenge, mobilePublicKey });
      if (!(await verifyPairProof(ctx, desktopDeviceId, proof))) return error(403, "This phone credential is invalid");
      const session = await createBridgeSession(ctx, {
        desktopDeviceId,
        mobileDeviceId: proof.mobileDeviceId,
        desktopChallenge,
        desktopPublicKey: registration.desktop_public_key,
        mobilePublicKey,
      });
      return { status: 200, body: { ok: true, protocol: BRIDGE_PROTOCOL, ...session } };
    }
    case "POST desktop-bridge/session/consume": {
      const desktopDeviceId = text(body.deviceId, 256);
      const sessionId = tokenPart(body.sessionId);
      const sessionSecret = tokenPart(body.sessionSecret);
      const desktopChallenge = text(body.desktopChallenge, 512);
      if (!desktopDeviceId || !sessionId || !sessionSecret || !desktopChallenge) {
        return error(400, "deviceId, sessionId, sessionSecret and desktopChallenge are required");
      }
      const consumed = await consumeBridgeSession(ctx, { desktopDeviceId, sessionId, sessionSecret, desktopChallenge });
      if (!consumed) return error(403, "Invalid bridge session");
      return { status: 200, body: { ok: true, protocol: BRIDGE_PROTOCOL, ...consumed } };
    }
    case "POST desktop-bridge/tunnel-token": {
      const deviceId = text(body.deviceId, 256);
      if (!deviceId) return error(400, "deviceId is required");
      try {
        return { status: 200, body: await tunnelToken(ctx, { deviceId, repair: body.repair === true }) };
      } catch (caught) {
        if (caught instanceof RpcError && caught.reason === "sign_in_required") return error(403, "sign_in_required");
        if (caught instanceof RpcError && caught.reason === "tunnel_limit") return error(409, "tunnel_limit");
        if (caught instanceof RpcError) return error(caught.code === "RATE_LIMITED" ? 429 : 409, caught.message);
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
  migrations: [DEVICES_MIGRATION],
  calls: {
    "devices.identity": {
      scope: "owner",
      requireAccount: true,
      parse: object({ deviceId: optional(string({ max: 256 })) }),
      handler: (ctx: OwnerContext, args: DeviceCalls["devices.identity"]["args"]) => identity(ctx, args),
    },
    "devices.register": {
      scope: "owner",
      requireAccount: true,
      parse: object({
        deviceId: deviceIdArg,
        devicePublicKey: string({ min: 1, max: 512 }),
        deviceName: optional(string({ max: 96 })),
        platform: optional(string({ max: 32 })),
        capabilities: optional(array(literal(...CAPABILITIES), { max: 8 })),
      }),
      handler: (ctx: OwnerContext, args: DeviceCalls["devices.register"]["args"]) => register(ctx, args),
    },
    "devices.adoptSuccession": {
      scope: "owner",
      requireAccount: true,
      parse: object({ previousDeviceId: deviceIdArg, deviceId: deviceIdArg }),
      handler: (ctx: OwnerContext, args: DeviceCalls["devices.adoptSuccession"]["args"]) => adoptSuccession(ctx, args),
    },
    "phone.createPairing": {
      scope: "owner",
      requireAccount: true,
      parse: object({ desktopDeviceId: deviceIdArg }),
      handler: (ctx: OwnerContext, args: DeviceCalls["phone.createPairing"]["args"]) => createPairing(ctx, args),
    },
    "phone.revoke": {
      scope: "owner",
      requireAccount: true,
      parse: object({ desktopDeviceId: deviceIdArg, mobileDeviceId: deviceIdArg }),
      handler: (ctx: OwnerContext, args: DeviceCalls["phone.revoke"]["args"]) => revokePhone(ctx, args),
    },
    "phone.acknowledgeIntent": {
      scope: "owner",
      requireAccount: true,
      parse: object({ intentId: string({ min: 1, max: 64 }) }),
      handler: (ctx: OwnerContext, args: DeviceCalls["phone.acknowledgeIntent"]["args"]) => {
        ctx.db.run(
          "UPDATE connect_intents SET acknowledged_at = ? WHERE intent_id = ? AND acknowledged_at IS NULL",
          ctx.now,
          args.intentId,
        );
        return null;
      },
    },
    "phone.notifyActivity": {
      scope: "owner",
      requireAccount: true,
      parse: object({ kind: literal("started", "completed", "failed") }),
      handler: (ctx: OwnerContext, args: DeviceCalls["phone.notifyActivity"]["args"]) => notifyPhones(ctx, args.kind),
    },
  },
  views: {
    "phone.access": {
      requireAccount: true,
      parse: object({ desktopDeviceId: deviceIdArg }),
      read: (ctx, args) => phoneAccess(ctx.db, args.desktopDeviceId, ctx.now),
    },
    "phone.connectIntent": {
      requireAccount: true,
      parse: object({ desktopDeviceId: deviceIdArg }),
      read: (ctx, args) => connectIntent(ctx.db, args.desktopDeviceId),
    },
  },
  jobs: {
    [DEVICES_SWEEP_JOB]: { run: (ctx) => sweep(ctx), maxAttempts: 10 },
  },
} satisfies OwnerDomain;
