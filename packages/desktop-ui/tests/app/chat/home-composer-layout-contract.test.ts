import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src",
);

const readSource = (relativePath: string) =>
  fs.readFileSync(path.join(SOURCE_ROOT, relativePath), "utf8");

describe("home composer layout", () => {
  it("keeps the greeting in the centered composer flow", () => {
    const styles = readSource("app/home/home.css");
    const titleRule = styles.match(/\.home-stella-title\s*\{([^}]*)\}/)?.[1];

    expect(styles).toMatch(
      /\.home-content\s*\{[^}]*justify-content:\s*center;/s,
    );
    expect(titleRule).toBeDefined();
    expect(titleRule).toContain("margin: 0 0 20px;");
    expect(titleRule).not.toContain("position: absolute;");
    expect(titleRule).not.toContain("bottom:");
  });
});
