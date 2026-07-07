import type { ChatArtifact, MobileDisplayPayload } from "../types";

/**
 * Client-side PDF generator for the standalone cloud chat — the on-device
 * companion to `chat-maps.ts`. The cloud chat is self-contained (no desktop
 * bridge), so when the model asks for a PDF through the `chat-tools.ts` text
 * protocol this module renders the Markdown body to HTML, prints it to a real
 * PDF on the phone with `expo-print`, and hands back a `pdf` display payload
 * carrying the local `file://` URI. That payload rides the assistant message's
 * `artifacts` and surfaces as a tappable file card (open / save / share) with
 * no server round-trip — the mobile analog of ChatGPT's downloadable PDF.
 *
 * Native modules (`expo-print`, `expo-file-system`, `expo-sharing`) are pulled
 * in through dynamic `import()` inside the runtime functions so this module's
 * pure helpers (Markdown → HTML, filename slug, payload/summary builders) stay
 * importable in unit tests without a native runtime.
 */

type PdfPayload = Extract<MobileDisplayPayload, { kind: "pdf" }>;

export type PdfToolInput = {
  title?: string;
  content?: string;
  filename?: string;
};

export type PdfGenerateResult = {
  payload: PdfPayload;
  /** Compact text the model answers from; the card carries the file itself. */
  summary: string;
};

export type PdfGenerateOutcome =
  | { ok: true; result: PdfGenerateResult }
  | { ok: false; error: string };

const DEFAULT_TITLE = "Document";

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Slugify a title into a safe, human-readable PDF filename ending in `.pdf`. */
export const pdfFileName = (title: string, filename?: string): string => {
  const raw = (filename ?? title ?? "").trim();
  const base = raw
    .replace(/\.pdf$/i, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .toLowerCase();
  return `${base || "document"}.pdf`;
};

/** Render a minimal, safe subset of inline Markdown to HTML. */
const renderInline = (text: string): string => {
  let out = escapeHtml(text);
  // Inline code first so its contents are not further transformed.
  out = out.replace(/`([^`]+)`/g, (_all, code: string) => `<code>${code}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  out = out.replace(
    /\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
    (_all, label: string, href: string) =>
      `<a href="${escapeHtml(href)}">${label}</a>`,
  );
  return out;
};

const parseTableRow = (line: string): string[] =>
  line
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());

const isTableDivider = (line: string): boolean =>
  /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-");

/**
 * Render a block-level Markdown document to a self-contained HTML body.
 * Supports headings, paragraphs, ordered/unordered lists, blockquotes, fenced
 * code blocks, simple pipe tables, and horizontal rules — enough for the kinds
 * of documents the chat produces without pulling in a full Markdown engine.
 */
export const renderMarkdownBody = (markdown: string): string => {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      html.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      const tag = list.ordered ? "ol" : "ul";
      html.push(
        `<${tag}>${list.items.map((item) => `<li>${renderInline(item)}</li>`).join("")}</${tag}>`,
      );
      list = null;
    }
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    // Fenced code block.
    const fence = trimmed.match(/^```/);
    if (fence) {
      flushAll();
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith("```")) {
        code.push(lines[i] ?? "");
        i += 1;
      }
      html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    if (!trimmed) {
      flushAll();
      continue;
    }

    // Horizontal rule.
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushAll();
      html.push("<hr />");
      continue;
    }

    // Heading.
    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushAll();
      const level = heading[1]?.length ?? 1;
      html.push(`<h${level}>${renderInline(heading[2] ?? "")}</h${level}>`);
      continue;
    }

    // Blockquote.
    const quote = trimmed.match(/^>\s?(.*)$/);
    if (quote) {
      flushAll();
      html.push(`<blockquote>${renderInline(quote[1] ?? "")}</blockquote>`);
      continue;
    }

    // Pipe table: a header row followed by a divider row.
    if (
      trimmed.includes("|") &&
      i + 1 < lines.length &&
      isTableDivider(lines[i + 1] ?? "")
    ) {
      flushAll();
      const header = parseTableRow(trimmed);
      i += 2; // skip header + divider
      const bodyRows: string[][] = [];
      while (
        i < lines.length &&
        (lines[i] ?? "").trim().includes("|") &&
        (lines[i] ?? "").trim()
      ) {
        bodyRows.push(parseTableRow((lines[i] ?? "").trim()));
        i += 1;
      }
      i -= 1; // the outer loop will advance past the last consumed row
      const head = header
        .map((cell) => `<th>${renderInline(cell)}</th>`)
        .join("");
      const body = bodyRows
        .map(
          (row) =>
            `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`,
        )
        .join("");
      html.push(
        `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`,
      );
      continue;
    }

    // Ordered / unordered list item.
    const ordered = trimmed.match(/^\d+[.)]\s+(.*)$/);
    const unordered = trimmed.match(/^[-*+]\s+(.*)$/);
    if (ordered || unordered) {
      flushParagraph();
      const isOrdered = Boolean(ordered);
      const item = (ordered ? ordered[1] : unordered?.[1]) ?? "";
      if (list && list.ordered !== isOrdered) flushList();
      if (!list) list = { ordered: isOrdered, items: [] };
      list.items.push(item);
      continue;
    }

    // Plain paragraph text.
    flushList();
    paragraph.push(trimmed);
  }

  flushAll();
  return html.join("\n");
};

/** Wrap the rendered body in a print-friendly HTML document. */
export const renderPdfHtml = (title: string, content: string): string => {
  const body = renderMarkdownBody(content);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif;
    color: #1a1a1a;
    line-height: 1.55;
    font-size: 15px;
    padding: 48px 44px;
  }
  h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.4em 0 0.5em; font-weight: 700; }
  h1 { font-size: 26px; margin-top: 0; }
  h2 { font-size: 21px; }
  h3 { font-size: 18px; }
  h4, h5, h6 { font-size: 15px; }
  p { margin: 0 0 0.9em; }
  ul, ol { margin: 0 0 0.9em; padding-left: 1.4em; }
  li { margin: 0.2em 0; }
  blockquote {
    margin: 0 0 0.9em; padding: 0.2em 0 0.2em 1em;
    border-left: 3px solid #d0d0d0; color: #555;
  }
  code {
    font-family: "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace;
    font-size: 0.88em; background: #f2f2f2; padding: 0.1em 0.35em; border-radius: 4px;
  }
  pre {
    background: #f6f6f6; border: 1px solid #e6e6e6; border-radius: 8px;
    padding: 12px 14px; overflow-x: auto; margin: 0 0 0.9em;
  }
  pre code { background: none; padding: 0; }
  hr { border: none; border-top: 1px solid #e0e0e0; margin: 1.6em 0; }
  a { color: #1155cc; text-decoration: none; }
  table { border-collapse: collapse; width: 100%; margin: 0 0 1em; font-size: 14px; }
  th, td { border: 1px solid #dcdcdc; padding: 7px 10px; text-align: left; vertical-align: top; }
  th { background: #f4f4f4; font-weight: 600; }
</style>
</head>
<body>
${body}
</body>
</html>`;
};

/** Compact text the model narrates from once the PDF is in the chat. */
export const summarizePdf = (payload: PdfPayload): string => {
  const name = payload.title ?? payload.filePath;
  return [
    `The PDF "${name}" is now attached to the chat as a tappable file.`,
    "The user can tap it to open, save to Files, or share it from their phone.",
    "Don't paste the document's full contents into the chat text.",
  ].join(" ");
};

/** Wrap a generated PDF payload as a ChatArtifact for an assistant message. */
export const pdfArtifactFor = (
  payload: PdfPayload,
  conversationId: string,
): ChatArtifact => {
  const key = payload.localUri ?? payload.filePath;
  return {
    id: `${conversationId}:pdf:${key}`,
    conversationId,
    payload,
  };
};

/**
 * Render `content` (Markdown) to a real PDF on the device and return a payload
 * pointing at the local file. Runs entirely on-device; never touches a bridge.
 */
export async function generatePdf(
  input: PdfToolInput,
): Promise<PdfGenerateOutcome> {
  const content = (input.content ?? "").trim();
  if (!content) {
    return { ok: false, error: "PDF generation failed: no content to render." };
  }
  const title = (input.title ?? "").trim() || DEFAULT_TITLE;
  const fileName = pdfFileName(title, input.filename);

  try {
    const Print = await import("expo-print");
    const { uri } = await Print.printToFileAsync({
      html: renderPdfHtml(title, content),
    });

    // Move the print output to a human-readable name in the cache directory so
    // the share sheet / Files entry shows a sensible filename. Best-effort: if
    // the move fails we still hand back the original print URI.
    let localUri = uri;
    let sizeBytes: number | undefined;
    try {
      const { File, Paths } = await import("expo-file-system");
      const source = new File(uri);
      const target = new File(Paths.cache, fileName);
      if (target.exists) target.delete();
      source.move(target);
      localUri = target.uri;
      const size = target.size;
      if (typeof size === "number" && size > 0) sizeBytes = size;
    } catch {
      // Keep the original print URI; the artifact is still usable.
    }

    const payload: PdfPayload = {
      kind: "pdf",
      filePath: fileName,
      title,
      localUri,
      ...(sizeBytes != null ? { sizeBytes } : {}),
    };
    return { ok: true, result: { payload, summary: summarizePdf(payload) } };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unexpected error";
    return { ok: false, error: `PDF generation failed: ${message}` };
  }
}

/** Read an on-device PDF as a base64 data URI for in-app preview. */
export async function readLocalPdfDataUri(localUri: string): Promise<string> {
  const { File } = await import("expo-file-system");
  const base64 = await new File(localUri).base64();
  return `data:application/pdf;base64,${base64}`;
}

export type PdfShareOutcome = { ok: true } | { ok: false; error: string };

/** Present the OS share sheet for an on-device PDF (save to Files / share). */
export async function sharePdf(payload: PdfPayload): Promise<PdfShareOutcome> {
  const localUri = payload.localUri;
  if (!localUri) {
    return { ok: false, error: "This PDF isn't available on the device." };
  }
  try {
    const Sharing = await import("expo-sharing");
    if (!(await Sharing.isAvailableAsync())) {
      return { ok: false, error: "Sharing isn't available on this device." };
    }
    await Sharing.shareAsync(localUri, {
      mimeType: "application/pdf",
      UTI: "com.adobe.pdf",
      dialogTitle: payload.title ?? payload.filePath,
    });
    return { ok: true };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unexpected error";
    return { ok: false, error: `Couldn't share the PDF: ${message}` };
  }
}
