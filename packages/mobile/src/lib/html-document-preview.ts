/**
 * Preparation for HTML *document* artifacts (canvas HTML, office previews)
 * shown in the mobile artifact viewer's WebView.
 *
 * These documents are print-style "paper" artifacts: they typically set a dark
 * text color (`body { color: #111 }`) but assume a white page and never
 * declare a background. Rendered over the app's dark theme (or with WebView
 * forced-dark/algorithmic darkening), that produces black-on-black text.
 *
 * We inject a baseline stylesheet at the very start of the document so every
 * author rule loaded afterwards wins on equal specificity:
 *  - `color-scheme: light` keeps WKWebView/Android WebView from applying a
 *    dark UA canvas or algorithmic darkening to the page.
 *  - a solid white `html` background gives undeclared pages their assumed
 *    paper surface. Documents that author their own (possibly dark)
 *    backgrounds simply paint over it, exactly as authored.
 */

export const DOCUMENT_PAGE_BACKGROUND = "#ffffff";

const BASE_STYLE = `<style data-stella-doc-base="true">:root { color-scheme: light; } html { background-color: ${DOCUMENT_PAGE_BACKGROUND}; }</style>`;

/**
 * Injects the paper baseline right after `<head>` when present (so it precedes
 * author styles), otherwise after `<html>`, otherwise before everything.
 * Returns the input unchanged if the baseline was already injected.
 */
export function prepareDocumentHtml(html: string): string {
  if (html.includes('data-stella-doc-base="true"')) return html;

  const headMatch = /<head(?:\s[^>]*)?>/i.exec(html);
  if (headMatch) {
    const at = headMatch.index + headMatch[0].length;
    return html.slice(0, at) + BASE_STYLE + html.slice(at);
  }
  const htmlMatch = /<html(?:\s[^>]*)?>/i.exec(html);
  if (htmlMatch) {
    const at = htmlMatch.index + htmlMatch[0].length;
    return html.slice(0, at) + BASE_STYLE + html.slice(at);
  }
  return BASE_STYLE + html;
}
