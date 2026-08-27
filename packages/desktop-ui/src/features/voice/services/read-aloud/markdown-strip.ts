export function stripMarkdownForTts(input: string): string {
  if (!input) return "";
  let text = input;

  text = text.replace(/```[a-zA-Z0-9]*\n?[\s\S]*?```/g, " (code block) ");

  text = text.replace(/`([^`]+)`/g, "$1");

  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");

  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  text = text.replace(/https?:\/\/\S+/g, " (link) ");

  text = text.replace(/^#{1,6}\s+/gm, "");

  text = text.replace(/^>\s?/gm, "");

  text = text.replace(/^---+$/gm, "");

  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/__([^_]+)__/g, "$1");
  text = text.replace(/\*([^*\n]+)\*/g, "$1");
  text = text.replace(/(^|\s)_([^_\n]+)_/g, "$1$2");

  text = text.replace(/^\s*[-*]\s+/gm, "");
  text = text.replace(/^\s*\d+\.\s+/gm, "");

  text = text.replace(/<[^>]+>/g, "");

  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.replace(/[ \t]+/g, " ");
  return text.trim();
}
