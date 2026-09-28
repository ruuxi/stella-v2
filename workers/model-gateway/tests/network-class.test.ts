import { describe, expect, test } from "bun:test";
import { classifyNetwork } from "../../shared/network-class.js";

const requestWithNetwork = (
  asn?: number,
  asOrganization?: string,
): Request => {
  const request = new Request("https://worker.test/");
  Object.defineProperty(request, "cf", {
    value: { asn, asOrganization },
  });
  return request;
};

describe("classifyNetwork", () => {
  test("recognizes relay, VPN, mobile, education, and hosting organizations", async () => {
    expect(
      await classifyNetwork(requestWithNetwork(13_335, "Cloudflare, Inc.")),
    ).toBe("vpn");
    expect(
      await classifyNetwork(requestWithNetwork(64_500, "Mullvad VPN AB")),
    ).toBe("vpn");
    expect(
      await classifyNetwork(requestWithNetwork(64_501, "T-Mobile Wireless")),
    ).toBe("mobile");
    expect(
      await classifyNetwork(requestWithNetwork(64_502, "Example University")),
    ).toBe("edu");
    expect(
      await classifyNetwork(requestWithNetwork(64_503, "Example Data Center")),
    ).toBe("hosting");
    expect(
      await classifyNetwork(requestWithNetwork(64_504, "Neighborhood Fiber")),
    ).toBe("residential");
  });

  test("returns unknown without a valid ASN", async () => {
    expect(await classifyNetwork(requestWithNetwork())).toBe("unknown");
    expect(
      await classifyNetwork(requestWithNetwork(undefined, "Cloud Hosting")),
    ).toBe("unknown");
  });

  test("consults a valid KV override first with a five-minute cache", async () => {
    const calls: Array<{ key: string; cacheTtl: number }> = [];
    const policy = {
      get: async (key: string, options: { cacheTtl: number }) => {
        calls.push({ key, cacheTtl: options.cacheTtl });
        return "edu";
      },
    };
    expect(
      await classifyNetwork(requestWithNetwork(16_509, "Amazon"), policy),
    ).toBe("edu");
    expect(calls).toEqual([{ key: "16509", cacheTtl: 300 }]);
  });

  test("falls back to built-ins for invalid or unavailable overrides", async () => {
    expect(
      await classifyNetwork(requestWithNetwork(8_075, "Microsoft"), {
        get: async () => "not-a-class",
      }),
    ).toBe("hosting");
    expect(
      await classifyNetwork(requestWithNetwork(8_075, "Microsoft"), {
        get: async () => {
          throw new Error("KV unavailable");
        },
      }),
    ).toBe("hosting");
  });
});
