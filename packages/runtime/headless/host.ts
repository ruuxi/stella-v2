import crypto, { generateKeyPairSync } from "node:crypto";
import path from "node:path";
import {
  deviceSignerForIdentity,
  type DeviceIdentity,
} from "../kernel/home/device.js";
import {
  getLocalLlmCredential,
  listLocalLlmCredentials,
} from "../kernel/storage/llm-credentials.js";
import {
  getLocalLlmOAuthApiKey,
  listLocalLlmOAuthCredentials,
} from "../kernel/storage/llm-oauth-credentials.js";
import {
  resolveRuntimeStatePath,
  resolveStellaAppDir,
} from "../kernel/home/stella-paths.js";

/**
 * Headless host for the runtime kernel: everything a host must provide to
 * boot the worker and run turns, with no Electron and no desktop shell.
 *
 * What a host actually owes the worker (see `registerHostHandlers` in
 * `runtime/host/index.js`):
 *   - device identity                      -> EPHEMERAL. The durable
 *     `device.json` private key is encrypted with the OS keychain via
 *     Electron safeStorage, so a headless host can neither reuse it nor
 *     safely rotate it (rotation would supersede the desktop's paired
 *     device id). A per-process ed25519 identity keeps the worker happy
 *     without touching the desktop's identity.
 *   - LLM credential brokering             -> desktop decrypts BYOK values
 *     via safeStorage; headless cannot, so we advertise no local BYOK
 *     credentials and the model runtime falls back to env API keys, engine
 *     CLIs (Claude Code / Codex), and the Stella-managed relay when an
 *     auth token is provided by the caller.
 *   - UI affordances (display updates, notifications, windows, connect
 *     cards, permission prompts)           -> no-ops / "unsupported"
 *   - auth refresh                          -> identity stays an input; we
 *     return whatever token the caller handed us and never mint tokens.
 */
export type HeadlessAuthInput = {
  /** Convex auth token minted elsewhere (desktop session, CI secret, ...). */
  authToken?: string | null;
};

export type HeadlessHostPaths = {
  stellaAppDir: string;
  stellaDataDirPath: string;
  stellaWorkspacePath: string;
};

export const resolveHeadlessHostPaths = (options?: {
  stellaAppDir?: string;
  stellaDataDirPath?: string;
}): HeadlessHostPaths => {
  const stellaAppDir = resolveStellaAppDir(undefined, options?.stellaAppDir);
  const stellaDataDirPath = resolveRuntimeStatePath(
    undefined,
    stellaAppDir,
    options?.stellaDataDirPath,
  );
  return {
    stellaAppDir,
    stellaDataDirPath,
    stellaWorkspacePath: path.join(stellaDataDirPath, "workspace"),
  };
};

const createEphemeralDeviceIdentity = (): DeviceIdentity => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    deviceId: `headless-${crypto.randomUUID()}`,
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKey: privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
  };
};

export const createHeadlessHostHandlers = (
  paths: HeadlessHostPaths,
  auth: HeadlessAuthInput = {},
) => {
  const identity = createEphemeralDeviceIdentity();
  const signer = deviceSignerForIdentity(identity);
  const publicIdentity = () => ({
    deviceId: identity.deviceId,
    publicKey: identity.publicKey,
  });
  return {
    getDeviceIdentity: async () => publicIdentity(),
    signDeviceInput: async (input: string) => ({
      alg: signer.alg,
      rawPublicKey: Array.from(signer.rawPublicKey),
      signature: await signer.sign(input),
    }),
    requestRuntimeAuthRefresh: async () => {
      const token = auth.authToken?.trim() || null;
      return {
        authenticated: Boolean(token),
        token,
        hasConnectedAccount: false,
      };
    },
    // Credential presence (provider names) is plain metadata and drives
    // route eligibility — report it truthfully. The stored VALUES are
    // encrypted with the OS keychain via Electron safeStorage, which a
    // headless host cannot decrypt: value reads fall back to null, so
    // engine-CLI routes (Claude Code / Codex manage their own auth) work
    // while raw BYOK API-key routes fail at call time with an accurate
    // missing-key error.
    requestLlmCredentials: async (request: {
      operation: string;
      kind?: "api-key" | "oauth-api-key";
      provider?: string;
    }) => {
      if (request.operation === "list") {
        return {
          ok: true as const,
          apiKeyProviders: listLocalLlmCredentials(
            paths.stellaDataDirPath,
          ).map(({ provider }) => provider),
          oauthProviders: listLocalLlmOAuthCredentials(
            paths.stellaDataDirPath,
          ).map(({ provider }) => provider),
        };
      }
      try {
        const value =
          request.kind === "api-key"
            ? getLocalLlmCredential(
                paths.stellaDataDirPath,
                request.provider ?? "",
              )
            : await getLocalLlmOAuthApiKey(
                paths.stellaDataDirPath,
                request.provider ?? "",
              );
        return { ok: true as const, value };
      } catch {
        // Value is protected-storage-encrypted; headless cannot decrypt it.
        return { ok: true as const, value: null };
      }
    },
    // Matches the desktop's no-window behavior (CredentialService throws
    // when there is no window to collect a secret in).
    requestCredential: async () => {
      throw new Error("Headless host has no UI to collect credentials.");
    },
    displayUpdate: () => {},
    showNotification: async () => {},
  };
};
