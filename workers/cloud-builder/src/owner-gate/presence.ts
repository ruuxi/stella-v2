import {
  DEVICE_PRESENCE_PROOF_PREFIX,
  type DeviceAvailability,
  type ExecutionCapability,
} from "@stella/contracts/turn-plane/placement";
import type { DevicePresenceState } from "../dispatch-policy.js";
import { isRecord } from "./support.js";

/** Device presence: socket attachments, proof of key, and availability. */
/**
 * Everything a presence socket needs to be understood after a hibernation
 * eviction. There is deliberately no in-memory socket map: `getWebSockets()`
 * plus `deserializeAttachment()` is the only thing that survives eviction.
 */
export type PresenceAttachment = {
  v: 1;
  deviceId: string;
  authExpiresAtMs: number;
  connectionId: string;
  nonce: string;
  presenceSessionId?: string;
  availability?: DeviceAvailability;
  phase: "challenged" | "begun" | "connected";
  lastSeenAtMs: number;
};

export const presenceTag = (deviceId: string): string => `device:${deviceId}`;

/** The exact bytes a device signs to prove it holds the registered key. */
export const devicePresenceProofMessage = (args: {
  connectionId: string;
  nonce: string;
}): string =>
  `${DEVICE_PRESENCE_PROOF_PREFIX}\0${args.connectionId}\0${args.nonce}`;

const decodeBase64 = (value: string): Uint8Array | null => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const exactBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;

/**
 * Ed25519 over the SPKI public key the owner snapshot registered. Any failure
 * — malformed material, unknown curve, bad signature — is one answer: the
 * proof is rejected. Telling them apart would only help an attacker.
 */
export const verifyDevicePresenceProof = async (args: {
  publicKey: string;
  message: string;
  signature: string;
}): Promise<boolean> => {
  const publicKeyBytes = decodeBase64(args.publicKey);
  const signatureBytes = decodeBase64(args.signature);
  if (
    !publicKeyBytes ||
    !signatureBytes ||
    publicKeyBytes.byteLength > 256 ||
    signatureBytes.byteLength !== 64
  ) {
    return false;
  }
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      exactBuffer(publicKeyBytes),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      exactBuffer(signatureBytes),
      new TextEncoder().encode(args.message),
    );
  } catch {
    return false;
  }
};

const CAPABILITY_VALUES: readonly ExecutionCapability[] = [
  "chat",
  "agent",
  "computer-use",
  "local-files",
  "local-apps",
  "attachments",
];

export const withReleasedClientSelectability = (
  availability: DeviceAvailability,
) => {
  const selectable = availability.ready ? 1 : 0;
  return { ...availability, chatSlots: selectable, agentSlots: selectable };
};

export const parseAvailability = (
  value: unknown,
): DeviceAvailability | null => {
  if (!isRecord(value)) return null;
  if (typeof value.ready !== "boolean") return null;
  if (!Array.isArray(value.capabilities) || value.capabilities.length > 16) {
    return null;
  }
  const capabilities: ExecutionCapability[] = [];
  for (const capability of value.capabilities) {
    if (!CAPABILITY_VALUES.includes(capability as ExecutionCapability)) {
      return null;
    }
    if (!capabilities.includes(capability as ExecutionCapability)) {
      capabilities.push(capability as ExecutionCapability);
    }
  }
  return {
    ready: value.ready,
    capabilities,
  };
};

export type PresenceRow = {
  device_id: string;
  presence_session_id: string;
  connection_id: string;
  connected: number;
  ready: number;
  capabilities: string;
  protocol_version: number;
  last_seen_at: number;
};

export const presenceState = (row: PresenceRow): DevicePresenceState => ({
  deviceId: row.device_id,
  presenceSessionId: row.presence_session_id,
  connected: row.connected === 1,
  ready: row.ready === 1,
  capabilities: JSON.parse(row.capabilities) as ExecutionCapability[],
  protocolVersion: row.protocol_version,
  lastSeenAt: row.last_seen_at,
});
