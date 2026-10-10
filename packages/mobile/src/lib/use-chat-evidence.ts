/**
 * The two rows of one reply's attachment strip.
 *
 * Pills are known from the path and render on the first frame. Media waits for
 * its native preview and, if that preview cannot be made — too large, offline,
 * a codec the device will not read — the file drops into the pill row rather
 * than showing a fake thumbnail.
 */
import { useEffect, useMemo, useState } from "react";
import {
  formatByteSize,
  formatDuration,
} from "@stella/contracts/chat-evidence-naming";
import {
  EVIDENCE_TILE_HEIGHT,
  EVIDENCE_TILE_WIDTH,
  type EvidenceCard,
} from "@stella/contracts/chat-evidence";
import {
  describeEvidenceSources,
  evidencePlaybackMimeType,
  evidenceTitleFor,
  isMediaSourceKind,
  pillCardFor,
  EVIDENCE_MEDIA_CAP,
  EVIDENCE_PILL_CAP,
  type EvidenceSource,
} from "./chat-evidence-sources";
import {
  requestEvidencePreview,
  type EvidencePreview,
} from "./chat-evidence-previews";
import type { StoredPhoneAccess } from "./phone-access";

/** Tile geometry is shared with the desktop strip. */
export const EVIDENCE_MEDIA_CARD_HEIGHT = EVIDENCE_TILE_HEIGHT;

type PreviewState =
  | { status: "pending" }
  | { status: "ready"; preview: EvidencePreview }
  | { status: "failed" };

export type ChatEvidence = {
  media: EvidenceCard[];
  pills: EvidenceCard[];
  overflowCount: number;
};

const EMPTY: ChatEvidence = { media: [], pills: [], overflowCount: 0 };

const imageCard = (
  source: EvidenceSource,
  preview: Extract<EvidencePreview, { kind: "image" }>,
): EvidenceCard => ({
  id: `image:${source.filePath}`,
  kind: "image",
  title: evidenceTitleFor(source),
  ...(preview.width && preview.height
    ? { subtitle: `${preview.width} × ${preview.height}` }
    : {}),
  sourcePaths: [source.filePath],
  thumbnail: preview.uri,
});

const videoCard = (
  source: EvidenceSource,
  preview: Extract<EvidencePreview, { kind: "video" }>,
): EvidenceCard => ({
  id: `video:${source.filePath}`,
  kind: "video",
  title: evidenceTitleFor(source),
  sourcePaths: [source.filePath],
  thumbnail: preview.posterUri,
  ...(preview.durationMs
    ? { durationMs: preview.durationMs, subtitle: formatDuration(preview.durationMs) }
    : {}),
  ...(evidencePlaybackMimeType(source.filePath)
    ? { playbackMimeType: evidencePlaybackMimeType(source.filePath) }
    : {}),
});

const audioCard = (
  source: EvidenceSource,
  preview: Extract<EvidencePreview, { kind: "audio" }>,
): EvidenceCard => ({
  id: `audio:${source.filePath}`,
  kind: "audio",
  title: evidenceTitleFor(source),
  subtitle: formatDuration(preview.durationMs),
  sourcePaths: [source.filePath],
  peaks: preview.peaks,
  durationMs: preview.durationMs,
  ...(evidencePlaybackMimeType(source.filePath)
    ? { playbackMimeType: evidencePlaybackMimeType(source.filePath) }
    : {}),
});

const placeholderCard = (source: EvidenceSource): EvidenceCard => ({
  id: `loading:${source.filePath}`,
  kind: source.kind === "audio" ? "audio" : source.kind === "video" ? "video" : "image",
  title: evidenceTitleFor(source),
  sourcePaths: [source.filePath],
});

export const evidenceCardWidth = (card: EvidenceCard): number =>
  EVIDENCE_TILE_WIDTH[card.kind];

export const useChatEvidence = (args: {
  filePaths: readonly string[];
  conversationId: string;
  access: StoredPhoneAccess | null;
}): ChatEvidence => {
  const { conversationId, access } = args;
  // Keyed on the paths themselves: a streamed row is replaced on every segment
  // and must not restart the previews it already has.
  const pathKey = useMemo(() => args.filePaths.join("\n"), [args.filePaths]);
  const sources = useMemo(
    () => describeEvidenceSources(pathKey ? pathKey.split("\n") : []),
    [pathKey],
  );
  const mediaSources = useMemo(
    () => sources.filter((source) => isMediaSourceKind(source.kind)),
    [sources],
  );
  const [previews, setPreviews] = useState<Record<string, PreviewState>>({});

  useEffect(() => {
    if (mediaSources.length === 0) return;
    let alive = true;
    const wanted = mediaSources.slice(0, EVIDENCE_MEDIA_CAP);
    setPreviews((current) => {
      const next: Record<string, PreviewState> = {};
      for (const source of wanted) {
        next[source.filePath] = current[source.filePath] ?? { status: "pending" };
      }
      return next;
    });
    for (const source of wanted) {
      void requestEvidencePreview({
        filePath: source.filePath,
        kind: source.kind,
        conversationId,
        access,
      })
        .then((preview) => {
          if (!alive) return;
          setPreviews((current) => ({
            ...current,
            [source.filePath]: { status: "ready", preview },
          }));
        })
        .catch(() => {
          if (!alive) return;
          setPreviews((current) => ({
            ...current,
            [source.filePath]: { status: "failed" },
          }));
        });
    }
    return () => {
      alive = false;
    };
  }, [mediaSources, conversationId, access]);

  return useMemo(() => {
    if (sources.length === 0) return EMPTY;
    const media: EvidenceCard[] = [];
    const pills: EvidenceCard[] = [];
    let overflowCount = 0;

    for (const source of sources) {
      if (!isMediaSourceKind(source.kind)) {
        if (pills.length >= EVIDENCE_PILL_CAP) {
          overflowCount += 1;
          continue;
        }
        pills.push(pillCardFor(source));
        continue;
      }
      if (media.length >= EVIDENCE_MEDIA_CAP) {
        overflowCount += 1;
        continue;
      }
      const state = previews[source.filePath];
      if (!state || state.status === "pending") {
        media.push(placeholderCard(source));
        continue;
      }
      if (state.status === "failed") {
        if (pills.length >= EVIDENCE_PILL_CAP) {
          overflowCount += 1;
          continue;
        }
        pills.push(pillCardFor(source));
        continue;
      }
      const preview = state.preview;
      if (preview.kind === "image") media.push(imageCard(source, preview));
      else if (preview.kind === "video") media.push(videoCard(source, preview));
      else media.push(audioCard(source, preview));
    }

    return { media, pills, overflowCount };
  }, [sources, previews]);
};

export const evidencePillSubtitle = (card: EvidenceCard): string =>
  card.subtitle ??
  (card.byteSize ? formatByteSize(card.byteSize) : (card.extensionLabel ?? "File"));
