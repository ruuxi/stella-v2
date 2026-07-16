import { describe, expect, it } from "vitest";

import { resolvePackagedPromptSiteUrl } from "@stella/desktop/electron/prompt-site-config.js";

describe("packaged prompt site configuration", () => {
  it("reads the desktop build config before renderer startup", () => {
    expect(
      resolvePackagedPromptSiteUrl({
        convexSiteUrl: "https://cloud.stella.sh/",
      }),
    ).toBe("https://cloud.stella.sh");
  });

  it("leaves cloud services unconfigured when the build config is empty", () => {
    expect(resolvePackagedPromptSiteUrl({ convexSiteUrl: null })).toBeNull();
  });
});
