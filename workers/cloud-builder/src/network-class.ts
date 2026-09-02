import type { NetworkClass } from "@stella/contracts/gateway/api";

const HOSTING_ASNS = new Set([
  8_075, 8_560, 8_987, 9_009, 12_876, 14_061, 14_618, 15_169, 16_276,
  16_509, 20_473, 24_940, 31_898, 396_982, 40_509, 45_090, 45_102,
  51_167, 60_781, 63_949, 132_203, 212_238,
]);

const VPN_RELAY_ASNS = new Set([
  // Cloudflare carries WARP and iCloud Private Relay egress.
  13_335,
]);

const VPN_ORGANIZATIONS = [
  "mullvad",
  "nordvpn",
  "expressvpn",
  "private internet access",
  "proton",
  "surfshark",
  "tunnelbear",
  "windscribe",
  "ipvanish",
  "cyberghost",
  "hide.me",
  "zenmate",
];

const MOBILE_ORGANIZATIONS = [
  "mobile",
  "wireless",
  "cellular",
  "t-mobile",
  "verizon wireless",
  "vodafone",
  "orange",
  "telefonica",
  "at&t mobility",
];

const EDU_ORGANIZATIONS = ["university", "college", "school", "edu"];

const HOSTING_ORGANIZATIONS = [
  "hosting",
  "datacenter",
  "data center",
  "cloud",
  "server",
  "colocation",
  "vps",
  "dedicated",
];

const organizationMatches = (
  organization: string,
  fragments: readonly string[],
): boolean => fragments.some((fragment) => organization.includes(fragment));

const parseNetworkClass = (value: string | null): NetworkClass | null => {
  switch (value?.trim()) {
    case "hosting":
      return "hosting";
    case "vpn":
      return "vpn";
    case "residential":
      return "residential";
    case "mobile":
      return "mobile";
    case "edu":
      return "edu";
    case "unknown":
      return "unknown";
    default:
      return null;
  }
};

export type AsnPolicy = {
  get(key: string, options: { cacheTtl: number }): Promise<string | null>;
};

type NetworkCfProperties = Pick<
  IncomingRequestCfProperties,
  "asn" | "asOrganization"
>;

const networkMetadataFrom = (
  cf: NetworkCfProperties | RequestInitCfProperties | undefined,
): { asn: number; organization: string } | null => {
  if (!cf) return null;
  const asn: unknown = Reflect.get(cf, "asn");
  if (typeof asn !== "number" || !Number.isSafeInteger(asn) || asn <= 0) {
    return null;
  }
  const organization: unknown = Reflect.get(cf, "asOrganization");
  return {
    asn,
    organization:
      typeof organization === "string"
        ? organization.trim().toLowerCase()
        : "",
  };
};

/** Classify Cloudflare's trusted edge metadata, with an optional ASN override. */
export const classifyNetwork = async (
  request: Request,
  asnPolicy?: AsnPolicy,
): Promise<NetworkClass> => {
  const metadata = networkMetadataFrom(request.cf);
  if (!metadata) return "unknown";
  const { asn, organization } = metadata;

  if (asnPolicy) {
    try {
      const override = parseNetworkClass(
        await asnPolicy.get(String(asn), { cacheTtl: 300 }),
      );
      if (override) return override;
    } catch {
      // The built-in policy remains available when the optional override is not.
    }
  }

  if (VPN_RELAY_ASNS.has(asn)) return "vpn";
  if (HOSTING_ASNS.has(asn)) return "hosting";

  if (organizationMatches(organization, VPN_ORGANIZATIONS)) return "vpn";
  if (organizationMatches(organization, MOBILE_ORGANIZATIONS)) return "mobile";
  if (organizationMatches(organization, EDU_ORGANIZATIONS)) return "edu";
  if (organizationMatches(organization, HOSTING_ORGANIZATIONS)) {
    return "hosting";
  }
  return "residential";
};
