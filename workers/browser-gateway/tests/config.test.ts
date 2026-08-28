import { describe, expect, test } from "bun:test";

describe("wrangler isolation", () => {
  test("pins private dev and bn118 browser/profile resources", async () => {
    const config = await Bun.file(
      new URL("../wrangler.jsonc", import.meta.url),
    ).text();
    expect(config).toContain('"workers_dev": false');
    expect(config).toContain('"binding": "BROWSER"');
    expect(config).toContain('"binding": "BROWSER_PROFILES"');
    expect(config).toContain('"class_name": "BrowserProfileSession"');
    expect(config).toContain("stella-v2-browser-profiles-dev");
    expect(config).toContain(
      "stella-v2-browser-profiles-basic-nightingale-118",
    );
    expect(config).toContain("stella-v2-browser-gateway-basic-nightingale-118");
    expect(config.match(/"binding": "DEVICE_CODE_FIXTURE"/gu)).toHaveLength(1);
    expect(config.indexOf('"binding": "DEVICE_CODE_FIXTURE"')).toBeGreaterThan(
      config.indexOf('"bn118"'),
    );
    expect(config).toContain('"entrypoint": "DeviceCodeFixtureService"');
    expect(config).toContain(
      '"DEVICE_CODE_FIXTURE_ORIGIN": "https://stella-v2-device-code-fixture-basic-nightingale-118.lolruuxi.workers.dev"',
    );
    expect(config).not.toContain('"secrets"');
    expect(config).not.toContain("BROWSER_PROFILE_KEK_V1");
  });
});
