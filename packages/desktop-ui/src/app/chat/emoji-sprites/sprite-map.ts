import {
  EMOJI_PACK_GRID_VERSION,
  getEmojiSheetGridSize,
  getEmojiSheets,
} from "./cells";

export type EmojiSpriteCell = {

  sheet: number;

  cell: number;
};

type SpriteCache = {
  version: string;
  lookup: ReadonlyMap<string, EmojiSpriteCell>;
  regexSource: string;
};

let spriteCache: SpriteCache | null = null;

const buildLookup = (
  sheets: readonly (readonly string[])[],
): ReadonlyMap<string, EmojiSpriteCell> => {
  const map = new Map<string, EmojiSpriteCell>();
  sheets.forEach((sheet, sheetIndex) => {
    sheet.forEach((emoji, cellIndex) => {
      if (!map.has(emoji)) {
        map.set(emoji, { sheet: sheetIndex, cell: cellIndex });
      }
    });
  });
  return map;
};

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildEmojiRegexSource = (
  lookup: ReadonlyMap<string, EmojiSpriteCell>,
): string => {
  const sorted = [...lookup.keys()].sort((a, b) => b.length - a.length);
  if (sorted.length === 0) return "(?!)";
  const alternation = sorted.map(escapeRegex).join("|");
  return `(${alternation})`;
};

const getSpriteCache = (): SpriteCache => {
  const sheets = getEmojiSheets();
  const version = EMOJI_PACK_GRID_VERSION;
  if (spriteCache?.version === version) return spriteCache;
  const lookup = buildLookup(sheets);
  spriteCache = {
    version,
    lookup,
    regexSource: buildEmojiRegexSource(lookup),
  };
  return spriteCache;
};

export const cloneEmojiRegex = (): RegExp =>
  new RegExp(getSpriteCache().regexSource, "gu");

export const getEmojiSpriteCell = (emoji: string): EmojiSpriteCell | null =>
  getSpriteCache().lookup.get(emoji) ?? null;

export const getEmojiSpriteGridSize = (): number =>
  Math.max(1, getEmojiSheetGridSize());

export const getEmojiSpriteSheetCount = (): number => getEmojiSheets().length;

export const buildEmojiSpriteUrl = ({ sheet, cell }: EmojiSpriteCell): string =>
  `emoji-sprites/sheet-${sheet + 1}.webp#emoji-cell=${cell}`;

const URL_PATTERN = /^emoji-sprites\/sheet-(\d+)\.webp#emoji-cell=(\d+)$/;

export const parseEmojiSpriteUrl = (url: string): EmojiSpriteCell | null => {
  const match = url.match(URL_PATTERN);
  if (!match) return null;
  const sheetOneBased = Number.parseInt(match[1]!, 10);
  const cell = Number.parseInt(match[2]!, 10);
  if (!Number.isFinite(sheetOneBased) || !Number.isFinite(cell)) return null;
  const sheets = getEmojiSheets();
  const gridSize = getEmojiSheetGridSize();
  if (sheetOneBased < 1 || sheetOneBased > sheets.length) return null;
  if (cell < 0 || cell >= gridSize * gridSize) {
    return null;
  }
  return { sheet: sheetOneBased - 1, cell };
};

export const cellToRowCol = (cell: number): { row: number; col: number } => ({
  row: Math.floor(cell / getEmojiSpriteGridSize()),
  col: cell % getEmojiSpriteGridSize(),
});
