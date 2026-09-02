import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src",
);

describe("Connect panel layout contract", () => {
  it("centers the hero copy only in the sidebar panel", () => {
    const css = fs.readFileSync(
      path.join(SOURCE_ROOT, "global/integrations/ConnectDialog.css"),
      "utf8",
    );

    expect(css).toMatch(
      /\.connect-panel \.connect-hero-tagline\s*\{[^}]*text-align:\s*center/,
    );

    expect(css).toMatch(
      /\.connect-hero-tagline\s*\{[^}]*text-align:\s*left/,
    );
  });
});
