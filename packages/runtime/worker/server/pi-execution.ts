/**
 * Where a cloud-stored conversation's tools run when they leave this
 * computer (`@stella/agent/host/desktop-execution`): another of the owner's
 * computers, through the owner gate, or a cloud container the conversation's
 * object holds for it. Both are reached over HTTP with the user's sign-in,
 * so the gate's consent checks apply to every call as they do to the cloud's.
 */
import type { DesktopExecutionRemote } from "@stella/agent/host/desktop-execution";
import {
  DEVICE_TOOL_RUN_TIMEOUT_MS,
  type DeviceToolOutcome,
  type DeviceToolResult,
} from "@stella/contracts/turn-plane/device-tools";
import { DEVICES_PATH, type DevicesResponse } from "@stella/contracts/turn-plane/placement";
import type { OpenSession } from "./sessions.js";

const LIST_TIMEOUT_MS = 15_000;
const RELEASE_TIMEOUT_MS = 60_000;

const failureMessage = async (response: Response, what: string): Promise<string> => {
  const body = (await response.json().catch(() => null)) as { error?: unknown; message?: unknown } | null;
  const error = body?.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  if (typeof body?.message === "string") return body.message;
  return `${what} failed (${response.status}).`;
};

export const executionRemoteFor = (
  session: OpenSession,
  conversationId: string,
): DesktopExecutionRemote | undefined => {
  // A conversation kept on this computer runs its tools here only.
  if (conversationId.startsWith("local_")) return undefined;
  const signedIn = () => {
    const auth = session.runnerCell.get()?.getStellaSiteAuth();
    if (!auth) throw new Error("Sign in to Stella to run tools away from this computer.");
    return { base: auth.baseUrl.replace(/\/+$/, ""), token: auth.authToken };
  };
  const post = async (path: string, body: unknown, signal: AbortSignal): Promise<Response> => {
    const { base, token } = signedIn();
    return await fetch(`${base}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  };
  const workspacePath = `/conversations/${encodeURIComponent(conversationId)}/pi-workspace`;
  return {
    devices: async () => {
      const { base, token } = signedIn();
      const response = await fetch(`${base}${DEVICES_PATH}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(await failureMessage(response, "Listing your computers"));
      return ((await response.json()) as DevicesResponse).devices ?? [];
    },
    deviceTool: async (deviceId, requestId, call, signal) => {
      const path = `${DEVICES_PATH}/${encodeURIComponent(deviceId)}/tool-calls`;
      const timeout = AbortSignal.timeout(DEVICE_TOOL_RUN_TIMEOUT_MS + 60_000);
      const stop = () => {
        // The computer stops the call too, not only this wait.
        void post(`${path}/cancel`, { requestId }, AbortSignal.timeout(LIST_TIMEOUT_MS)).catch(() => undefined);
      };
      signal?.addEventListener("abort", stop, { once: true });
      try {
        const response = await post(path, { requestId, call }, signal ? AbortSignal.any([signal, timeout]) : timeout);
        if (!response.ok) {
          return { ok: false, code: "failed", message: await failureMessage(response, "The call") } satisfies DeviceToolOutcome;
        }
        return (await response.json()) as DeviceToolOutcome;
      } finally {
        signal?.removeEventListener("abort", stop);
      }
    },
    cloudTool: async (call, signal) => {
      const timeout = AbortSignal.timeout(DEVICE_TOOL_RUN_TIMEOUT_MS + 60_000);
      const response = await post(
        workspacePath,
        { op: "call", ...call },
        signal ? AbortSignal.any([signal, timeout]) : timeout,
      );
      if (!response.ok) throw new Error(await failureMessage(response, "The cloud workspace"));
      return ((await response.json()) as { result: DeviceToolResult }).result;
    },
    releaseCloud: async (scope) => {
      const response = await post(workspacePath, { op: "release", scope }, AbortSignal.timeout(RELEASE_TIMEOUT_MS));
      if (!response.ok) throw new Error(await failureMessage(response, "Releasing the cloud workspace"));
    },
  };
};
