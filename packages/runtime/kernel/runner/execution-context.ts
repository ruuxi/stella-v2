import { hostname } from "node:os";
import {
  createExecutionContextSnapshot,
  readExecutionContextSnapshot,
} from "@stella/contracts/execution-context";
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

/** Runs in the runtime worker, never the renderer. Failed discovery is advisory. */
export const loadDeviceExecutionContext = async (args: {
  deviceId: string;
  baseUrl: string | null;
  authToken: string | null;
  fetchImpl?: typeof fetch;
}) => {
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
