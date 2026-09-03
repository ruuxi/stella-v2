/**
 * Whether the desktop host may run the execution-placement bridge.
 *
 * The bridge proves device presence with an Ed25519 signature, but the host
 * never holds the private key: Electron main and the headless host hand the
 * runtime a public-only identity plus a `signDeviceInput` delegate that signs
 * with the same key. Eligibility therefore keys on that delegate. Requiring a
 * `privateKey` field here is exactly the bug that left every "Cloud" and
 * "other computer" send refused with "Cross-device execution is not ready on
 * this computer": no host handler supplies one, so the bridge never started.
 */
export type ExecutionPlacementEligibilityInput = {
  started: boolean;
  hostReady: boolean;
  deviceIdentity:
    | { deviceId?: string | null; publicKey?: string | null }
    | null
    | undefined;
  hasDatabase: boolean;
  hasConnectedAccount: boolean | undefined;
  cloudSyncEnabled: boolean | undefined;
  authToken: string | null;
  convexUrl: string | null;
  canSignDeviceInput: boolean;
};

export const isExecutionPlacementEligible = (
  input: ExecutionPlacementEligibilityInput,
): boolean =>
  Boolean(
    input.started &&
      input.hostReady &&
      input.deviceIdentity?.deviceId &&
      input.deviceIdentity?.publicKey &&
      input.canSignDeviceInput &&
      input.hasDatabase &&
      input.hasConnectedAccount &&
      input.cloudSyncEnabled &&
      input.authToken &&
      input.convexUrl,
  );
