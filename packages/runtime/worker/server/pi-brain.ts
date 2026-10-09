/**
 * Where a cloud-stored conversation's brain runs, for the pi-durable chat on
 * this computer (`@stella/agent/host/desktop-execution`): read from and set
 * on the conversation's object (`@stella/contracts/turn-plane/pi-brain`).
 * Stella's brief continues on the new host through the host's placement, the
 * same hand-off `switch_destination` always made.
 */
import type { DesktopBrain } from "@stella/agent/host/desktop-execution";
import { METHOD_NAMES } from "@stella/contracts/protocol";
import { piBrainPath, type PiBrainRecord, type PiBrainResponse } from "@stella/contracts/turn-plane/pi-brain";
import type * as HostBus from "./host-bus.js";
import type { OpenSession } from "./sessions.js";

const BRAIN_TIMEOUT_MS = 15_000;

export const brainFor = (
  session: OpenSession,
  hostBus: HostBus.Interface,
  conversationId: string,
): DesktopBrain | undefined => {
  // A conversation kept on this computer has its brain here, always.
  if (conversationId.startsWith("local_")) return undefined;
  const call = async (init?: RequestInit): Promise<PiBrainRecord | null> => {
    const auth = session.runnerCell.get()?.getStellaSiteAuth();
    if (!auth) throw new Error("Sign in to Stella to move Stella between this computer and the cloud.");
    const response = await fetch(`${auth.baseUrl.replace(/\/+$/, "")}${piBrainPath(conversationId)}`, {
      ...init,
      headers: { authorization: `Bearer ${auth.authToken}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(BRAIN_TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => null)) as (PiBrainResponse & { error?: string }) | null;
    if (!response.ok || !body) throw new Error(body?.error ?? `Where Stella runs could not be read (${response.status}).`);
    return body.record;
  };
  return {
    read: () => call(),
    set: async (host) => {
      const record = await call({ method: "POST", body: JSON.stringify(host) });
      if (!record) throw new Error("The cloud did not record where Stella runs.");
      return record;
    },
    handOff: async (host, brief) => {
      const result = (await hostBus.request(
        METHOD_NAMES.HOST_EXECUTION_DESTINATION_SWITCH,
        {
          conversationId,
          target: host.host === "cloud" ? { mode: "cloud" } : { mode: "device", deviceId: host.deviceId },
          prompt: brief,
          // Only this conversation moves: the app's destination picker stays as it is.
          brain: true,
        },
        { retryOnDisconnect: true },
      )) as { ok?: boolean; error?: string } | null;
      if (!result?.ok) throw new Error(result?.error ?? "Stella's brief could not be handed on.");
    },
  };
};
