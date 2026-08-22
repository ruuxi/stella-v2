import { ConnectorError } from "../errors";

/**
 * SSRF-safe origin binding for customer-hosted connect servers (1Password
 * Connect). Unlike the fixed-origin API-key providers, the HTTPS origin here is
 * supplied by the owner, so every property of it is adversarial input.
 *
 * A bound origin is accepted only when it is:
 *  - a valid absolute `https:` URL,
 *  - origin-only: no embedded userinfo, no path, no query, no fragment,
 *  - not a loopback / private / link-local / CGNAT / reserved / documentation /
 *    multicast / broadcast IP literal (v4 or v6, including IPv4-mapped/NAT64),
 *  - not an obviously internal or special-use hostname (single-label names,
 *    `localhost`, `.local`, `.internal`, RFC 6761 special-use TLDs), and not a
 *    known public DNS-rebinding wildcard service (nip.io / sslip.io / xip.io).
 *
 * DNS-rebinding note (§ Convex/fetch constraints): the default Convex runtime
 * exposes only global `fetch` — there is no `node:dns`, no way to resolve a
 * hostname to an address, and no way to pin the socket to a validated IP. So a
 * hostname that resolves to a private address at fetch time is a residual risk
 * that this layer cannot fully eliminate. It is mitigated, not solved, by:
 *  - rejecting unsafe IP literals and internal/rebinding hostnames here,
 *  - re-validating the bound origin on every request (below), and
 *  - `redirect: "manual"` at the fetch site, so a 3xx to an internal address is
 *    never followed and the token is never re-sent to a redirected host.
 * The remaining exposure is documented as an external requirement (an egress
 * proxy / allowlist) before native activation.
 */

/** Upper bound on a bound-origin string. Generous but not unbounded. */
export const HOSTED_CONNECT_MAX_ORIGIN_LENGTH = 255;

const invalidOrigin = (): never => {
  throw new ConnectorError("invalid_origin");
};

/**
 * RFC 6761 / RFC 2606 special-use and reserved suffixes, plus well-known public
 * DNS-rebinding wildcard resolvers. A candidate whose host is exactly one of
 * these or ends in one (as a dot-delimited suffix) is rejected.
 */
const BLOCKED_HOST_SUFFIXES = [
  "localhost",
  "local",
  "internal",
  "intranet",
  "lan",
  "corp",
  "home",
  "home.arpa",
  "test",
  "example",
  "invalid",
  "onion",
  "alt",
  // Public wildcard resolvers that map arbitrary labels to arbitrary IPs and
  // are a classic SSRF/rebinding vector.
  "nip.io",
  "sslip.io",
  "xip.io",
] as const;

const parseIpv4 = (host: string): number[] | null => {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  if (!match) return null;
  const octetStrings = match.slice(1, 5);
  // Reject ambiguous leading-zero octets (e.g. `010`), which some resolvers
  // interpret as octal.
  if (octetStrings.some((part) => part.length > 1 && part.startsWith("0"))) {
    return null;
  }
  const octets = octetStrings.map((part) => Number(part));
  if (octets.some((value) => value < 0 || value > 255)) return null;
  return octets;
};

const parseIpv6 = (host: string): number[] | null => {
  if (!/^[0-9a-f:.]+$/u.test(host)) return null;
  let work = host;
  // Fold a trailing embedded IPv4 (::ffff:1.2.3.4) into two hextets.
  if (work.includes(".")) {
    const lastColon = work.lastIndexOf(":");
    if (lastColon < 0) return null;
    const embedded = parseIpv4(work.slice(lastColon + 1));
    if (!embedded) return null;
    const high = ((embedded[0] << 8) | embedded[1]).toString(16);
    const low = ((embedded[2] << 8) | embedded[3]).toString(16);
    work = `${work.slice(0, lastColon + 1)}${high}:${low}`;
  }
  const halves = work.split("::");
  if (halves.length > 2) return null;
  const toGroups = (segment: string): number[] | null => {
    if (segment === "") return [];
    const groups = segment.split(":");
    const out: number[] = [];
    for (const group of groups) {
      if (!/^[0-9a-f]{1,4}$/u.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  if (halves.length === 1) {
    const groups = toGroups(halves[0]);
    return groups && groups.length === 8 ? groups : null;
  }
  const head = toGroups(halves[0]);
  const tail = toGroups(halves[1]);
  if (!head || !tail) return null;
  const missing = 8 - head.length - tail.length;
  // `::` must stand in for at least one zero group.
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
};

/** True for any IPv4 address outside globally-routable unicast space. */
export const isUnsafeIpv4 = (octets: number[]): boolean => {
  const [a, b, c] = octets;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // 224/4 multicast, 240/4 reserved, 255.255.255.255
  return false;
};

const embeddedIpv4 = (groups: number[]): number[] => [
  groups[6] >> 8,
  groups[6] & 0xff,
  groups[7] >> 8,
  groups[7] & 0xff,
];

/** True for any IPv6 address outside globally-routable unicast space. */
export const isUnsafeIpv6 = (groups: number[]): boolean => {
  if (groups.every((value) => value === 0)) return true; // :: unspecified
  if (groups.slice(0, 7).every((value) => value === 0) && groups[7] === 1) {
    return true; // ::1 loopback
  }
  const first = groups[0];
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (first === 0x2001 && groups[1] === 0x0db8) return true; // 2001:db8::/32 docs
  // IPv4-mapped ::ffff:0:0/96
  if (
    groups.slice(0, 5).every((value) => value === 0) &&
    groups[5] === 0xffff
  ) {
    return isUnsafeIpv4(embeddedIpv4(groups));
  }
  // IPv4-compatible ::/96 (deprecated) — classify the embedded v4.
  if (
    groups.slice(0, 6).every((value) => value === 0) &&
    (groups[6] !== 0 || groups[7] !== 0)
  ) {
    return isUnsafeIpv4(embeddedIpv4(groups));
  }
  // NAT64 well-known prefix 64:ff9b::/96
  if (
    groups[0] === 0x0064 &&
    groups[1] === 0xff9b &&
    groups.slice(2, 6).every((value) => value === 0)
  ) {
    return isUnsafeIpv4(embeddedIpv4(groups));
  }
  return false;
};

const hostnameIsAllowed = (host: string): boolean => {
  if (host.length > 253) return false;
  const labels = host.split(".");
  // Require a real registrable domain: at least two labels, no empty label.
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return false;
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/u.test(label)) return false;
  }
  // The TLD label must look like a domain suffix, never all-numeric.
  const tld = labels[labels.length - 1];
  if (!/^[a-z][a-z0-9-]{0,62}$/u.test(tld)) return false;
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return false;
  }
  return true;
};

/**
 * Parse, validate and canonicalize a customer-supplied HTTPS origin. Returns the
 * normalized origin (`https://host[:port]`) or throws `invalid_origin`. Never
 * accepts credentials, path, query or fragment, nor an unsafe host.
 */
export const normalizeHostedConnectOrigin = (candidate: unknown): string => {
  if (typeof candidate !== "string") return invalidOrigin();
  const trimmed = candidate.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > HOSTED_CONNECT_MAX_ORIGIN_LENGTH
  ) {
    return invalidOrigin();
  }
  // Reject any whitespace or control characters before parsing.
  if (/[^\x21-\x7e]/u.test(trimmed)) return invalidOrigin();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return invalidOrigin();
  }
  if (url.protocol !== "https:") return invalidOrigin();
  if (url.username !== "" || url.password !== "") return invalidOrigin();
  if (url.search !== "" || url.hash !== "") return invalidOrigin();
  if (url.pathname !== "" && url.pathname !== "/") return invalidOrigin();
  const host = url.hostname;
  if (host.length === 0) return invalidOrigin();
  const bracketed = host.startsWith("[") && host.endsWith("]");
  const bare = bracketed ? host.slice(1, -1) : host;
  const ipv4 = parseIpv4(bare);
  if (ipv4) {
    if (isUnsafeIpv4(ipv4)) return invalidOrigin();
  } else if (bracketed || bare.includes(":")) {
    const groups = parseIpv6(bare);
    if (!groups || isUnsafeIpv6(groups)) return invalidOrigin();
  } else if (!hostnameIsAllowed(bare)) {
    return invalidOrigin();
  }
  // `url.origin` is the WHATWG-canonical origin (scheme + host + non-default
  // port, IPv6 bracketed). This is the single canonical form we persist.
  if (url.origin === "null") return invalidOrigin();
  return url.origin;
};

/** Non-throwing predicate form, convenient for validation utilities/tests. */
export const isHostedConnectOriginAllowed = (candidate: unknown): boolean => {
  try {
    normalizeHostedConnectOrigin(candidate);
    return true;
  } catch {
    return false;
  }
};

/**
 * Build the absolute request URL for a bound origin from a planner-produced
 * relative path. The path must be server-constructed (leading `/`, never `//`,
 * no CR/LF). The bound origin is re-validated on every call, and the resulting
 * URL's origin must exactly equal the (re-normalized) bound origin — so a stored
 * profile can never widen its blast radius and a crafted path can never escape
 * the bound host. Throws `normalization_error` on any deviation.
 */
export const assertHostedConnectRequestUrl = (
  boundOrigin: string,
  path: string,
): URL => {
  let normalizedOrigin: string;
  try {
    normalizedOrigin = normalizeHostedConnectOrigin(boundOrigin);
  } catch {
    // A previously-stored origin that no longer validates is treated as a
    // construction error, never silently retried against an unsafe host.
    throw new ConnectorError("normalization_error");
  }
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    /[\r\n]/u.test(path)
  ) {
    throw new ConnectorError("normalization_error");
  }
  let url: URL;
  try {
    url = new URL(path, `${normalizedOrigin}/`);
  } catch {
    throw new ConnectorError("normalization_error");
  }
  if (url.origin !== normalizedOrigin) {
    throw new ConnectorError("normalization_error");
  }
  return url;
};
