import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { assert, assertObject } from "./assert";
import {
  createBridgeProofChallenge,
  createMobileBridgePairProof,
} from "./bridge-crypto";
import { getJson, postJson } from "./http";
import type { DesktopBridgeStatus } from "../types";
import { readDesktopBridgeRegistrationDescriptor } from "./desktop-bridge-discovery";

const MOBILE_DEVICE_ID_KEY = "stella-mobile_phone-access.mobile-device-id";
const PREFERRED_DESKTOP_DEVICE_ID_KEY =
  "stella-mobile_phone-access.preferred-desktop-device-id";

const PAIRED_DESKTOP_IDS_KEY = "stella-mobile_phone-access.paired-desktop-ids";
const DESKTOP_ACCESS_KEY_PREFIX = "stella-mobile_phone-access.desktop.";

export type StoredPhoneAccess = {
  desktopDeviceId: string;
  mobileDeviceId: string;
  pairSecret: string;
  approvedAt: number;
};

const desktopAccessKey = (desktopDeviceId: string) =>
  `${DESKTOP_ACCESS_KEY_PREFIX}${desktopDeviceId}`;

const readPairedDesktopIds = async (): Promise<string[]> => {
  const raw = await SecureStore.getItemAsync(PAIRED_DESKTOP_IDS_KEY);
  if (!raw?.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    const ids = parsed.filter(
      (x): x is string => typeof x === "string" && x.trim().length > 0,
    );
    return [...new Set(ids)];
  } catch {
    return [];
  }
};

const writePairedDesktopIds = async (ids: string[]) => {
  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  if (unique.length === 0) {
    await SecureStore.deleteItemAsync(PAIRED_DESKTOP_IDS_KEY);
    return;
  }
  await SecureStore.setItemAsync(
    PAIRED_DESKTOP_IDS_KEY,
    JSON.stringify(unique),
  );
};

const createMobileDeviceId = () => {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) {
    return randomUuid;
  }
  return `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
};

const readStoredPhoneAccess = (
  value: string | null,
): StoredPhoneAccess | null => {
  if (!value) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  if (
    typeof record.desktopDeviceId !== "string" ||
    typeof record.mobileDeviceId !== "string" ||
    typeof record.pairSecret !== "string" ||
    typeof record.approvedAt !== "number"
  ) {
    return null;
  }

  return {
    desktopDeviceId: record.desktopDeviceId,
    mobileDeviceId: record.mobileDeviceId,
    pairSecret: record.pairSecret,
    approvedAt: record.approvedAt,
  };
};

const readPairingResult = (
  value: unknown,
): { desktopDeviceId: string; approvedAt: number; pairSecret: string } => {
  assertObject(value, "Pairing response must be an object.");
  assert(
    typeof value.desktopDeviceId === "string",
    "Pairing response is missing the desktop id.",
  );
  assert(
    typeof value.approvedAt === "number",
    "Pairing response is missing the approval time.",
  );
  assert(
    typeof value.pairSecret === "string",
    "Pairing response is missing the phone credential.",
  );
  return {
    desktopDeviceId: value.desktopDeviceId,
    approvedAt: value.approvedAt,
    pairSecret: value.pairSecret,
  };
};

function readDesktopBridgeStatus(value: unknown): DesktopBridgeStatus {
  assertObject(value, "Desktop bridge response must be an object.");
  assert(
    typeof value.available === "boolean",
    "Desktop bridge availability is required.",
  );
  assert(
    Array.isArray(value.baseUrls),
    "Desktop bridge URLs must be an array.",
  );
  for (const item of value.baseUrls) {
    assert(typeof item === "string", "Desktop bridge URL must be a string.");
  }
  assert(
    value.platform === undefined ||
      value.platform === null ||
      typeof value.platform === "string",
    "Desktop bridge platform must be a string.",
  );
  assert(
    value.updatedAt === undefined ||
      value.updatedAt === null ||
      typeof value.updatedAt === "number",
    "Desktop bridge updatedAt must be a number.",
  );
  return {
    available: value.available,
    baseUrls: value.baseUrls,
    platform: value.platform ?? null,
    updatedAt: value.updatedAt ?? null,
    lastKnownRegistration: readDesktopBridgeRegistrationDescriptor(
      value.lastKnownRegistration,
    ),
  };
}

const readPlatformLabel = () => {
  switch (Platform.OS) {
    case "ios":
      return "iPhone";
    case "android":
      return "Android";
    default:
      return "Phone";
  }
};

export const buildPhonePairProofHeaders = (
  access: StoredPhoneAccess,
  challenge: string,
  mobilePublicKey?: string,
) => {
  const { issuedAt, proof } = createMobileBridgePairProof({
    pairSecret: access.pairSecret,
    desktopDeviceId: access.desktopDeviceId,
    mobileDeviceId: access.mobileDeviceId,
    challenge,
    mobilePublicKey,
  });
  return {
    "X-Stella-Mobile-Device-Id": access.mobileDeviceId,
    "X-Stella-Mobile-Pair-Proof": proof,
    "X-Stella-Mobile-Pair-Proof-Issued-At": String(issuedAt),
    "X-Stella-Mobile-Pair-Proof-Challenge": challenge,
    ...(mobilePublicKey
      ? { "X-Stella-Mobile-Public-Key": mobilePublicKey }
      : {}),
  };
};

export async function getOrCreateMobileDeviceId() {
  const existing = await SecureStore.getItemAsync(MOBILE_DEVICE_ID_KEY);
  if (existing?.trim()) {
    return existing.trim();
  }

  const nextId = createMobileDeviceId();
  await SecureStore.setItemAsync(MOBILE_DEVICE_ID_KEY, nextId);
  return nextId;
}

export async function getPreferredPhoneAccess() {
  const preferredDesktopDeviceId = await SecureStore.getItemAsync(
    PREFERRED_DESKTOP_DEVICE_ID_KEY,
  );
  if (!preferredDesktopDeviceId?.trim()) {
    return null;
  }

  const stored = await SecureStore.getItemAsync(
    desktopAccessKey(preferredDesktopDeviceId.trim()),
  );
  return readStoredPhoneAccess(stored);
}

export async function listStoredPairedPhoneAccess(): Promise<
  StoredPhoneAccess[]
> {
  let ids = await readPairedDesktopIds();
  if (ids.length === 0) {
    const fallback = await getPreferredPhoneAccess();
    if (fallback) {
      await writePairedDesktopIds([fallback.desktopDeviceId]);
      ids = [fallback.desktopDeviceId];
    }
  }
  const out: StoredPhoneAccess[] = [];
  for (const id of ids) {
    const raw = await SecureStore.getItemAsync(desktopAccessKey(id));
    const access = readStoredPhoneAccess(raw);
    if (access) {
      out.push(access);
    }
  }
  return out;
}

export async function setPreferredDesktopDeviceId(desktopDeviceId: string) {
  const trimmed = desktopDeviceId.trim();
  if (!trimmed) {
    return;
  }
  const ids = await readPairedDesktopIds();
  if (!ids.includes(trimmed)) {
    return;
  }
  await SecureStore.setItemAsync(PREFERRED_DESKTOP_DEVICE_ID_KEY, trimmed);
}

export async function clearStoredPhoneAccess(desktopDeviceId: string) {
  const key = desktopAccessKey(desktopDeviceId);
  await SecureStore.deleteItemAsync(key);

  const ids = await readPairedDesktopIds();
  const next = ids.filter((id) => id !== desktopDeviceId);
  await writePairedDesktopIds(next);

  const preferredDesktopDeviceId = await SecureStore.getItemAsync(
    PREFERRED_DESKTOP_DEVICE_ID_KEY,
  );
  if (preferredDesktopDeviceId?.trim() === desktopDeviceId) {
    await SecureStore.deleteItemAsync(PREFERRED_DESKTOP_DEVICE_ID_KEY);
    if (next.length > 0) {
      await SecureStore.setItemAsync(
        PREFERRED_DESKTOP_DEVICE_ID_KEY,
        next[0] as string,
      );
    }
  }
}

export async function completePhonePairing(args: {
  pairingCode: string;
  displayName?: string;
}) {
  const mobileDeviceId = await getOrCreateMobileDeviceId();
  const result = readPairingResult(
    await postJson("/api/mobile/pairing/complete", {
      pairingCode: args.pairingCode,
      mobileDeviceId,
      ...(args.displayName?.trim()
        ? { displayName: args.displayName.trim().slice(0, 64) }
        : {}),
      platform: readPlatformLabel(),
    }),
  );

  const access: StoredPhoneAccess = {
    desktopDeviceId: result.desktopDeviceId,
    mobileDeviceId,
    pairSecret: result.pairSecret,
    approvedAt: result.approvedAt,
  };

  await SecureStore.setItemAsync(
    desktopAccessKey(result.desktopDeviceId),
    JSON.stringify(access),
  );
  const ids = await readPairedDesktopIds();
  if (!ids.includes(result.desktopDeviceId)) {
    ids.push(result.desktopDeviceId);
  }
  await writePairedDesktopIds(ids);
  await SecureStore.setItemAsync(
    PREFERRED_DESKTOP_DEVICE_ID_KEY,
    result.desktopDeviceId,
  );

  return access;
}

export async function requestDesktopConnection(access: StoredPhoneAccess) {
  const challenge = createBridgeProofChallenge();
  await postJson(
    "/api/mobile/desktop-bridge/request",
    { desktopDeviceId: access.desktopDeviceId },
    { headers: buildPhonePairProofHeaders(access, challenge) },
  );
}

export async function adoptDesktopDeviceIdSuccession(
  previousDesktopDeviceId: string,
  nextDesktopDeviceId: string,
) {
  const previous = previousDesktopDeviceId.trim();
  const next = nextDesktopDeviceId.trim();
  if (!previous || !next || previous === next) {
    return null;
  }

  const stored = readStoredPhoneAccess(
    await SecureStore.getItemAsync(desktopAccessKey(previous)),
  );
  if (!stored) {
    return null;
  }

  const migrated: StoredPhoneAccess = { ...stored, desktopDeviceId: next };
  await SecureStore.setItemAsync(
    desktopAccessKey(next),
    JSON.stringify(migrated),
  );
  await SecureStore.deleteItemAsync(desktopAccessKey(previous));

  const ids = await readPairedDesktopIds();
  await writePairedDesktopIds([
    ...ids.filter((id) => id !== previous && id !== next),
    next,
  ]);

  const preferred = await SecureStore.getItemAsync(
    PREFERRED_DESKTOP_DEVICE_ID_KEY,
  );
  if (!preferred?.trim() || preferred.trim() === previous) {
    await SecureStore.setItemAsync(PREFERRED_DESKTOP_DEVICE_ID_KEY, next);
  }

  return migrated;
}

export async function getDesktopBridgeStatus(desktopDeviceId?: string) {
  const query = desktopDeviceId
    ? `?desktopDeviceId=${encodeURIComponent(desktopDeviceId)}`
    : "";
  const status = readDesktopBridgeStatus(
    await getJson(`/api/mobile/desktop-bridge${query}`),
  );

  const resolved = status.lastKnownRegistration?.desktopDeviceId;
  if (desktopDeviceId && resolved && resolved !== desktopDeviceId) {
    await adoptDesktopDeviceIdSuccession(desktopDeviceId, resolved).catch(
      () => null,
    );
  }

  return status;
}
