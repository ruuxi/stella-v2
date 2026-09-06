/**
 * Block layouts contain flexible rows, percentage widths, or horizontal
 * scrollers. Give them the list cell's definite width instead of asking those
 * children to establish an intrinsic width for a hugging bubble.
 *
 * This is a layout hint, not a Markdown parser: a conservative match may make
 * a block wider, while ordinary prose and inline formatting continue to hug.
 */
export function assistantBubbleNeedsBoundedWidth(text: string): boolean {
  return /^(?: {0,3}(?:[-+*]\s|\d+[.)]\s|`{3,}|~{3,}|#{1,6}\s|>|(?:[-*_][ \t]*){3,}$)| {4}\S|\t\S)/m.test(text)
    || /^.*\|.*\n[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*\|/m.test(text);
}
