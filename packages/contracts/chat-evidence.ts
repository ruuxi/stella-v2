export type EvidenceCardKind =
  | "image"
  | "image-pair"
  | "video"
  | "audio"
  | "page"
  | "document"
  | "table"
  | "stack"
  | "bundle"
  | "plain";

export const EVIDENCE_CARD_HEIGHT: Record<EvidenceCardKind, number> = {
  image: 132,
  "image-pair": 132,
  video: 132,
  page: 132,
  document: 132,
  stack: 132,
  table: 104,
  audio: 84,
  bundle: 72,
  plain: 72,
};

export const EVIDENCE_RAIL_WIDTH = 250;
export const EVIDENCE_RAIL_MIN_VIEWPORT = 880;
export const EVIDENCE_CARD_CAP = 6;
export const EVIDENCE_PEAK_COUNT = 200;
export const EVIDENCE_RASTER_SCALE = 2;

export type EvidenceTable = {
  columns: string[];
  rows: string[][];
  totalRows: number;
  totalColumns: number;
};

export type EvidenceStackFrame = {
  title: string;
  sourcePath: string;
  thumbnail?: string;
};

export type EvidenceCompositionEntry = {
  label: string;
  count: number;
};

export type EvidenceCard = {
  id: string;
  kind: EvidenceCardKind;
  title: string;
  subtitle?: string;
  height: number;
  sourcePaths: string[];
  thumbnail?: string;
  thumbnailAfter?: string;
  peaks?: number[];
  durationMs?: number;
  playbackMimeType?: string;
  table?: EvidenceTable;
  frames?: EvidenceStackFrame[];
  composition?: EvidenceCompositionEntry[];
  fileCount?: number;
  pageCount?: number;
  byteSize?: number;
  extensionLabel?: string;
};

export type EvidenceCardSet = {
  cards: EvidenceCard[];
  overflowCount: number;
};
