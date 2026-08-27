import { describe, expect, it } from "vitest";
import { translatePlural } from "@/shared/i18n/catalogs";
import { SUPPORTED_LOCALES, DEFAULT_LOCALE } from "@/shared/i18n/locales";

const CATALOGS = import.meta.glob<{ default: Record<string, unknown> }>(
  "../../../src/shared/i18n/locales/*.json",
  { eager: true },
);

const catalogFor = (locale: string): Record<string, unknown> =>
  CATALOGS[`../../../src/shared/i18n/locales/${locale}.json`]!.default;

const PLURAL_CATEGORIES = new Set([
  "zero",
  "one",
  "two",
  "few",
  "many",
  "other",
]);

const isPluralNode = (v: unknown): v is Record<string, string> =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  Object.entries(v).length > 0 &&
  Object.entries(v).every(
    ([k, s]) => PLURAL_CATEGORIES.has(k) && typeof s === "string",
  );

const pluralKeys = (
  node: unknown,
  prefix = "",
  out: string[] = [],
): string[] => {
  if (isPluralNode(node)) {
    out.push(prefix);
  } else if (
    node !== null &&
    typeof node === "object" &&
    !Array.isArray(node)
  ) {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      pluralKeys(v, prefix ? `${prefix}.${k}` : k, out);
    }
  }
  return out;
};

const lookup = (catalog: Record<string, unknown>, key: string): unknown =>
  key
    .split(".")
    .reduce<unknown>(
      (node, seg) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[seg]
          : undefined,
      catalog,
    );

const COUNTS = [0, 1, 2, 3, 4, 5, 11, 12, 21, 22, 25, 100, 101, 111];

describe("plural form selection", () => {
  const english = catalogFor(DEFAULT_LOCALE);
  const keys = pluralKeys(english);

  it("has plural entries to exercise", () => {
    expect(keys.length).toBeGreaterThan(0);
  });

  it.each(SUPPORTED_LOCALES)(
    "%s selects the CLDR-correct form for every count",
    (locale) => {
      const catalog = catalogFor(locale);
      const rules = new Intl.PluralRules(locale);
      const wrong: string[] = [];

      for (const key of keys) {
        const node = lookup(catalog, key);

        if (!isPluralNode(node)) continue;

        for (const count of COUNTS) {
          const category = rules.select(count);
          const expected =
            count === 0 && typeof node.zero === "string"
              ? node.zero
              : (node[category] ?? node.other);

          const actual = translatePlural(catalog, locale, key, count);
          const rendered = String(expected).replace("{count}", String(count));

          if (actual !== rendered) {
            wrong.push(
              `${key} @ ${count} (${category}): got ${JSON.stringify(actual)}, want ${JSON.stringify(rendered)}`,
            );
          }
        }
      }

      expect(wrong.slice(0, 10)).toEqual([]);
    },
  );

  it("falls back to English when a locale has not translated the key", () => {
    const key = keys[0]!;

    const viaFallback = translatePlural({}, "ru", key, 5);
    expect(viaFallback).not.toBe(key);
    expect(viaFallback).toContain("5");
  });

  it("honours an explicit zero override ahead of CLDR", () => {
    const node = {
      zero: "No items yet",
      one: "{count} item",
      other: "{count} items",
    };
    const catalog = { t: { n: node } };

    expect(translatePlural(catalog, "en", "t.n", 0)).toBe("No items yet");
    expect(translatePlural(catalog, "en", "t.n", 1)).toBe("1 item");
    expect(translatePlural(catalog, "en", "t.n", 3)).toBe("3 items");
  });

  it("uses `other` when a language needs a category the catalog lacks", () => {

    const catalog = { t: { n: { other: "{count} шт." } } };
    expect(translatePlural(catalog, "ru", "t.n", 3)).toBe("3 шт.");
    expect(translatePlural(catalog, "ru", "t.n", 11)).toBe("11 шт.");
  });
});
