export type EvidenceCardKind =
  | "image"
  | "video"
  | "audio"
  | "page"
  | "document"
  | "table"
  | "stack"
  | "bundle"
  | "plain";

export const EVIDENCE_MEDIA_KINDS: readonly EvidenceCardKind[] = [
  "image",
  "video",
  "audio",
  "stack",
];

export const isEvidenceMediaKind = (kind: EvidenceCardKind): boolean =>
  EVIDENCE_MEDIA_KINDS.includes(kind);

export const EVIDENCE_TILE_HEIGHT = 132;

export const EVIDENCE_TILE_WIDTH: Record<EvidenceCardKind, number> = {
  image: 176,
  video: 176,
  stack: 176,
  audio: 248,
  page: 176,
  document: 176,
  table: 176,
  bundle: 176,
  plain: 176,
};

export const EVIDENCE_CARD_CAP = 10;
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
  sourcePaths: string[];
  thumbnail?: string;
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
