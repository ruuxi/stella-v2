import { promises as fs } from "fs";
import path from "path";
import { generateKeyPairSync } from "crypto";
import {
  deleteProtectedValue,
  protectValue,
  unprotectValue,
} from "../shared/protected-storage.js";
import { ensurePrivateDir, writePrivateFile } from "../shared/private-fs.js";
import { getFileLogger } from "../../observability/file-logger.js";

type DeviceRecord = {
  deviceId: string;
  publicKey?: string;
  privateKeyProtected?: string;

  supersededDeviceId?: string;
};

export type DeviceIdentity = {
  deviceId: string;
  publicKey: string;
  privateKey: string;

  supersededDeviceId?: string;
};

const DEVICE_FILE = "device.json";
const DEVICE_PRIVATE_KEY_SCOPE = "device-private-key";

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

  if (reason === "no-record" && !supersededDeviceId) {
    return;
  }

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
  ...(identity.supersededDeviceId
    ? { supersededDeviceId: identity.supersededDeviceId }
    : {}),
});

const createAndStoreDeviceIdentity = async (
  recordPath: string,
  previousPrivateKeyProtected?: string,
  supersededDeviceId?: string,
): Promise<DeviceIdentity> => {
  const payload: DeviceIdentity = {
    deviceId: crypto.randomUUID(),
    ...generateDeviceKeyPair(),
    ...(supersededDeviceId ? { supersededDeviceId } : {}),
  };
  const record = toStoredDeviceRecord(payload);
  await ensurePrivateDir(path.dirname(recordPath));
  await writePrivateFile(recordPath, JSON.stringify(record, null, 2));
  if (
    previousPrivateKeyProtected &&
    previousPrivateKeyProtected !== record.privateKeyProtected
  ) {
    deleteProtectedValue(DEVICE_PRIVATE_KEY_SCOPE, previousPrivateKeyProtected);
  }
  return payload;
};

export const getOrCreateDeviceIdentity = async (
  statePath: string,
): Promise<DeviceIdentity> => {
  const recordPath = getDeviceRecordPath(statePath);
  let previousPrivateKeyProtected: string | undefined;

  let supersededDeviceId: string | undefined;
  let reason: DeviceIdentityRegenerationReason = "no-record";

  let raw: string | undefined;
  try {
    raw = await fs.readFile(recordPath, "utf-8");
  } catch (error) {
    reason =
      (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
        ? "no-record"
        : "unreadable-record";
  }

  if (raw !== undefined) {
    let parsed: DeviceRecord | null = null;
    try {
      parsed = JSON.parse(raw) as DeviceRecord;
    } catch {
      reason = "malformed-record";
    }

    if (parsed) {
      previousPrivateKeyProtected = parsed.privateKeyProtected;

      if (parsed.deviceId) {
        supersededDeviceId = parsed.deviceId;
      }

      if (parsed.deviceId && parsed.publicKey && parsed.privateKeyProtected) {
        const decryptedPrivateKey = unprotectValue(
          DEVICE_PRIVATE_KEY_SCOPE,
          parsed.privateKeyProtected,
        );
        if (decryptedPrivateKey) {
          return {
            deviceId: parsed.deviceId,
            publicKey: parsed.publicKey,
            privateKey: decryptedPrivateKey,
            ...(parsed.supersededDeviceId
              ? { supersededDeviceId: parsed.supersededDeviceId }
              : {}),
          };
        }
        reason = "undecryptable-private-key";
      } else {
        reason = "incomplete-record";
      }
    }
  }

  logDeviceIdentityRegeneration(reason, supersededDeviceId);

  return await createAndStoreDeviceIdentity(
    recordPath,
    previousPrivateKeyProtected,
    supersededDeviceId,
  );
};

export const resetDeviceIdentity = async (
  statePath: string,
  options: { preservePairings?: boolean } = {},
): Promise<DeviceIdentity> => {
  const recordPath = getDeviceRecordPath(statePath);
  let previousPrivateKeyProtected: string | undefined;
  let supersededDeviceId: string | undefined;
  try {
    const raw = await fs.readFile(recordPath, "utf-8");
    const parsed = JSON.parse(raw) as DeviceRecord;
    previousPrivateKeyProtected = parsed.privateKeyProtected;

    if (options.preservePairings && parsed.deviceId) {
      supersededDeviceId = parsed.deviceId;
    }
  } catch {

  }
  return await createAndStoreDeviceIdentity(
    recordPath,
    previousPrivateKeyProtected,
    supersededDeviceId,
  );
};

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

  }
};
