/**
 * Backend Composio connection-status probe.
 *
 * `requestExternalOAuthApproval` can only confirm that the browser was
 * opened with the user's consent — Composio OAuth completes on a hosted
 * page with no deep-link back to the desktop. Before that, the enable
 * paths treated "browser opened" as "connected", so the connect card /
 * Store could report success while the user was still mid-OAuth (or had
 * closed the tab).
 *
 * This module polls the backend's `/api/native-integrations/status`
 * endpoint (which asks Composio whether the user's session actually has
 * a connected account for the toolkit) and only reports `connected`
 * on a real completion signal. Pure + fetch-injectable so it is
 * unit-testable without Electron.
 */

export type BackendIntegrationProbeResult =
  | "connected"
  | "not_connected"
  /** Endpoint missing (older backend deploy) or auth unavailable. */
  | "unsupported"
  | "error";

export type BackendIntegrationWaitResult =
  | "connected"
  | "timeout"
  | "cancelled"
  | "unsupported"
  /**
   * siteUrl/authToken missing — completion cannot be confirmed. Callers
   * must treat this as a failure, never as an optimistic success (only
   * the explicit 404/405 "unsupported" rollout path may degrade).
   */
  | "auth_unavailable";

const readConnected = (payload: unknown): boolean =>
  Boolean(
    payload &&
      typeof payload === "object" &&
      (payload as { connected?: unknown }).connected === true,
  );

/**
 * Per-attempt bound on a single status request. Without it a hung
 * request (half-open socket, stalled response body) blocks the wait
 * loop indefinitely — the loop's deadline is only checked *between*
 * probes — which wedged the connect card in "connecting" forever.
 */
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

const probeSignal = (probeTimeoutMs: number, signal?: AbortSignal) => {
  const timeout = AbortSignal.timeout(probeTimeoutMs);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
};

export const probeBackendIntegrationConnection = async (options: {
  siteUrl: string;
  authToken: string;
  id: string;
  /** Bounds a single request (default 10s); a slow probe is an "error". */
  probeTimeoutMs?: number;
  /** Cancels an in-flight request, not just the wait loop around it. */
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<BackendIntegrationProbeResult> => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.siteUrl.trim().replace(/\/+$/u, "");
  const response = await fetchImpl(
    `${base}/api/native-integrations/status?id=${encodeURIComponent(options.id)}`,
    {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${options.authToken}`,
      },
      signal: probeSignal(
        options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
        options.signal,
      ),
    },
  ).catch(() => null);
  if (!response) return "error";
  if (response.status === 404 || response.status === 405) {
    // Endpoint not deployed yet — completion can't be confirmed.
    return "unsupported";
  }
  if (!response.ok) return "error";
  const payload = (await response.json().catch(() => null)) as unknown;
  return readConnected(payload) ? "connected" : "not_connected";
};

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });

/**
 * Poll until the backend confirms the connection, the timeout elapses,
 * the signal aborts, or the endpoint turns out to be unsupported.
 * Transient probe errors are retried until the timeout.
 */
export const waitForBackendIntegrationConnection = async (options: {
  siteUrl: string;
  authToken: string;
  id: string;
  timeoutMs?: number;
  intervalMs?: number;
  /** Per-attempt request bound passed through to each probe. */
  probeTimeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Injectable clock for tests. */
  now?: () => number;
}): Promise<BackendIntegrationWaitResult> => {
  if (!options.siteUrl.trim() || !options.authToken.trim()) {
    return "auth_unavailable";
  }
  const timeoutMs = options.timeoutMs ?? 4 * 60 * 1000;
  const intervalMs = options.intervalMs ?? 2_500;
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  for (;;) {
    if (options.signal?.aborted) return "cancelled";
    const result = await probeBackendIntegrationConnection(options);
    if (result === "connected") return "connected";
    if (result === "unsupported") return "unsupported";
    if (options.signal?.aborted) return "cancelled";
    if (now() >= deadline) return "timeout";
    await sleep(intervalMs, options.signal);
  }
};
