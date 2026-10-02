/**
 * The owner's devices, served from the owner's object: desktops that can run
 * work (their signing keys and capabilities), phones paired to a desktop, the
 * desktop's phone bridge, and push tokens. Phones and the desktop's bridge
 * reach the same data over `/api/mobile/*` on the backend worker.
 */

export type ExecutionCapability =
  | "chat"
  | "agent"
  | "computer-use"
  | "local-files"
  | "local-apps"
  | "attachments";

export type PairedPhone = {
  mobileDeviceId: string;
  displayName?: string;
  platform?: string;
  approvedAt: number;
  lastSeenAt: number;
};

export type PhoneAccessState = {
  /** The desktop's live pairing code, if one is waiting to be used. */
  activePairing: { pairingCode: string; expiresAt: number; createdAt: number } | null;
  pairedDevices: PairedPhone[];
};

export type ConnectIntent = {
  intentId: string;
  mobileDeviceId: string;
  createdAt: number;
  expiresAt: number;
} | null;

export type ActivityNotificationKind = "started" | "completed" | "failed";

export type DeviceCalls = {
  /** Who this desktop is to the backend, after any device-id succession. */
  "devices.identity": {
    args: { deviceId?: string };
    result: {
      ownerId: string;
      ownerGeneration: string;
      deviceId?: string;
      builderOrigin?: string;
    };
  };
  /** Bind (or rotate) the key a desktop signs its presence proof with. */
  "devices.register": {
    args: {
      deviceId: string;
      devicePublicKey: string;
      deviceName?: string;
      platform?: string;
      capabilities?: ExecutionCapability[];
    };
    result: {
      deviceId: string;
      ownerGeneration: string;
      remoteExecutionEnabled: boolean;
      rotated: boolean;
    };
  };
  /** Move a retired desktop id's pairings, bridge and tunnel to its successor. */
  "devices.adoptSuccession": {
    args: { previousDeviceId: string; deviceId: string };
    result: {
      ok: true;
      migratedPairings: number;
      migratedRegistration: boolean;
      migratedTunnel: boolean;
    };
  };
  /** A pairing code a phone signed into the same account can redeem. */
  "phone.createPairing": {
    args: { desktopDeviceId: string };
    result: { pairingCode: string; expiresAt: number; createdAt: number; pairingUrl: string };
  };
  "phone.revoke": {
    args: { desktopDeviceId: string; mobileDeviceId: string };
    result: null;
  };
  "phone.acknowledgeIntent": { args: { intentId: string }; result: null };
  /** Tell the owner's phones about desktop activity. */
  "phone.notifyActivity": { args: { kind: ActivityNotificationKind }; result: null };
};

export type DeviceViews = {
  "phone.access": { args: { desktopDeviceId: string }; result: PhoneAccessState };
  /** The newest unacknowledged request from a paired phone to connect. */
  "phone.connectIntent": { args: { desktopDeviceId: string }; result: ConnectIntent };
};
