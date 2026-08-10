import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src",
);

describe("overlay voice runtime providers", () => {
  it("mounts the voice runtime inside a local i18n provider", () => {
    const source = fs.readFileSync(
      path.join(SOURCE_ROOT, "overlay-entry.tsx"),
      "utf8",
    );

    expect(source).toContain(
      'import { LocalI18nProvider } from "./shared/i18n/I18nProvider";',
    );
    expect(source).toMatch(
      /<LocalI18nProvider>[\s\S]*<DeferredVoiceRuntime \/>[\s\S]*<\/LocalI18nProvider>/,
    );
  });
});
