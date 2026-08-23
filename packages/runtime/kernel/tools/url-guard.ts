/**
 * SSRF guard shared by every host that fetches a model- or user-supplied
 * URL: the desktop runtime, the cloud orchestrator DO (workerd), and the
 * sandbox executor. Pure — no node builtins — so workerd can import it.
 *
 * The WHATWG URL parser already canonicalizes exotic IPv4 spellings
 * (decimal `2130706433`, hex `0x7f000001`, octal `0177.0.0.1`, short forms
 * `127.1`) into dotted-quad before this module sees them, so classification
 * here works on canonical hostnames. IPv6 needs real handling: IPv4-mapped
 * (`::ffff:127.0.0.1`), IPv4-translated (`::ffff:0:x`), and NAT64
 * (`64:ff9b::/96`) forms embed a v4 address that must be checked as v4 —
 * prefix string checks alone let `http://[::ffff:127.0.0.1]/` through.
 *
 * DNS is a capability, not an import: hosts with a resolver (node) pass
 * `resolveHost` so names are checked against what they actually resolve to.
 *
 * KNOWN LIMITS, stated plainly rather than implied by omission:
 *
 * 1. Without `resolveHost` (workerd — no resolver API) this guard classifies
 *    IP LITERALS ONLY. A hostname whose A record points at 169.254.169.254
 *    or any internal address passes it. The cloud `web` tool is in exactly
 *    that position, and since the model chooses the URL, a prompt injection
 *    can aim it. The only real control there is network egress policy at the
 *    platform edge — treat this function as defense in depth on that path,
 *    not as the boundary.
 * 2. Even WITH `resolveHost` the check is resolve-then-fetch: `fetch` does
 *    its own lookup, so a rebinding record (TTL 0, second answer private) or
 *    a round-robin set with one private address is not fully closed. Pinning
 *    the connection to the validated address is the only complete fix and is
 *    not expressible through the fetch API.
 */

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "0.0.0.0",
  "127.0.0.1",
  "::1",
  "host.docker.internal",
]);

/**
 * Canonical form for hostname classification: lowercased, brackets removed,
 * and — the part that matters — a single trailing dot stripped. `localhost.`
 * is the same host as `localhost` to DNS but a different string to a `Set`,
 * so without this the name blocklist is bypassed by typing one extra dot.
 */
const normalizeHostForClassification = (host: string): string =>
  host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");

const parseDottedQuad = (host: string): number[] | null => {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
};

const isBlockedIpv4Bytes = (bytes: number[]): boolean => {
  const [a, b] = bytes;
  return (
    a === 0 || // "this network", including 0.0.0.0
    a === 10 || // RFC1918
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    (a === 169 && b === 254) || // link-local (cloud metadata endpoints)
    (a === 172 && b >= 16 && b <= 31) || // RFC1918
    (a === 192 && b === 168) || // RFC1918
    a >= 240 // reserved 240/4 + broadcast
  );
};

/**
 * Expand an IPv6 literal into its eight 16-bit groups, or null when the
 * string is not valid IPv6. Accepts the trailing-dotted-quad form
 * (`::ffff:127.0.0.1`) the URL parser preserves.
 */
const parseIpv6Groups = (host: string): number[] | null => {
  let input = host;
  // Trailing IPv4 tail → two 16-bit groups.
  const v4TailMatch = input.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4TailMatch) {
    const bytes = parseDottedQuad(v4TailMatch[2]);
    if (!bytes) return null;
    input =
      v4TailMatch[1] +
      ((bytes[0] << 8) | bytes[1]).toString(16) +
      ":" +
      ((bytes[2] << 8) | bytes[3]).toString(16);
  }
  const doubleColonSplits = input.split("::");
  if (doubleColonSplits.length > 2) return null;
  const parseGroups = (section: string): number[] | null => {
    if (section === "") return [];
    const groups: number[] = [];
    for (const raw of section.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(raw)) return null;
      groups.push(Number.parseInt(raw, 16));
    }
    return groups;
  };
  if (doubleColonSplits.length === 1) {
    const groups = parseGroups(input);
    return groups && groups.length === 8 ? groups : null;
  }
  const head = parseGroups(doubleColonSplits[0]);
  const tail = parseGroups(doubleColonSplits[1]);
  if (!head || !tail || head.length + tail.length > 7) return null;
  return [
    ...head,
    ...new Array(8 - head.length - tail.length).fill(0),
    ...tail,
  ];
};

const isBlockedIpv6Groups = (groups: number[]): boolean => {
  const isZeroThrough = (count: number) =>
    groups.slice(0, count).every((group) => group === 0);
  // Unspecified (::) and loopback (::1).
  if (isZeroThrough(7) && (groups[7] === 0 || groups[7] === 1)) return true;
  // ULA fc00::/7.
  if ((groups[0] & 0xfe00) === 0xfc00) return true;
  // Link-local fe80::/10.
  if ((groups[0] & 0xffc0) === 0xfe80) return true;
  // Embedded-IPv4 forms: mapped ::ffff:x/96, translated ::ffff:0:x/96,
  // NAT64 64:ff9b::/96, and the deprecated IPv4-COMPATIBLE ::a.b.c.d — the
  // effective target is the embedded v4 address in every one of them. The
  // compatible form matters because `::7f00:1` is a spelling of 127.0.0.1
  // that no prefix check catches.
  const embeddedV4 =
    (isZeroThrough(5) && groups[5] === 0xffff) ||
    (isZeroThrough(4) && groups[4] === 0xffff && groups[5] === 0) ||
    (groups[0] === 0x64 &&
      groups[1] === 0xff9b &&
      groups[2] === 0 &&
      groups[3] === 0 &&
      groups[4] === 0 &&
      groups[5] === 0) ||
    (isZeroThrough(6) && (groups[6] !== 0 || groups[7] !== 0));
  if (embeddedV4) {
    return isBlockedIpv4Bytes([
      groups[6] >> 8,
      groups[6] & 0xff,
      groups[7] >> 8,
      groups[7] & 0xff,
    ]);
  }
  return false;
};

/**
 * True for literal IP strings targeting loopback, private, link-local,
 * CGNAT, reserved, or embedded-v4-blocked space. Domain names return false
 * — resolution is the `resolveHost` capability's job.
 */
export const isBlockedIpAddress = (ip: string): boolean => {
  const trimmed = normalizeHostForClassification(ip);
  const v4 = parseDottedQuad(trimmed);
  if (v4) return isBlockedIpv4Bytes(v4);
  if (trimmed.includes(":")) {
    const groups = parseIpv6Groups(trimmed);
    // An unparseable bracketed literal is refused rather than resolved.
    if (!groups) return true;
    return isBlockedIpv6Groups(groups);
  }
  return false;
};

export type NormalizeSafePublicUrlOptions = {
  /**
   * Resolve a hostname to the addresses a fetch would actually dial, so
   * DNS names pointing into blocked space are refused. Hosts without a
   * resolver (workerd) omit it and rely on literal checks plus platform
   * egress policy.
   */
  resolveHost?: (hostname: string) => Promise<string[]>;
  /**
   * When true, only the hostname string is validated (no DNS check). Used
   * in development when VPN/DNS maps public names to private IPs.
   */
  skipResolvedAddressCheck?: boolean;
};

/**
 * Validate and canonicalize an outbound URL: http(s) only, no embedded
 * credentials, no private/local targets (literal or resolved), http
 * upgraded to https. Throws on refusal; returns the canonical URL string.
 * Callers following redirects MUST re-run this on every hop.
 */
export const normalizeSafePublicUrl = async (
  inputUrl: string,
  options?: NormalizeSafePublicUrlOptions,
): Promise<string> => {
  const trimmed = inputUrl.trim();
  if (!trimmed) {
    throw new Error("URL is required.");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Invalid URL.");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Only HTTP and HTTPS URLs are supported.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Embedded URL credentials are not allowed.");
  }
  if (parsed.protocol === "http:") {
    parsed.protocol = "https:";
  }

  const hostname = normalizeHostForClassification(parsed.hostname);
  if (!hostname) {
    throw new Error("URL hostname is required.");
  }
  if (
    BLOCKED_HOSTNAMES.has(hostname) ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    throw new Error("Private and local network targets are blocked.");
  }
  if (isBlockedIpAddress(hostname)) {
    throw new Error("Private and local network targets are blocked.");
  }

  if (options?.resolveHost && !options.skipResolvedAddressCheck) {
    const addresses = await options.resolveHost(hostname);
    if (addresses.length === 0) {
      throw new Error(`Could not resolve hostname "${hostname}".`);
    }
    if (addresses.some((address) => isBlockedIpAddress(address))) {
      throw new Error(
        `Private and local network targets are blocked. "${hostname}" resolved to: ${addresses.join(", ")}. Check hosts file, VPN, or DNS if this should be a public site.`,
      );
    }
  }

  return parsed.toString();
};
