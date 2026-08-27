import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "../../i18n/locales";

const CLOUD_AUTHORITY_MEMORY_DESCRIPTION =
  "Include saved memories and your profile in Stella’s model context. The cloud copy is authoritative and encrypted in transit and at rest; Stella may also keep a local copy. Turning this off excludes memory from future turns but does not delete it.";
const localeDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../i18n/locales",
);
const MAX_CLOUD_HOME_ENGLISH_MATCHES = 8;

type Catalog = {
  settings?: { memory?: { description?: unknown } };
  mobile?: { cloudHome?: unknown };
};

const catalogs = new Map(
  SUPPORTED_LOCALES.map((locale) => [
    locale,
    JSON.parse(
      readFileSync(`${localeDirectory}/${locale}.json`, "utf8"),
    ) as Catalog,
  ]),
);

const stringLeaves = (
  value: unknown,
  prefix = "",
  output = new Map<string, string>(),
): Map<string, string> => {
  if (typeof value === "string") {
    output.set(prefix, value);
    return output;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      stringLeaves(child, prefix ? `${prefix}.${key}` : key, output);
    }
  }
  return output;
};

describe("mobile memory settings copy", () => {
  test("English pins the cloud-authority disclosure", () => {
    expect(
      catalogs.get(DEFAULT_LOCALE)?.settings?.memory?.description,
    ).toBe(CLOUD_AUTHORITY_MEMORY_DESCRIPTION);
  });

  const englishCloudHome = stringLeaves(
    catalogs.get(DEFAULT_LOCALE)?.mobile?.cloudHome,
    "mobile.cloudHome",
  );

  for (const locale of SUPPORTED_LOCALES.filter(
    (candidate) => candidate !== DEFAULT_LOCALE,
  )) {
    test(`${locale} localizes cloud memory and Cloud Home copy`, () => {
      const catalog = catalogs.get(locale);
      const description = catalog?.settings?.memory?.description;
      const translatedCloudHome = stringLeaves(
        catalog?.mobile?.cloudHome,
        "mobile.cloudHome",
      );
      const exactEnglishMatches = [...englishCloudHome]
        .filter(([path, value]) => translatedCloudHome.get(path) === value)
        .map(([path]) => path)
        .sort();

      expect(typeof description).toBe("string");
      expect(description === CLOUD_AUTHORITY_MEMORY_DESCRIPTION).toBe(false);
      expect((description as string).trim().length).toBeGreaterThan(40);
      expect(englishCloudHome.size).toBe(53);
      if (exactEnglishMatches.length > MAX_CLOUD_HOME_ENGLISH_MATCHES) {
        throw new Error(
          `English Cloud Home filler remains in ${locale}:\n${exactEnglishMatches.join("\n")}`,
        );
      }
      expect(exactEnglishMatches.length).toBeLessThanOrEqual(
        MAX_CLOUD_HOME_ENGLISH_MATCHES,
      );
    });
  }
});
