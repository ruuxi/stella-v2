export type CanvasNavigation =
  | { kind: "anchor"; fragment: string }
  | { kind: "external"; url: string }
  | { kind: "blocked" };

export const classifyCanvasNavigation = (href: string): CanvasNavigation => {
  const trimmed = href.trim();
  if (trimmed.startsWith("#")) {
    return { kind: "anchor", fragment: trimmed.slice(1) };
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return { kind: "external", url: url.href };
    }
  } catch {

  }
  return { kind: "blocked" };
};
