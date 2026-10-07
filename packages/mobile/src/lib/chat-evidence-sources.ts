/**
 * What an assistant message's attached files are, before anything is read.
 *
 * The strip under a reply has two rows: media that can show a real preview
 * (images, video, audio) and everything else as a compact pill. Which row a
 * file belongs to, and what it is called, is decided here from its path alone,
 * through the shared naming module the desktop rail uses. Nothing in this file
 * touches the filesystem or the network, so the rows can be laid out before a
 * single byte has moved.
 */
import {
  evidenceSourceKind,
  formatByteSize,
  humanTitleFor,
  pairTitleFor,
  parseEvidenceName,
  plainKindLabel,
  playbackMimeTypeFor,
  type EvidenceSourceKind,
} from "@stella/contracts/chat-evidence-naming";
import type { EvidenceCard } from "@stella/contracts/chat-evidence";

export type EvidenceSource = {
  filePath: string;
  kind: EvidenceSourceKind;
  order: number;
};

/** Rows: these three kinds have a cheap real preview on a phone. */
const MEDIA_KINDS = new Set<EvidenceSourceKind>(["image", "video", "audio"]);

export const isMediaSourceKind = (kind: EvidenceSourceKind): boolean =>
  MEDIA_KINDS.has(kind);

/** How many of each row the strip shows before it says "+N more". */
export const EVIDENCE_MEDIA_CAP = 8;
export const EVIDENCE_PILL_CAP = 8;

const PATH_SEPARATORS = /[\\/]/;

export const evidenceBasename = (filePath: string): string => {
  const cleaned = filePath.trim().split(/[?#]/)[0] ?? filePath.trim();
  const parts = cleaned.split(PATH_SEPARATORS);
  return parts[parts.length - 1] ?? cleaned;
};

/**
 * Deduplicated sources in the order the reply named them. A directory never
 * arrives through a chat link, so everything here is a file.
 */
export const describeEvidenceSources = (
  filePaths: readonly string[],
): EvidenceSource[] => {
  const seen = new Set<string>();
  const sources: EvidenceSource[] = [];
  for (const candidate of filePaths) {
    const filePath = candidate.trim();
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    sources.push({
      filePath,
      kind: evidenceSourceKind(filePath, false),
      order: sources.length,
    });
  }
  return sources;
};

export type EvidencePairCandidate = {
  before: EvidenceSource;
  after: EvidenceSource;
  pairingKey: string;
};

/**
 * Image pairs that may collapse into one drag-to-compare frame: two images
 * sharing a pairing key that differ only by a before/after token. Identical
 * pixel dimensions are the other half of the rule, and that needs the files,
 * so the caller confirms it once both previews have landed.
 */
export const evidencePairCandidates = (
  sources: readonly EvidenceSource[],
): EvidencePairCandidate[] => {
  const groups = new Map<string, EvidenceSource[]>();
  for (const source of sources) {
    if (source.kind !== "image") continue;
    const { pairingKey, variant } = parseEvidenceName(source.filePath);
    if (!variant || !pairingKey) continue;
    const group = groups.get(pairingKey) ?? [];
    group.push(source);
    groups.set(pairingKey, group);
  }
  const candidates: EvidencePairCandidate[] = [];
  for (const [pairingKey, group] of groups) {
    const before = group.find(
      (source) => parseEvidenceName(source.filePath).variant === "before",
    );
    const after = group.find(
      (source) => parseEvidenceName(source.filePath).variant === "after",
    );
    if (!before || !after) continue;
    candidates.push({ before, after, pairingKey });
  }
  return candidates.sort((left, right) => left.before.order - right.before.order);
};

export const evidenceTitleFor = (source: EvidenceSource): string =>
  humanTitleFor(source.filePath, source.kind);

/** A pill: a human name, what the thing is, and its weight when known. */
export const pillCardFor = (
  source: EvidenceSource,
  byteSize?: number,
): EvidenceCard => ({
  id: `pill:${source.filePath}`,
  kind: source.kind === "bundle" ? "bundle" : "plain",
  title: evidenceTitleFor(source),
  subtitle: byteSize
    ? `${plainKindLabel(source.filePath)} · ${formatByteSize(byteSize)}`
    : plainKindLabel(source.filePath),
  sourcePaths: [source.filePath],
  extensionLabel: plainKindLabel(source.filePath),
  ...(byteSize ? { byteSize } : {}),
});

export const pairCardTitle = (candidate: EvidencePairCandidate): string =>
  pairTitleFor(candidate.before.filePath);

export const evidencePlaybackMimeType = (filePath: string): string | undefined =>
  playbackMimeTypeFor(filePath);
