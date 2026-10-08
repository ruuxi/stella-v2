import { hostname } from "node:os";
import type { BackendClient } from "@stella/contracts/backend/client";
import {
  createExecutionContextSnapshot,
  mediaAccessForAudience,
  readExecutionContextSnapshot,
  type ExecutionContextSnapshot,
  type MediaAccess,
} from "@stella/contracts/execution-context";
import { getImageGenerationPreferences } from "../preferences/local-preferences.js";
import { hasAccessibleLocalLlmApiKey } from "../storage/local-llm-credential-access.js";
import { DEVICES_PATH } from "@stella/contracts/turn-plane/placement";

const MAX_CATALOG_BYTES = 128 * 1024;

const readCatalog = async (response: Response): Promise<unknown> => {
  if (Number(response.headers.get("content-length")) > MAX_CATALOG_BYTES) {
    await response.body?.cancel();
    return undefined;
  }
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_CATALOG_BYTES) {
        await reader.cancel();
        return undefined;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    reader.releaseLock();
  }
};

/** The plan's media entitlement, from the backend's billing status; null when it cannot be read. */
const readMediaPlan = async (
  client: BackendClient | null,
): Promise<MediaAccess["stella"] | null> => {
  if (!client) return null;
  return await new Promise((resolve) => {
    let stop: (() => void) | null = null;
    let settled = false;
    const settle = (value: MediaAccess["stella"] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
      // The first value can arrive before `watch` returns.
      queueMicrotask(() => stop?.());
    };
    const timer = setTimeout(() => settle(null), 3_000);
    stop = client.watch(
      "billing.status",
      {},
      (status) => {
        if (!status.authenticated) return settle(null);
        settle(status.isAnonymous ? "sign_in" : mediaAccessForAudience(status.plan));
      },
      () => settle(null),
    );
  });
};

/** What media the user can generate: their plan, and `image_gen`'s own-key setting. */
export const loadMediaAccess = async (args: {
  stellaDataDir: string;
  hasConnectedAccount: boolean;
  client: BackendClient | null;
}): Promise<MediaAccess | undefined> => {
  const stella = args.hasConnectedAccount ? await readMediaPlan(args.client) : "sign_in";
  if (!stella) return undefined;
  const preference = getImageGenerationPreferences(args.stellaDataDir).provider;
  return {
    stella,
    ...(preference !== "stella"
      ? {
          ownImageKey: {
            provider: preference,
            saved: hasAccessibleLocalLlmApiKey(args.stellaDataDir, preference),
          },
        }
      : {}),
  };
};

/** Runs in the runtime worker, never the renderer. Failed discovery is advisory. */
export const loadDeviceExecutionContext = async (args: {
  deviceId: string;
  baseUrl: string | null;
  authToken: string | null;
  fetchImpl?: typeof fetch;
  loadMedia?: () => Promise<MediaAccess | undefined>;
}): Promise<ExecutionContextSnapshot> => {
  const [snapshot, media] = await Promise.all([
    loadDevices(args),
    args.loadMedia?.().catch(() => undefined),
  ]);
  return media ? { ...snapshot, media } : snapshot;
};

const loadDevices = async (args: {
  deviceId: string;
  baseUrl: string | null;
  authToken: string | null;
  fetchImpl?: typeof fetch;
}): Promise<ExecutionContextSnapshot> => {
  const destination = {
    kind: "device",
    deviceId: args.deviceId,
    label: hostname() || args.deviceId,
  } as const;
  if (args.baseUrl && args.authToken) {
    try {
      const response = await (args.fetchImpl ?? fetch)(
        `${args.baseUrl.replace(/\/+$/, "")}${DEVICES_PATH}`,
        {
          headers: { Authorization: `Bearer ${args.authToken}` },
          signal: AbortSignal.timeout(3_000),
        },
      );
      if (response.ok) {
        const body = await readCatalog(response);
        if (body && typeof body === "object" && "devices" in body) {
          const snapshot = readExecutionContextSnapshot({
            executionContext: {
              devices: body.devices,
              destination,
              devicesKnown: true,
            },
          });
          if (snapshot) return snapshot;
        }
      }
    } catch {
      // Offline/signed-out local work must not depend on the device catalog.
    }
  }
  return createExecutionContextSnapshot({ devices: null, destination });
};
