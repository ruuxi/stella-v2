import { ConnectorError } from "../errors";
import { mockProviderAllowed } from "../env";

/**
 * Enforced first-party egress transport for customer-hosted connect providers.
 *
 * WHY THIS EXISTS (independent-review finding): the lexical origin validator in
 * `origin.ts` cannot stop DNS-to-private-IP SSRF. On the default Convex runtime
 * the only transport is global `fetch`, which resolves DNS itself and cannot be
 * pinned to a validated address — so a hostname that passes validation but
 * resolves (or rebinds) to `10.0.0.0/8`, `169.254.169.254`, etc. would still be
 * reached. A safe deployment therefore requires a network-layer control: a
 * DNS-pinning / IP-allowlisting egress proxy that performs the socket connect
 * against a re-validated address. That control is the *transport*.
 *
 * Until such a transport is implemented and wired here, EVERY hosted-connect
 * connect/execute path must fail closed BEFORE any token is stored or any
 * request egresses. Direct `fetch` is intentionally never returned as a
 * fallback: a missing transport is a hard stop, not a degrade-to-direct.
 *
 * There is deliberately no production environment variable that yields a
 * transport. Activation requires shipping a real proxy-client implementation in
 * this module; it cannot be toggled on with the current envs.
 */
export type HostedConnectEgressTransport = {
  /** Stable label for logs/audit (never a secret). */
  readonly kind: string;
  /**
   * Perform exactly one already-authorized request. A conforming transport MUST
   * connect only to a re-validated public address (DNS-pinning / allowlisting)
   * and MUST NOT follow redirects on the caller's behalf.
   */
  dispatch(url: string, init: RequestInit): Promise<Response>;
};

let injectedTransport: HostedConnectEgressTransport | null = null;

/**
 * Test/dev-only injection. Ignored at resolve time unless the connector mock
 * escape hatch (`STELLA_CONNECTOR_OAUTH_ALLOW_MOCK`) is enabled, which "must
 * never be set in production" (see `env.ts`). This lets the dormant scaffolding
 * be exercised without opening any production activation path.
 */
export const setHostedConnectEgressTransportForTesting = (
  transport: HostedConnectEgressTransport | null,
): void => {
  if (transport && !mockProviderAllowed()) {
    throw new Error(
      "Hosted-connect egress transport injection requires STELLA_CONNECTOR_OAUTH_ALLOW_MOCK.",
    );
  }
  injectedTransport = transport;
};

/**
 * Resolve the enforced egress transport, or `null` when none is available.
 * Production always returns `null` today: no real transport is implemented and
 * the test injection is honored only under the mock escape hatch.
 */
export const resolveHostedConnectEgressTransport =
  (): HostedConnectEgressTransport | null => {
    if (mockProviderAllowed() && injectedTransport) return injectedTransport;
    // No enforced first-party egress transport exists for the default Convex
    // fetch runtime. Wiring a DNS-pinning / allowlisting proxy client here is
    // the sole activation path; direct `fetch` is never returned.
    return null;
  };

export const isHostedConnectEgressTransportAvailable = (): boolean =>
  resolveHostedConnectEgressTransport() !== null;

/**
 * Return the transport or throw `egress_transport_unavailable`. This is the
 * single fail-closed choke point every connect/execute path routes through.
 */
export const requireHostedConnectEgressTransport =
  (): HostedConnectEgressTransport => {
    const transport = resolveHostedConnectEgressTransport();
    if (!transport) throw new ConnectorError("egress_transport_unavailable");
    return transport;
  };
