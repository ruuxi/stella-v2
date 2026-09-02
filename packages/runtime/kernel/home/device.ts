import { promises as fs } from "fs";
import path from "path";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as signBytes,
} from "crypto";

import { Effect } from "effect";

import {
  deleteProtectedValue,
  protectValue,
  unprotectValue,
} from "../shared/protected-storage.js";
import { ensurePrivateDir, writePrivateFile } from "../shared/private-fs.js";
import { getFileLogger } from "../../observability/file-logger.js";
import { withHome } from "./home-runtime.js";

type DeviceRecord = {
  deviceId: string;
  publicKey?: string;
  privateKeyProtected?: string;
  /**
   * The device id this record replaced, retained until the backend has been
   * told about the succession. Persisted rather than held in memory because a
   * rotation can happen while signed out or offline, and losing the link would
   * strand every paired phone on the retired id permanently.
   */
  supersededDeviceId?: string;
};

export type DeviceIdentity = {
  deviceId: string;
  publicKey: string;
  privateKey: string;
  /** Set when this identity replaced an earlier one whose succession is unclaimed. */
  supersededDeviceId?: string;
};

/**
 * The existing desktop identity adapted to the raw-key DPoP wire format.
 * Signatures are base64url so callers never need access to the private key.
 */
export type DeviceSigner = {
  alg: "ed25519";
  rawPublicKey: Uint8Array;
  sign(input: string): Promise<string>;
};

const DEVICE_FILE = "device.json";
const DEVICE_PRIVATE_KEY_SCOPE = "device-private-key";
const deviceSignerCache = new Map<string, DeviceSigner>();

/**
 * Why a stored identity could not be reused.
 *
 * Regenerating mints a new `deviceId`, which the backend treats as a different
 * machine — so every one of these is a user-visible event, not a detail. They
 * used to be indistinguishable: a single bare `catch` swallowed all of them,
 * leaving nothing to tell a missing file apart from a key the OS refused to
 * decrypt, and no way to know which path a rotation in the wild took.
 */
type DeviceIdentityRegenerationReason =
  | "no-record"
  | "unreadable-record"
  | "malformed-record"
  | "incomplete-record"
  | "undecryptable-private-key";

const logDeviceIdentityRegeneration = (
  reason: DeviceIdentityRegenerationReason,
  supersededDeviceId: string | undefined,
) => {
  // A first run has nothing to report.
  if (reason === "no-record" && !supersededDeviceId) {
    return;
  }
  // Prefer the process log so a rotation is still diagnosable after the fact;
  // identity can be loaded before the logger exists, hence the console fallback.
  const logger = getFileLogger();
  if (logger) {
    logger.warn("device-identity.regenerated", {
      reason,
      ...(supersededDeviceId ? { supersededDeviceId } : {}),
    });
    return;
  }
  console.warn(
    `[device-identity] Minting a new device id; the stored identity could not be reused: ${reason}.` +
      (supersededDeviceId ? ` Superseding ${supersededDeviceId}.` : ""),
  );
};

/** Adapt a leaf Promise IO call, failing with the raw thrown value. */
const tryIO = <A>(f: () => Promise<A>): Effect.Effect<A, unknown> =>
  Effect.tryPromise({ try: f, catch: (error) => error });

export const getDeviceRecordPath = (statePath: string) =>
  path.join(statePath, DEVICE_FILE);

export const getOrCreateDeviceId = async (statePath: string) => {
  const identity = await getOrCreateDeviceIdentity(statePath);
  return identity.deviceId;
};

export const deviceSignerForIdentity = (
  identity: DeviceIdentity,
): DeviceSigner => {
  const cached = deviceSignerCache.get(identity.deviceId);
  if (cached) return cached;

  const publicKey = createPublicKey({
    key: Buffer.from(identity.publicKey, "base64"),
    format: "der",
    type: "spki",
  });
  const publicJwk = publicKey.export({ format: "jwk" });
  if (
    publicJwk.kty !== "OKP" ||
    publicJwk.crv !== "Ed25519" ||
    typeof publicJwk.x !== "string"
  ) {
    throw new Error("Stored Stella device key is not Ed25519.");
  }
  const rawPublicKey = new Uint8Array(
    Buffer.from(publicJwk.x, "base64url"),
  );
  if (rawPublicKey.byteLength !== 32) {
    throw new Error("Stored Stella device public key is malformed.");
  }
  const privateKey = createPrivateKey({
    key: Buffer.from(identity.privateKey, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const signer: DeviceSigner = {
    alg: "ed25519",
    rawPublicKey,
    sign: async (input) =>
      signBytes(null, Buffer.from(input, "utf8"), privateKey).toString(
        "base64url",
      ),
  };
  deviceSignerCache.set(identity.deviceId, signer);
  return signer;
};

export const getOrCreateDeviceSigner = async (
  statePath: string,
): Promise<DeviceSigner> =>
  deviceSignerForIdentity(await getOrCreateDeviceIdentity(statePath));

const generateDeviceKeyPair = (): Pick<
  DeviceIdentity,
  "publicKey" | "privateKey"
> => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
    privateKey: privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
  };
};

const toStoredDeviceRecord = (identity: DeviceIdentity): DeviceRecord => ({
  deviceId: identity.deviceId,
  publicKey: identity.publicKey,
  privateKeyProtected: protectValue(
    DEVICE_PRIVATE_KEY_SCOPE,
    identity.privateKey,
  ),
  ...(identity.supersededDeviceId
    ? { supersededDeviceId: identity.supersededDeviceId }
    : {}),
});

const createAndStoreDeviceIdentityEffect = (
  recordPath: string,
  previousPrivateKeyProtected?: string,
  supersededDeviceId?: string,
): Effect.Effect<DeviceIdentity, unknown> =>
  Effect.gen(function* () {
    const payload = yield* Effect.sync(
      (): DeviceIdentity => ({
        deviceId: crypto.randomUUID(),
        ...generateDeviceKeyPair(),
        ...(supersededDeviceId ? { supersededDeviceId } : {}),
      }),
    );
    const record = yield* Effect.sync(() => toStoredDeviceRecord(payload));
    yield* tryIO(() => ensurePrivateDir(path.dirname(recordPath)));
    yield* tryIO(() =>
      writePrivateFile(recordPath, JSON.stringify(record, null, 2)),
    );
    if (
      previousPrivateKeyProtected &&
      previousPrivateKeyProtected !== record.privateKeyProtected
    ) {
      yield* Effect.sync(() =>
        deleteProtectedValue(
          DEVICE_PRIVATE_KEY_SCOPE,
          previousPrivateKeyProtected,
        ),
      );
    }
    return payload;
  });

/**
 * Read the persisted device record, tracking why it is unusable so a
 * regeneration can be logged with its cause. Captures `privateKeyProtected`
 * even when the rest of the record is unusable, so a re-key can clean up the
 * superseded protected value. `reason` is only meaningful when `parsed` is
 * undefined; later stages refine it for records that parse but cannot be
 * reused.
 */
const readPersistedDeviceRecord = (
  recordPath: string,
): Effect.Effect<{
  parsed: DeviceRecord | undefined;
  reason: DeviceIdentityRegenerationReason;
}> =>
  tryIO(
    async (): Promise<{
      parsed: DeviceRecord | undefined;
      reason: DeviceIdentityRegenerationReason;
    }> => {
      let raw: string;
      try {
        raw = await fs.readFile(recordPath, "utf-8");
      } catch (error) {
        return {
          parsed: undefined,
          reason:
            (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
              ? "no-record"
              : "unreadable-record",
        };
      }
      try {
        return { parsed: JSON.parse(raw) as DeviceRecord, reason: "no-record" };
      } catch {
        return { parsed: undefined, reason: "malformed-record" };
      }
    },
  ).pipe(
    Effect.catch(() =>
      Effect.succeed({
        parsed: undefined,
        reason: "unreadable-record" as DeviceIdentityRegenerationReason,
      }),
    ),
  );

export const getOrCreateDeviceIdentityEffect = (
  statePath: string,
): Effect.Effect<DeviceIdentity, unknown> =>
  Effect.gen(function* () {
    const recordPath = getDeviceRecordPath(statePath);
    const { parsed, reason: readReason } =
      yield* readPersistedDeviceRecord(recordPath);
    const previousPrivateKeyProtected = parsed?.privateKeyProtected;
    // Carried into the replacement identity so the backend can move this
    // machine's pairings, bridge registration and tunnel onto the new id. The
    // id itself is not a secret, and the replacement is an ordinary device with
    // its own keypair, so nothing about the key binding is relaxed by this.
    // Captured before the decrypt attempt, which is precisely the case whose
    // predecessor we need to keep.
    const supersededDeviceId = parsed?.deviceId ? parsed.deviceId : undefined;
    let reason = readReason;
    const existing = yield* Effect.try({
      try: (): DeviceIdentity | null => {
        if (
          parsed?.deviceId &&
          parsed.publicKey &&
          parsed.privateKeyProtected
        ) {
          const decryptedPrivateKey = unprotectValue(
            DEVICE_PRIVATE_KEY_SCOPE,
            parsed.privateKeyProtected,
          );
          // A record that cannot be decrypted is unusable: fall through to
          // create a fresh identity (the pre-Effect code threw here and was
          // caught by the same fall-through).
          if (!decryptedPrivateKey) {
            reason = "undecryptable-private-key";
            return null;
          }
          return {
            deviceId: parsed.deviceId,
            publicKey: parsed.publicKey,
            privateKey: decryptedPrivateKey,
            ...(parsed.supersededDeviceId
              ? { supersededDeviceId: parsed.supersededDeviceId }
              : {}),
          };
        }
        if (parsed) {
          reason = "incomplete-record";
        }
        return null;
      },
      catch: (error) => error,
    }).pipe(Effect.catch(() => Effect.succeed(null)));
    if (existing) return existing;
    yield* Effect.sync(() =>
      logDeviceIdentityRegeneration(reason, supersededDeviceId),
    );
    return yield* createAndStoreDeviceIdentityEffect(
      recordPath,
      previousPrivateKeyProtected,
      supersededDeviceId,
    );
  });

export const getOrCreateDeviceIdentity = (
  statePath: string,
): Promise<DeviceIdentity> =>
  withHome((home) => home.getOrCreateDeviceIdentity(statePath));

export const resetDeviceIdentityEffect = (
  statePath: string,
  options: { preservePairings?: boolean } = {},
): Effect.Effect<DeviceIdentity, unknown> =>
  Effect.gen(function* () {
    const recordPath = getDeviceRecordPath(statePath);
    const { parsed } = yield* readPersistedDeviceRecord(recordPath);
    // Only an involuntary rotation (recovering from a key mismatch) carries the
    // old identity forward. A user-initiated reset is meant to cut ties, so it
    // must not drag the previous machine's pairings onto the new id.
    const supersededDeviceId =
      options.preservePairings && parsed?.deviceId ? parsed.deviceId : undefined;
    const identity = yield* createAndStoreDeviceIdentityEffect(
      recordPath,
      parsed?.privateKeyProtected,
      supersededDeviceId,
    );
    if (parsed?.deviceId) deviceSignerCache.delete(parsed.deviceId);
    return identity;
  });

export const resetDeviceIdentity = (
  statePath: string,
  options: { preservePairings?: boolean } = {},
): Promise<DeviceIdentity> =>
  withHome((home) => home.resetDeviceIdentity(statePath, options));

/**
 * Drop the retained predecessor once the backend has accepted the succession,
 * so it is claimed exactly once.
 */
export const clearSupersededDeviceId = async (
  statePath: string,
): Promise<void> => {
  const recordPath = getDeviceRecordPath(statePath);
  try {
    const raw = await fs.readFile(recordPath, "utf-8");
    const parsed = JSON.parse(raw) as DeviceRecord;
    if (!parsed.supersededDeviceId) {
      return;
    }
    const { supersededDeviceId: _dropped, ...rest } = parsed;
    await writePrivateFile(recordPath, JSON.stringify(rest, null, 2));
  } catch {
    // Nothing to clear; the next successful claim will be a no-op anyway.
  }
};
