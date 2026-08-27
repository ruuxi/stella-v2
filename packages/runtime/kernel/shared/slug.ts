const DEFAULT_MAX_SLUG_LENGTH = 48;

export const slugify = (
  value: string,
  maxLength = DEFAULT_MAX_SLUG_LENGTH,
): string => {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= maxLength) return slug;
  const cut = slug.slice(0, maxLength);
  const lastDash = cut.lastIndexOf("-");

  return (lastDash > 8 ? cut.slice(0, lastDash) : cut).replace(/-+$/, "");
};
