import dns from "dns/promises";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "0.0.0.0",
  "127.0.0.1",
  "::1",
  "host.docker.internal",
]);

const allowedPrivateHosts = (): Set<string> =>
  new Set(
    (process.env.STELLA_ALLOW_PRIVATE_HOSTS ?? "")
      .split(",")
      .map((entry) => normalizeHostForClassification(entry))
      .filter((entry) => entry.length > 0),
  );

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
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 240
  );
};

const parseIpv6Groups = (host: string): number[] | null => {
  let input = host;
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

  if (isZeroThrough(7) && (groups[7] === 0 || groups[7] === 1)) return true;

  if ((groups[0] & 0xfe00) === 0xfc00) return true;

  if ((groups[0] & 0xffc0) === 0xfe80) return true;

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

export const isBlockedIpAddress = (ip: string): boolean => {
  const trimmed = normalizeHostForClassification(ip);
  const v4 = parseDottedQuad(trimmed);
  if (v4) return isBlockedIpv4Bytes(v4);
  if (trimmed.includes(":")) {
    const groups = parseIpv6Groups(trimmed);

    if (!groups) return true;
    return isBlockedIpv6Groups(groups);
  }
  return false;
};

const privateTargetError = (detail: string) =>
  new Error(
    `Private and local network targets are blocked.${detail} If this host is genuinely safe, add it to STELLA_ALLOW_PRIVATE_HOSTS (comma-separated hostnames).`,
  );

const assertPublicHostname = async (hostname: string) => {
  const normalized = normalizeHostForClassification(hostname);
  if (!normalized) {
    throw new Error("URL hostname is required.");
  }
  if (allowedPrivateHosts().has(normalized)) {
    return;
  }
  if (
    BLOCKED_HOSTNAMES.has(normalized) ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  ) {
    throw privateTargetError("");
  }
  if (isBlockedIpAddress(normalized)) {
    throw privateTargetError("");
  }

  const results = await dns.lookup(normalized, { all: true });
  if (results.length === 0) {
    throw new Error(`Could not resolve hostname "${normalized}".`);
  }
  if (results.some((result) => isBlockedIpAddress(result.address))) {
    const addrs = results.map((r) => r.address).join(", ");
    throw privateTargetError(
      ` "${normalized}" resolved to: ${addrs}. Check hosts file, VPN, or DNS if this should be a public site.`,
    );
  }
};

export const normalizeSafeExternalUrl = async (inputUrl: string) => {
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

  await assertPublicHostname(parsed.hostname);
  return parsed.toString();
};
