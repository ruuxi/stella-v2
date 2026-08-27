import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src",
);

const source = (relativePath: string): string =>
  fs.readFileSync(path.join(SOURCE_ROOT, relativePath), "utf8");

describe("desktop cloud Memory preference wiring", () => {
  it("mounts the fail-closed cloud-to-local mirror at the application root", () => {
    const app = source("App.tsx");

    expect(app).toContain(
      'import { CloudMemoryPreferenceBridge } from "./features/cloud/CloudMemoryPreferenceBridge"',
    );
    expect(app).toContain("<CloudMemoryPreferenceBridge />");
  });

  it("keeps General Settings cloud-authoritative instead of reading the local mirror", () => {
    const general = source("global/settings/tabs/GeneralTab.tsx");

    expect(general).toContain(
      'import { useCloudMemoryPreference } from "@/features/cloud/use-cloud-memory-preference"',
    );
    expect(general).toContain(
      "const memoryPreference = useCloudMemoryPreference()",
    );
    expect(general).toContain(
      "void memoryPreference.setMemoryEnabled(checked)",
    );
    expect(general).not.toContain("preferences?.memoryEnabled");
    expect(general).not.toMatch(
      /setLocalModelPreferences\(\{\s*memoryEnabled/gu,
    );
  });
});
