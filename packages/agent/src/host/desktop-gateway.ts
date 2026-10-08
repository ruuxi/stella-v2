/**
 * The desktop's lane to the model gateway: the Better Auth JWT is exchanged
 * for a session capability bound to this device's ed25519 key, and every
 * relay request proves possession of that key (DPoP). This is the transport
 * Stella's current routes use (`model-routing-stella.ts`), handed to the
 * `stella` provider as its `StellaGatewayAccess`.
 */
import {
  GATEWAY_REQUEST_ID_HEADER,
  GATEWAY_RESOLVE_PATH,
  gatewayRelayBaseUrl,
  type GatewayModelResolution,
} from "@stella/contracts/gateway/api";
import {
  STELLA_GATEWAY_DEVICE_VERIFICATION_MESSAGE,
  createGatewaySessionClient,
  dpopHeadersForSessionCapability,
} from "@stella/runtime/kernel/gateway-session";
import type { DeviceSigner } from "@stella/runtime/kernel/home/device";
import type { StellaAgentType, StellaGatewayAccess, StellaModelSpec } from "../provider/stella.ts";

export type DesktopGatewayOptions = {
  gatewayOrigin: string;
  getAuthToken(): Promise<string | undefined> | string | undefined;
  refreshAuthToken?(): Promise<string | undefined> | string | undefined;
  getDeviceSigner(): Promise<DeviceSigner> | DeviceSigner;
};

const errorCode = async (response: Response): Promise<unknown> => {
  try {
    const payload = (await response.clone().json()) as { error?: { code?: unknown } };
    return payload?.error?.code;
  } catch {
    return undefined;
  }
};

/** 402 budget or 429 request-limit on this capability: one fresh exchange is allowed. */
const capabilityExhausted = async (response: Response): Promise<boolean> => {
  if (response.status !== 402 && response.status !== 429) return false;
  const code = await errorCode(response);
  return (response.status === 402 && code === "budget_exhausted") || (response.status === 429 && code === "request_limit");
};

const dpopInvalid = async (response: Response): Promise<boolean> =>
  (response.status === 400 || response.status === 401) && (await errorCode(response)) === "dpop_invalid";

export function desktopGatewayAccess(options: DesktopGatewayOptions): StellaGatewayAccess {
  const session = createGatewaySessionClient({
    gatewayOrigin: () => options.gatewayOrigin,
    getAuthToken: options.getAuthToken,
    ...(options.refreshAuthToken ? { refreshAuthToken: options.refreshAuthToken } : {}),
    getDeviceSigner: options.getDeviceSigner,
  });

  const send = async (request: Request, body: ArrayBuffer | undefined, capability: string): Promise<Response> => {
    const headers = new Headers(request.headers);
    const requestId = headers.get(GATEWAY_REQUEST_ID_HEADER)?.trim() || crypto.randomUUID();
    headers.set("authorization", `Bearer ${capability}`);
    headers.set(GATEWAY_REQUEST_ID_HEADER, requestId);
    const proof = await dpopHeadersForSessionCapability({
      signer: await session.getDeviceSigner(),
      capability,
      method: request.method,
      pathname: new URL(request.url).pathname,
      requestId,
      now: Date.now(),
    });
    for (const [name, value] of Object.entries(proof)) headers.set(name, value);
    const response = await fetch(request.url, { method: request.method, headers, body, signal: request.signal });
    if (await dpopInvalid(response)) throw new Error(STELLA_GATEWAY_DEVICE_VERIFICATION_MESSAGE);
    return response;
  };

  const relayFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
    const bearer = request.headers.get("authorization")?.replace(/^bearer\s+/i, "").trim();
    const capability = bearer || (await session.getCapability());
    if (!capability) throw new Error("Stella is not signed in.");
    const response = await send(request, body, capability);
    if (!(await capabilityExhausted(response)) && response.status !== 401) return response;
    const fresh = (await session.refreshCapability())?.trim();
    if (!fresh) return response;
    return send(request, body, fresh);
  };

  return {
    relayBaseUrl: gatewayRelayBaseUrl(options.gatewayOrigin),
    capability: async () => {
      const capability = await session.getCapability();
      if (!capability) throw new Error("Stella is not signed in.");
      return capability;
    },
    fetch: relayFetch as typeof fetch,
  };
}

/** Ask the gateway how it serves `alias` for each agent type. */
export async function resolveStellaModels(
  access: StellaGatewayAccess,
  gatewayOrigin: string,
  alias: string,
  agentTypes: readonly StellaAgentType[],
): Promise<StellaModelSpec[]> {
  return Promise.all(
    agentTypes.map(async (agentType) => {
      const response = await access.fetch(`${gatewayOrigin.replace(/\/+$/, "")}${GATEWAY_RESOLVE_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ model: alias, agentType }),
      });
      if (!response.ok) {
        throw new Error(`Stella gateway could not resolve ${alias} for ${agentType}: ${response.status} ${await response.text()}`);
      }
      const resolution = (await response.json()) as GatewayModelResolution;
      return {
        agentType,
        alias,
        protocol: resolution.protocol,
        reasoning: resolution.reasoning,
        supportsImages: resolution.supportsImages,
        ...(resolution.contextWindow !== undefined ? { contextWindow: resolution.contextWindow } : {}),
        ...(resolution.maxOutputTokens !== undefined ? { maxOutputTokens: resolution.maxOutputTokens } : {}),
      } satisfies StellaModelSpec;
    }),
  );
}
