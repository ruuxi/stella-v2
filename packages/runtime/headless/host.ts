import crypto, { generateKeyPairSync } from "node:crypto";
import path from "node:path";
import { signDeviceHeartbeat, type DeviceIdentity } from "../kernel/home/device.js";
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

export type HeadlessAuthInput = {

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
  const publicIdentity = () => ({
    deviceId: identity.deviceId,
    publicKey: identity.publicKey,
  });
  return {
    getDeviceIdentity: async () => publicIdentity(),
    signHeartbeatPayload: async (signedAtMs: number) => ({
      publicKey: identity.publicKey,
      signature: signDeviceHeartbeat(identity, signedAtMs),
    }),
    requestRuntimeAuthRefresh: async () => {
      const token = auth.authToken?.trim() || null;
      return {
        authenticated: Boolean(token),
        token,
        hasConnectedAccount: false,
      };
    },

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

        return { ok: true as const, value: null };
      }
    },

    requestCredential: async () => {
      throw new Error("Headless host has no UI to collect credentials.");
    },
    displayUpdate: () => {},
    showNotification: async () => {},
  };
};
