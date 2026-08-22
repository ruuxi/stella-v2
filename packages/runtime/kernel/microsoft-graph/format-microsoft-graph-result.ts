import type { ToolResult } from "../tools/types.js";

const extractJsonError = (text: string): string | null => {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      if (typeof record.error === "string" && record.error.trim()) {
        return record.error.trim();
      }
    }
  } catch {
    // Not a JSON error envelope.
  }
  return null;
};

/** Converts a Microsoft Graph service result into a Stella `ToolResult`. */
export const formatMicrosoftGraphCallToolResult = (
  result: unknown,
): ToolResult => {
  const r = result as {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  };
  const text = (r.content ?? [])
    .map((block) =>
      block.type === "text" && typeof block.text === "string"
        ? block.text
        : JSON.stringify(block),
    )
    .join("\n")
    .trim();

  const jsonError = extractJsonError(text);
  if (r.isError || jsonError) {
    return { error: (jsonError ?? text) || "Microsoft tool returned an error." };
  }
  return { result: text || "(empty result)" };
};
