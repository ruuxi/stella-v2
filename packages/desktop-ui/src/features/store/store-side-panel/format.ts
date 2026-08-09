/**
 * Slug a free-form name into a backend-acceptable package ID. Mirrors the
 * server's `PACKAGE_ID_PATTERN` (`^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$`)
 * so the publish action accepts whatever we generate without a round-trip
 * for ID validation.
 */
export function packageIdFromName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
// `Intl.RelativeTimeFormat` construction is not free and the same locale is
// asked for on every row render, so memoise per locale.
const relativeFormatterCache = new Map<string, Intl.RelativeTimeFormat>();

const relativeFormatterFor = (
  locale: string,
): Intl.RelativeTimeFormat | undefined => {
  const cached = relativeFormatterCache.get(locale);
  if (cached) return cached;
  try {
    // `narrow` is what produces the compact "5m ago" / "3h ago" / "2d ago"
    // shape this list has always used, and it gets the abbreviation and word
    // order right in every locale we ship — no catalog keys required.
    const formatter = new Intl.RelativeTimeFormat(locale, {
      numeric: "always",
      style: "narrow",
    });
    relativeFormatterCache.set(locale, formatter);
    return formatter;
  } catch {
    return undefined;
  }
};

/**
 * Relative timestamp for a recent-change row. Units are rendered by
 * `Intl.RelativeTimeFormat` against `locale` rather than hand-built English
 * suffixes; only the "just now" copy — a product decision, not a grammatical
 * one — comes from the catalog, so callers pass `t` in.
 */
export function formatTimeAgo(
  ms: number,
  locale: string,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 60) return t("features.store.recentChanges.justNow");
  const formatter = relativeFormatterFor(locale);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return formatter?.format(-minutes, "minute") ?? `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return formatter?.format(-hours, "hour") ?? `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return formatter?.format(-days, "day") ?? `${days}d ago`;
  return new Date(ms).toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
  });
}
