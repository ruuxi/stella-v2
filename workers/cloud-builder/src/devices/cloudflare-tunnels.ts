/**
 * The Cloudflare API calls behind a desktop's phone-bridge tunnel: a named
 * cloudflared tunnel plus a proxied CNAME under the tunnel domain. Names are
 * a hash of the owner and device, so they never collide across owners and a
 * cleanup can only ever touch the caller's own tunnel.
 */

const CF_API = "https://api.cloudflare.com/client/v4";
const TUNNEL_DOMAIN = "stellatunnel.com";
const CF_TIMEOUT_MS = 30_000;

export type TunnelCredentials = { apiToken: string; accountId: string; zoneId: string };

export class TunnelConfigError extends Error {}

export const tunnelCredentials = (env: Cloudflare.Env): TunnelCredentials => {
  const values = env as unknown as Record<string, unknown>;
  const read = (name: string) => {
    const value = values[name];
    if (typeof value !== "string" || !value.trim()) {
      throw new TunnelConfigError(`Tunnel secret ${name} is not configured.`);
    }
    return value.trim();
  };
  return {
    apiToken: read("CLOUDFLARE_API_TOKEN"),
    accountId: read("CF_ACCOUNT_ID"),
    zoneId: read("CF_ZONE_ID"),
  };
};

/** `t-<20 hex of sha256(owner, device)>` and its hostname. */
export const tunnelNames = async (ownerId: string, deviceId: string) => {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`stella-tunnel-v1\0${ownerId}\0${deviceId}`),
    ),
  );
  const name = `t-${[...digest.slice(0, 10)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  return { tunnelName: name, hostname: `${name}.${TUNNEL_DOMAIN}` };
};

type CfBody<T> = { success?: boolean; result?: T; errors?: Array<{ message?: string; code?: number }> };

const cf = async <T>(
  credentials: TunnelCredentials,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: CfBody<T> | null }> => {
  const response = await fetch(`${CF_API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${credentials.apiToken}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(CF_TIMEOUT_MS),
  });
  return { status: response.status, body: (await response.json().catch(() => null)) as CfBody<T> | null };
};

const failure = (body: CfBody<unknown> | null, fallback: string) =>
  new Error(body?.errors?.[0]?.message ?? fallback);

export const createTunnel = async (
  credentials: TunnelCredentials,
  tunnelName: string,
): Promise<{ tunnelId: string; tunnelToken: string }> => {
  const secret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  const { status, body } = await cf<{ id: string; token: string }>(
    credentials,
    "POST",
    `/accounts/${credentials.accountId}/cfd_tunnel`,
    { name: tunnelName, tunnel_secret: secret },
  );
  if (status >= 300 || !body?.result) throw failure(body, "Failed to create tunnel.");
  return { tunnelId: body.result.id, tunnelToken: body.result.token };
};

const cnameTarget = (tunnelId: string) => `${tunnelId}.cfargotunnel.com`;

/** Create or repoint the hostname's proxied CNAME at the tunnel. */
export const writeTunnelDns = async (
  credentials: TunnelCredentials,
  input: { tunnelName: string; tunnelId: string; recordId?: string },
): Promise<string> => {
  const { status, body } = await cf<{ id: string }>(
    credentials,
    input.recordId ? "PATCH" : "POST",
    `/zones/${credentials.zoneId}/dns_records${input.recordId ? `/${encodeURIComponent(input.recordId)}` : ""}`,
    { type: "CNAME", name: input.tunnelName, content: cnameTarget(input.tunnelId), proxied: true },
  );
  if (status >= 300 || !body?.result) throw failure(body, "Failed to write the tunnel DNS record.");
  return body.result.id;
};

/** Whether the tunnel still exists remotely. Throws when Cloudflare cannot say. */
export const tunnelExists = async (credentials: TunnelCredentials, tunnelId: string): Promise<boolean> => {
  const { status, body } = await cf<{ deleted_at?: string | null }>(
    credentials,
    "GET",
    `/accounts/${credentials.accountId}/cfd_tunnel/${encodeURIComponent(tunnelId)}`,
  );
  if (status === 404) return false;
  if (status >= 300 || !body?.result) throw failure(body, "Failed to read the tunnel.");
  return !body.result.deleted_at;
};

/**
 * Repair the hostname's DNS for a live tunnel: returns the record id and
 * whether it had to be rewritten.
 */
export const repairTunnelDns = async (
  credentials: TunnelCredentials,
  input: { tunnelName: string; hostname: string; tunnelId: string },
): Promise<{ recordId: string; repaired: boolean }> => {
  const { status, body } = await cf<Array<{ id: string; content: string; proxied: boolean }>>(
    credentials,
    "GET",
    `/zones/${credentials.zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(input.hostname)}`,
  );
  if (status >= 300 || !body?.result) throw failure(body, "Failed to read the tunnel DNS record.");
  const target = cnameTarget(input.tunnelId).toLowerCase();
  const matching = body.result.find((record) => record.content.toLowerCase() === target);
  if (matching?.proxied) return { recordId: matching.id, repaired: false };
  const stale = matching ?? body.result[0];
  return {
    recordId: await writeTunnelDns(credentials, {
      tunnelName: input.tunnelName,
      tunnelId: input.tunnelId,
      ...(stale ? { recordId: stale.id } : {}),
    }),
    repaired: true,
  };
};

/**
 * Delete the tunnel and its DNS by id and by name, so a create whose
 * response was lost is cleaned up too. Missing resources are fine.
 */
export const deleteTunnel = async (
  credentials: TunnelCredentials,
  input: { tunnelName: string; hostname: string; tunnelId?: string | null; dnsRecordId?: string | null },
): Promise<void> => {
  const [dns, tunnels] = await Promise.all([
    cf<Array<{ id: string }>>(
      credentials,
      "GET",
      `/zones/${credentials.zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(input.hostname)}`,
    ),
    cf<Array<{ id: string }>>(
      credentials,
      "GET",
      `/accounts/${credentials.accountId}/cfd_tunnel?is_deleted=false&name=${encodeURIComponent(input.tunnelName)}`,
    ),
  ]);
  const dnsIds = new Set([...(dns.body?.result ?? []).map((record) => record.id), ...(input.dnsRecordId ? [input.dnsRecordId] : [])]);
  const tunnelIds = new Set([...(tunnels.body?.result ?? []).map((tunnel) => tunnel.id), ...(input.tunnelId ? [input.tunnelId] : [])]);
  const results = await Promise.all([
    ...[...dnsIds].map((id) => cf(credentials, "DELETE", `/zones/${credentials.zoneId}/dns_records/${encodeURIComponent(id)}`)),
    ...[...tunnelIds].map((id) =>
      cf(credentials, "DELETE", `/accounts/${credentials.accountId}/cfd_tunnel/${encodeURIComponent(id)}`),
    ),
  ]);
  const failed = results.find((result) => result.status >= 300 && result.status !== 404);
  if (failed) throw failure(failed.body, "Failed to delete the tunnel.");
};
