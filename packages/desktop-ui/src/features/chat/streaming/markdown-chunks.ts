export const LONG_MARKDOWN_CHUNK_CHARS = 4_000;

/**
 * Split only at top-level blank lines so each Markdown parse is independently
 * bounded without cutting fenced code blocks. A pathological single block is
 * left intact rather than changing authored Markdown semantics.
 */
export function splitLongMarkdown(
  text: string,
  targetChars = LONG_MARKDOWN_CHUNK_CHARS,
): string[] {
  if (text.length <= targetChars) return [text];

  const chunks: string[] = [];
  const lines = text.match(/.*(?:\n|$)/g) ?? [text];
  let chunkStart = 0;
  let offset = 0;
  let fenceMarker: "`" | "~" | null = null;
  let fenceLength = 0;

  for (const line of lines) {
    if (!line) continue;
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const marker = fence[1]![0] as "`" | "~";
      if (fenceMarker === null) {
        fenceMarker = marker;
        fenceLength = fence[1]!.length;
      } else if (marker === fenceMarker && fence[1]!.length >= fenceLength) {
        fenceMarker = null;
        fenceLength = 0;
      }
    }

    offset += line.length;
    if (
      fenceMarker === null &&
      offset - chunkStart >= targetChars &&
      line.trim().length === 0
    ) {
      chunks.push(text.slice(chunkStart, offset));
      chunkStart = offset;
    }
  }

  if (chunkStart < text.length) chunks.push(text.slice(chunkStart));
  return chunks.length > 0 ? chunks : [text];
}
