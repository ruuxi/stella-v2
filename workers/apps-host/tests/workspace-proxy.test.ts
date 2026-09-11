import { describe, expect, test } from "bun:test";
import host from "../src/index";

describe("workspace app origin", () => {
  test("forwards only app requests and strips account credentials", async () => {
    let forwarded: Request | undefined;
    const env = {
      CLOUD_APPS: {
        fetch: async (url: URL, init: RequestInit) => {
          forwarded = new Request(url, init);
          return new Response("app", {
            headers: { "content-security-policy": "sandbox allow-scripts" },
          });
        },
      },
    } as unknown as AppsHostBindings;
    const response = await host.fetch(
      new Request("https://apps.test/workspace-apps/token/api/count", {
        method: "POST",
        headers: {
          authorization: "Bearer private",
          cookie: "session=private",
          "content-type": "application/json",
        },
        body: "{}",
      }),
      env,
    );
    expect(await response.text()).toBe("app");
    expect(response.headers.get("content-security-policy")).toBe(
      "sandbox allow-scripts",
    );
    expect(forwarded?.headers.get("authorization")).toBeNull();
    expect(forwarded?.headers.get("cookie")).toBeNull();
    expect(forwarded?.url).toBe(
      "https://cloud-apps.internal/workspace-apps/token/api/count",
    );
    expect(await forwarded!.text()).toBe("{}");
    expect(
      (await host.fetch(new Request("https://apps.test/apps/old-app"), env))
        .status,
    ).toBe(404);
    expect(
      (await host.fetch(new Request("https://apps.test/api/session"), env))
        .status,
    ).toBe(404);
  });
});
