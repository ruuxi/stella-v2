import {
  STELLA_RENDERER_CSP_META,
  stellaRendererHeadEnd,
} from "@stella/contracts/desktop/renderer-security";

export const injectStellaRendererCsp = (html: string): string => {
  const insertionOffset = stellaRendererHeadEnd(html);
  if (insertionOffset === null) {
    throw new Error(
      "Interior entrypoint must begin with a standard doctype, html, and head.",
    );
  }
  return (
    html.slice(0, insertionOffset) +
    STELLA_RENDERER_CSP_META +
    html.slice(insertionOffset)
  );
};
