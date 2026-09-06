/**
 * The `html` tool's model-visible surface, split from the executable
 * definition so workerd hosts advertise the byte-identical tool. The device
 * host writes the canvas under `~/.stella/outputs/html/`; the cloud host
 * writes it into the owner's drive.
 */

export const HTML_TOOL_NAME = "html";

export const HTML_TOOL_DESCRIPTION =
  "Write a complete HTML document and show it as a canvas artifact in the workspace panel. Use whenever a richer answer than markdown helps — plans, diagrams (SVG), comparisons, mockups, dashboards, structured reports, documentation, long-form writeups, side-by-side options, anything with tables/colors/illustrations. Do NOT use to build a real Stella app (that's spawn_agent). The iframe has network — pull in Google Fonts, Tailwind, Chart.js, D3, three.js, icon sets, or any CDN asset that makes the canvas better. Returns immediately once the file is written.";

export const HTML_TOOL_PROMPT_SNIPPET =
  "Write a self-contained HTML doc to ~/.stella/outputs/html/<slug>.html and show it in the Canvas tab";

export const HTML_TOOL_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    slug: {
      type: "string",
      description:
        "Short kebab-case identifier for this canvas (e.g. 'onboarding-options'). Used as the filename. Lowercase letters, digits, hyphens; max 64 chars. If a canvas with the same slug already exists it is overwritten — use the same slug to iterate, a new slug for a new canvas.",
    },
    title: {
      type: "string",
      description:
        "Short human-readable title shown on the canvas tab/card (e.g. 'Onboarding — 6 directions').",
    },
    html: {
      type: "string",
      description:
        "Complete <!doctype html> document. The iframe has network — freely pull in Google Fonts, Tailwind, Chart.js, D3, three.js, icon sets, or any CDN asset via <link>, <script src>, or @import. Aim for a polished native-feeling canvas: spacious layout, soft borders, rounded cards, subtle shadows, Cormorant Garamond for display type and Manrope for body.",
    },
  },
  required: ["slug", "title", "html"],
};

const HTML_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Canonical slug for a canvas: the caller's if well-formed, else derived. */
export const htmlCanvasSlug = (
  rawSlug: string,
  fallback: string,
  now: number = Date.now(),
): string => {
  if (HTML_SLUG_RE.test(rawSlug)) return rawSlug;
  const lowered = (rawSlug || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return lowered.length > 0 ? lowered : `canvas-${now.toString(36)}`;
};
