import { promises as fs } from "fs";
import path from "path";
import { createPrivateKey, generateKeyPairSync, sign } from "crypto";

import { Effect } from "effect";

import {
  deleteProtectedValue,
  protectValue,
  unprotectValue,
} from "../shared/protected-storage.js";
import { ensurePrivateDir, writePrivateFile } from "../shared/private-fs.js";
import { withHome } from "./home-runtime.js";

type DeviceRecord = {
  deviceId: string;
  publicKey?: string;
  privateKeyProtected?: string;
};

export type DeviceIdentity = {
  deviceId: string;
  publicKey: string;
  privateKey: string;
};

const DEVICE_FILE = "device.json";
const DEVICE_PRIVATE_KEY_SCOPE = "device-private-key";

/** Adapt a leaf Promise IO call, failing with the raw thrown value. */
const tryIO = <A>(f: () => Promise<A>): Effect.Effect<A, unknown> =>
  Effect.tryPromise({ try: f, catch: (error) => error });

export const getDeviceRecordPath = (statePath: string) =>
  path.join(statePath, DEVICE_FILE);

export const getOrCreateDeviceId = async (statePath: string) => {
  const identity = await getOrCreateDeviceIdentity(statePath);
  return identity.deviceId;
};

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
});

const createAndStoreDeviceIdentityEffect = (
  recordPath: string,
  previousPrivateKeyProtected?: string,
): Effect.Effect<DeviceIdentity, unknown> =>
  Effect.gen(function* () {
    const payload = yield* Effect.sync(
      (): DeviceIdentity => ({
        deviceId: crypto.randomUUID(),
        ...generateDeviceKeyPair(),
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
 * Read the persisted device record, or `undefined` on any read/parse error.
 * Captures `privateKeyProtected` even when the rest of the record is
 * unusable, so a re-key can clean up the superseded protected value —
 * exactly the pre-Effect try/catch flow.
 */
const readPersistedDeviceRecord = (
  recordPath: string,
): Effect.Effect<DeviceRecord | undefined> =>
  tryIO(async (): Promise<DeviceRecord> => {
    const raw = await fs.readFile(recordPath, "utf-8");
    return JSON.parse(raw) as DeviceRecord;
  }).pipe(Effect.catch(() => Effect.succeed(undefined)));

export const getOrCreateDeviceIdentityEffect = (
  statePath: string,
): Effect.Effect<DeviceIdentity, unknown> =>
  Effect.gen(function* () {
    const recordPath = getDeviceRecordPath(statePath);
    const parsed = yield* readPersistedDeviceRecord(recordPath);
    const previousPrivateKeyProtected = parsed?.privateKeyProtected;
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
          if (!decryptedPrivateKey) return null;
          return {
            deviceId: parsed.deviceId,
            publicKey: parsed.publicKey,
            privateKey: decryptedPrivateKey,
          };
        }
        return null;
      },
      catch: (error) => error,
    }).pipe(Effect.catch(() => Effect.succeed(null)));
    if (existing) return existing;
    return yield* createAndStoreDeviceIdentityEffect(
      recordPath,
      previousPrivateKeyProtected,
    );
  });

export const getOrCreateDeviceIdentity = (
  statePath: string,
): Promise<DeviceIdentity> =>
  withHome((home) => home.getOrCreateDeviceIdentity(statePath));

export const resetDeviceIdentityEffect = (
  statePath: string,
): Effect.Effect<DeviceIdentity, unknown> =>
  Effect.gen(function* () {
    const recordPath = getDeviceRecordPath(statePath);
    const parsed = yield* readPersistedDeviceRecord(recordPath);
    return yield* createAndStoreDeviceIdentityEffect(
      recordPath,
      parsed?.privateKeyProtected,
    );
  });

export const resetDeviceIdentity = (
  statePath: string,
): Promise<DeviceIdentity> =>
  withHome((home) => home.resetDeviceIdentity(statePath));

export const signDeviceHeartbeat = (
  identity: DeviceIdentity,
  signedAtMs: number,
): string => {
  const privateKey = createPrivateKey({
    key: Buffer.from(identity.privateKey, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const payload = Buffer.from(`${identity.deviceId}:${signedAtMs}`);
  const signature = sign(null, payload, privateKey);
  return signature.toString("base64");
};
