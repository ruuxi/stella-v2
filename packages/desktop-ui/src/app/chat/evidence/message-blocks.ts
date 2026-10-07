import type { EvidenceCard } from "@stella/contracts/chat-evidence";

const STOP_TOKENS = new Set([
  "the",
  "a",
  "an",
  "and",
  "of",
  "to",
  "in",
  "on",
  "for",
  "before",
  "after",
  "page",
  "file",
  "files",
  "screen",
  "document",
  "table",
  "recording",
  "archive",
  "folder",
]);

export const splitMarkdownBlocks = (text: string): string[] => {
  const lines = text.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    if (current.length > 0) {
      blocks.push(current.join("\n"));
      current = [];
    }
  };
  for (const line of lines) {
    const fenced = /^\s*(```+|~~~+)/.exec(line);
    if (fenced) {
      const marker = fenced[1] ?? "";
      if (fence && line.trim().startsWith(fence)) {
        current.push(line);
        fence = null;
        flush();
        continue;
      }
      if (!fence) fence = marker;
      current.push(line);
      continue;
    }
    if (!fence && line.trim() === "") {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks;
};

const basenameOf = (filePath: string): string => {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] ?? filePath;
};

const titleTokens = (card: EvidenceCard): string[] =>
  card.title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !STOP_TOKENS.has(token));

export const tetherCardsToBlocks = (
  blocks: string[],
  cards: EvidenceCard[],
): Map<string, number> => {
  const lowered = blocks.map((block) => block.toLowerCase());
  const tethers = new Map<string, number>();
  for (const card of cards) {
    let matched = -1;
    for (const sourcePath of card.sourcePaths) {
      const needle = basenameOf(sourcePath).toLowerCase();
      const index = lowered.findIndex(
        (block) => block.includes(needle) || block.includes(encodeURI(needle)),
      );
      if (index >= 0) {
        matched = index;
        break;
      }
    }
    if (matched < 0) {
      const tokens = titleTokens(card);
      if (tokens.length > 0) {
        matched = lowered.findIndex((block) =>
          tokens.every((token) => block.includes(token)),
        );
      }
    }
    if (matched >= 0) tethers.set(card.id, matched);
  }
  return tethers;
};
