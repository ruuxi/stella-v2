/**
 * The owner's devices, served from the owner's object: desktops that can run
 * work (their signing keys, capabilities and remote-execution consent), phones
 * attached to a desktop, and push tokens. Phones reach the same data over
 * `/api/mobile/*` on the backend worker.
 *
 * Only machines running Stella's runtime host register here. Phones and
 * browser sessions are places the owner chats from; they appear as attached
 * phones and push tokens, never as execution devices, which is why the device
 * list cannot fill up with browsers.
 */

import type { DeviceRemoteExecution } from "../turn-plane/placement.js";

export type ExecutionCapability =
  | "chat"
  | "agent"
  | "computer-use"
  | "local-files"
  | "local-apps"
  | "attachments";

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
  /**
   * Bind (or rotate) the key a desktop signs its presence proof with.
   *
   * Registering is how a signed-in computer becomes listed, and that is all it
   * is: a device new to this account comes back `"unconfigured"`, and a device
   * that already consented keeps the answer it had. Re-registering on every
   * launch must never re-ask, and must never silently re-enlist a machine the
   * owner declined.
   */
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
      remoteExecution: DeviceRemoteExecution;
      rotated: boolean;
    };
  };
  /**
   * Answer the "accept work from your other devices?" question for a device.
   *
   * The same call serves both ways in: the device itself answering the prompt
   * on its own screen, and the owner tapping enable from another signed-in
   * session rather than waiting for that prompt. The second one means account
   * access alone is enough to enlist a machine, which is deliberate — but it
   * is still a decision someone made, never a side effect of signing in.
   */
  "devices.setRemoteExecution": {
    args: { deviceId: string; enabled: boolean };
    result: {
      deviceId: string;
      remoteExecution: DeviceRemoteExecution;
      changed: boolean;
    };
  };
  /**
   * Record that something tried to dispatch to a device that has not agreed.
   * Moves it to `asking` so the device's own screen raises the prompt and the
   * device list can say it is waiting on an answer.
   */
  "devices.requestRemoteExecution": {
    args: { deviceId: string };
    result: { deviceId: string; remoteExecution: DeviceRemoteExecution };
  };
  /** Move a retired desktop id's pairings and consent to its successor. */
  "devices.adoptSuccession": {
    args: { previousDeviceId: string; deviceId: string };
    result: {
      ok: true;
      migratedPairings: number;
      /** The successor inherited the retired id's remote-execution consent. */
      migratedRemoteExecution: boolean;
    };
  };
  /** Tell the owner's phones about desktop activity. */
  "phone.notifyActivity": { args: { kind: ActivityNotificationKind }; result: null };
};

export type DeviceViews = Record<never, never>;
