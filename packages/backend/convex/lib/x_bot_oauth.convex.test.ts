import { describe, expect, it } from "vitest";
import { createXOAuth1Header } from "./x_bot_oauth";

describe("createXOAuth1Header", () => {
  it("matches the OAuth 1.0 protocol signature example", async () => {
    const header = await createXOAuth1Header(
      "GET",
      "http://photos.example.net/photos?file=vacation.jpg&size=original",
      {
        apiKey: "dpf43f3p2l4k3l03",
        apiSecret: "kd94hf93k423kf44",
        accessToken: "nnch734d00sl2jdk",
        accessTokenSecret: "pfkkdhi9sl3r4s00",
      },
      { nonce: "kllo9940pd9333jh", timestamp: "1191242096" },
    );

    expect(header).toContain(
      'oauth_signature="tR3%2BTy81lMeYAr%2FFid0kMTYa%2FWM%3D"',
    );
  });
});
