/**
 * The `web` tool's fetch pipeline, shared by every host: readable-text
 * extraction, manual redirect following with per-hop SSRF re-validation,
 * timeout, and truncation. Pure fetch API — no node builtins — so the
 * cloud orchestrator DO (workerd) runs the same pipeline the desktop does.
 *
 * The URL guard and text sanitizer are capabilities, not imports: desktop
 * passes its DNS-checking guard and secret-redacting sanitizer; workerd
 * passes the literal-only guard.
 */

export const MAX_FETCH_BODY_CHARS = 80_000;
export const FETCH_TIMEOUT_MS = 30_000;
export const MAX_FETCH_REDIRECTS = 5;

/**
 * Hard ceiling on bytes read off the wire. The char cap above can only be
 * applied to a string that already exists, so without this a model-chosen URL
 * serving hundreds of megabytes is fully buffered before it is truncated —
 * an OOM in a 128 MB Durable Object isolate. Generous enough that no real
 * page is affected: the readable text is capped far below it anyway.
 */
export const MAX_FETCH_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Read at most `MAX_FETCH_BODY_BYTES`, then stop pulling. Cancels the
 * remainder rather than draining it, so an endless response costs one buffer,
 * not the whole stream.
 */
const readCappedText = async (response: Response): Promise<string> => {
  const body = response.body;
  if (!body) return response.text();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.byteLength;
      if (total >= MAX_FETCH_BODY_BYTES) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk.subarray(0, Math.min(chunk.byteLength, total - offset)), offset);
    offset += chunk.byteLength;
    if (offset >= total) break;
  }
  // A cap can cut mid-sequence, so decoding must not be fatal.
  return new TextDecoder().decode(joined);
};

/**
 * Minimal HTML-to-text conversion. Strips tags and decodes common entities.
 * No external dependency needed for this basic extraction.
 */
const htmlToText = (html: string): string => {
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<(?:br|p|div|li|h[1-6]|tr)[^>]*>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
};

export type WebFetchCoreOptions = {
  /**
   * Validate and canonicalize a URL before it is dialed — the SSRF guard.
   * Called on the initial URL and again on EVERY redirect hop. Throws to
   * refuse.
   */
  guardUrl: (url: string) => Promise<string>;
  /** Refuse URLs carrying what looks like a credential. */
  checkSecretLikeToken?: (url: string) => boolean;
  /** Redact/clean text before it becomes model-visible. */
  sanitize?: (text: string) => string;
  userAgent?: string;
};

export const fetchReadableText = async (
  args: { url: string; prompt?: string },
  options: WebFetchCoreOptions,
): Promise<string> => {
  const sanitize = options.sanitize ?? ((text: string) => text);
  if (!args.url) return "Error: URL is required.";
  if (options.checkSecretLikeToken?.(args.url)) {
    return "Error: URL contains what appears to be an API key or token. Secrets must not be sent in URLs.";
  }

  // Whole-pipeline deadline. This module must stay pure fetch API (the
  // cloud orchestrator DO runs it in workerd), so the deadline is the
  // platform's own `AbortSignal.timeout` rather than an Effect fiber; the
  // catch below maps its `TimeoutError` to the exact legacy timeout string.
  const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);

  try {
    let targetUrl = await options.guardUrl(args.url);

    let response: Response | null = null;
    for (
      let redirectCount = 0;
      redirectCount <= MAX_FETCH_REDIRECTS;
      redirectCount += 1
    ) {
      response = await fetch(targetUrl, {
        signal: timeoutSignal,
        redirect: "manual",
        headers: {
          "User-Agent": options.userAgent ?? "Stella/1.0",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
        },
      });

      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        targetUrl = await options.guardUrl(
          new URL(location, targetUrl).toString(),
        );
        continue;
      }

      break;
    }
    if (!response) {
      return "Error: No response received.";
    }
    if (
      response.status >= 300 &&
      response.status < 400 &&
      response.headers.get("location")
    ) {
      return `Error: Too many redirects (limit ${MAX_FETCH_REDIRECTS})`;
    }

    if (!response.ok) {
      return `Error: HTTP ${response.status} ${response.statusText}`;
    }

    const contentType = response.headers.get("content-type") ?? "";
    const rawBody = await readCappedText(response);

    let text: string;
    if (
      contentType.includes("text/html") ||
      contentType.includes("application/xhtml")
    ) {
      text = htmlToText(rawBody);
    } else {
      text = rawBody;
    }

    if (text.length > MAX_FETCH_BODY_CHARS) {
      text = text.slice(0, MAX_FETCH_BODY_CHARS) + "\n\n[Content truncated]";
    }

    if (!text.trim()) {
      return "The page returned no readable text content.";
    }

    return sanitize(text);
  } catch (error) {
    const msg = (error as Error).message ?? "Unknown error";
    // `TimeoutError` is what `AbortSignal.timeout` rejects with; its message
    // varies by runtime ("The operation timed out." on Bun does not contain
    // "abort"), so match the name as well to keep the legacy timeout string.
    if (msg.includes("abort") || (error as Error).name === "TimeoutError") {
      return `Error: Request timed out after ${FETCH_TIMEOUT_MS / 1000}s`;
    }
    return `Error fetching URL: ${sanitize(msg)}`;
  }
};
