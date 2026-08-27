import { describe, expect, it } from "vitest";
import { resolveCloudAppsHost } from "@/features/cloud/cloud-config";

describe("cloud Apps host configuration", () => {
  it("fails closed when a production build has no configured host", () => {
    expect(resolveCloudAppsHost(undefined, false)).toBeNull();
    expect(resolveCloudAppsHost("   ", false)).toBeNull();
    expect(resolveCloudAppsHost(undefined, undefined)).toBeNull();
  });

  it("uses the development host only when DEV is explicitly true", () => {
    expect(resolveCloudAppsHost(undefined, true)).toBe(
      "https://stella-v2-apps-host-dev.lolruuxi.workers.dev",
    );
    expect(
      resolveCloudAppsHost(undefined, "true" as unknown as boolean),
    ).toBeNull();
  });

  it("rejects an explicitly configured development host outside DEV", () => {
    const developmentHost =
      "https://stella-v2-apps-host-dev.lolruuxi.workers.dev";
    expect(resolveCloudAppsHost(developmentHost, false)).toBeNull();
    expect(resolveCloudAppsHost(`${developmentHost}/`, undefined)).toBeNull();
    expect(resolveCloudAppsHost(developmentHost, true)).toBe(developmentHost);
    expect(resolveCloudAppsHost(developmentHost, false, true)).toBe(
      developmentHost,
    );
    expect(
      resolveCloudAppsHost(
        developmentHost,
        false,
        "true" as unknown as boolean,
      ),
    ).toBeNull();
  });

  it("normalizes an explicitly configured host in any build", () => {
    expect(
      resolveCloudAppsHost(" https://apps.stella.example/// ", false),
    ).toBe("https://apps.stella.example");
  });
});
