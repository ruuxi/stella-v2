import { afterEach, describe, expect, it, spyOn } from "bun:test";

import { postAlert } from "../convex/lib/alerts";

const previousWebhook = process.env.STELLA_ALERT_WEBHOOK_URL;

afterEach(() => {
  if (previousWebhook === undefined) delete process.env.STELLA_ALERT_WEBHOOK_URL;
  else process.env.STELLA_ALERT_WEBHOOK_URL = previousWebhook;
  spyOn(globalThis, "fetch").mockRestore();
});

describe("alerts", () => {
  it("posts Slack-compatible text with fields appended as lines", async () => {
    process.env.STELLA_ALERT_WEBHOOK_URL = "https://alerts.example/hook";
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 200 }),
    );

    await postAlert("Owner status changed", {
      ownerId: "owner-1",
      status: "challenged",
      score: 7,
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://alerts.example/hook");
    expect(JSON.parse(String(init?.body))).toEqual({
      text: "Owner status changed\nownerId: owner-1\nstatus: challenged\nscore: 7",
    });
  });

  it("does nothing when unset and never throws on delivery failure", async () => {
    delete process.env.STELLA_ALERT_WEBHOOK_URL;
    const fetchMock = spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("offline"),
    );
    await expect(postAlert("ignored")).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();

    process.env.STELLA_ALERT_WEBHOOK_URL = "https://alerts.example/hook";
    await expect(postAlert("best effort")).resolves.toBeUndefined();
  });
});
