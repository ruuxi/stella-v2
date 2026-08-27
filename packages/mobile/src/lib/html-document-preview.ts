export const DOCUMENT_PAGE_BACKGROUND = "#ffffff";

const BASE_STYLE = `<style data-stella-doc-base="true">:root { color-scheme: light; } html { background-color: ${DOCUMENT_PAGE_BACKGROUND}; }</style>`;

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
