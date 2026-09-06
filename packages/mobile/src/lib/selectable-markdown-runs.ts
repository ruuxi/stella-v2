import type { MarkdownNode } from "react-native-nitro-markdown";
import type { Colors } from "../theme/colors";
import { fadeHex } from "../theme/oklch";
export type Run = { text: string; fontFamily: string; fontSize: number; color: string; italic?: boolean; strikethrough?: boolean; backgroundColor?: string; href?: string };

/** Convert parser spans, not raw Markdown, into UIKit's attributed text runs. */
export function markdownTextRuns(node: MarkdownNode, colors: Pick<Colors, "text" | "accent" | "muted">, fonts: { sans: { regular: string; semiBold: string }; mono: { regular: string } }, base: Partial<Run> = {}): Run[] {
  const visit = (entry: MarkdownNode, inherited: Omit<Run, "text">): Run[] => {
    const style = { ...inherited };
    if (entry.type === "bold") style.fontFamily = fonts.sans.semiBold;
    if (entry.type === "italic") style.italic = true;
    if (entry.type === "strikethrough") style.strikethrough = true;
    if (entry.type === "link") { style.href = entry.href; style.color = colors.accent; }
    if (entry.type === "code_inline") { style.fontFamily = fonts.mono.regular; style.backgroundColor = fadeHex(colors.muted, 0.35); }
    if (entry.type === "line_break" || entry.type === "soft_break") return [{ ...style, text: entry.type === "soft_break" ? " " : "\n" }];
    if (entry.children?.length) return entry.children.flatMap((child) => visit(child, style));
    return [{ ...style, text: entry.content ?? entry.alt ?? "" }];
  };
  return visit(node, { fontFamily: fonts.sans.regular, fontSize: 17, color: colors.text, ...base });
}
