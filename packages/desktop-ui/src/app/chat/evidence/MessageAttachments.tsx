import { useEffect, useMemo, useRef, useState } from "react";
import { fileDisplayName } from "@stella/contracts/file-display-name";
import {
  EVIDENCE_TILE_WIDTH,
  isEvidenceMediaKind,
  type EvidenceCard,
} from "@stella/contracts/chat-evidence";
import { useEvidenceCards } from "@/features/chat/hooks/use-evidence-cards";
import { buildPayloadFromBarePath } from "@/features/chat/lib/derive-turn-resource";
import { openDisplayPayloadTab } from "@/features/workspace-display/open-payload";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { AudioLines, Film, Image as ImageIcon } from "@/ui/icons";
import { MediaTile } from "./MediaTile";
import { AttachmentPill } from "./AttachmentPill";
import "./attachment-strip.css";

const useOnscreenTiles = (
  rowRef: React.RefObject<HTMLDivElement | null>,
  count: number,
): Set<string> => {
  const [visible, setVisible] = useState<Set<string>>(new Set());
  useEffect(() => {
    const row = rowRef.current;
    if (!row || count === 0 || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        setVisible((previous) => {
          const next = new Set(previous);
          let changed = false;
          for (const entry of entries) {
            const id = (entry.target as HTMLElement).dataset.evidenceTile;
            if (!id) continue;
            if (entry.isIntersecting && !next.has(id)) {
              next.add(id);
              changed = true;
            } else if (!entry.isIntersecting && next.has(id)) {
              next.delete(id);
              changed = true;
            }
          }
          return changed ? next : previous;
        });
      },
      { root: row, rootMargin: "200px" },
    );
    for (const tile of row.querySelectorAll<HTMLElement>("[data-evidence-tile]")) {
      observer.observe(tile);
    }
    return () => observer.disconnect();
  }, [rowRef, count]);
  return visible;
};

const TILE_GAP = 10;
const MORE_TILE_WIDTH = 76;

const expandStacks = (cards: readonly EvidenceCard[]): EvidenceCard[] =>
  cards.flatMap((card) =>
    card.kind === "stack" && card.frames && card.frames.length > 0
      ? card.frames.map((frame, index) => ({
          id: `${card.id}:${index}`,
          kind: "image" as const,
          title: frame.title,
          sourcePaths: [frame.sourcePath],
          ...(frame.thumbnail ? { thumbnail: frame.thumbnail } : {}),
        }))
      : [card],
  );

const tileWidth = (card: EvidenceCard): number => EVIDENCE_TILE_WIDTH[card.kind];

const fittingCount = (cards: readonly EvidenceCard[], width: number): number => {
  if (width <= 0) return cards.length;
  let used = 0;
  for (let index = 0; index < cards.length; index += 1) {
    const next = used + (index > 0 ? TILE_GAP : 0) + tileWidth(cards[index]!);
    const remaining = cards.length - index - 1;
    const reserve = remaining > 0 ? TILE_GAP + MORE_TILE_WIDTH : 0;
    if (next + reserve > width) return index;
    used = next;
  }
  return cards.length;
};

const useRowWidth = (
  rowRef: React.RefObject<HTMLDivElement | null>,
  mounted: boolean,
): number => {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const row = rowRef.current;
    if (!mounted || !row || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const next = Math.floor(entries[0]?.contentRect.width ?? 0);
      setWidth((previous) => (previous === next ? previous : next));
    });
    observer.observe(row);
    return () => observer.disconnect();
  }, [mounted, rowRef]);
  return width;
};

const fileNameOf = (card: EvidenceCard): string =>
  card.sourcePaths[0] ? fileDisplayName(card.sourcePaths[0]) : card.title;

const openFile = (filePath: string) => {
  const payload = buildPayloadFromBarePath(filePath, Date.now());
  if (payload) openDisplayPayloadTab(payload);
};

const MenuGlyph = ({ card }: { card: EvidenceCard }) =>
  card.kind === "video" ? (
    <Film size={14} aria-hidden="true" />
  ) : card.kind === "audio" ? (
    <AudioLines size={14} aria-hidden="true" />
  ) : (
    <ImageIcon size={14} aria-hidden="true" />
  );

const MoreTile = ({ cards }: { cards: readonly EvidenceCard[] }) => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <button
        type="button"
        className="attachment-strip__more-tile"
        aria-label={`${cards.length} more files`}
      >
        +{cards.length}
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent
      side="top"
      align="start"
      sideOffset={6}
      collisionPadding={12}
      className="attachment-strip__more-menu"
    >
      {cards.map((card) => (
        <DropdownMenuItem
          key={card.id}
          onSelect={() => {
            const target = card.sourcePaths[0];
            if (target) openFile(target);
          }}
        >
          <span className="attachment-strip__more-item">
            <span className="attachment-strip__more-glyph">
              <MenuGlyph card={card} />
            </span>
            <span className="attachment-strip__more-name">
              {fileNameOf(card)}
            </span>
          </span>
        </DropdownMenuItem>
      ))}
    </DropdownMenuContent>
  </DropdownMenu>
);

/**
 * A reply's attached files, in two parts: `media` is the rounded row of real
 * previews that sits directly under the bubble, `documents` the pills at the
 * bottom of the bubble.
 */
export const MessageAttachments = ({
  filePaths,
  part,
}: {
  filePaths: string[];
  part: "media" | "documents";
}) => {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const { cards, overflowCount } = useEvidenceCards(filePaths);

  const { media, documents } = useMemo(() => {
    const media: EvidenceCard[] = [];
    const documents: EvidenceCard[] = [];
    for (const card of expandStacks(cards)) {
      if (isEvidenceMediaKind(card.kind) && card.kind !== "audio") media.push(card);
      else if (card.kind === "audio" && card.peaks) media.push(card);
      else documents.push(card);
    }
    return { media, documents };
  }, [cards]);

  const rowWidth = useRowWidth(rowRef, part === "media" && media.length > 0);
  const shownCount = fittingCount(media, rowWidth);
  const shown = media.slice(0, shownCount);
  const hidden = media.slice(shownCount);
  const visible = useOnscreenTiles(rowRef, part === "media" ? shown.length : 0);

  if (part === "media") {
    if (media.length === 0) return null;
    return (
      <div className="attachment-strip attachment-strip--media">
        <div className="attachment-strip__media" ref={rowRef}>
          {shown.map((card) => (
            <div
              key={card.id}
              className="attachment-strip__tile"
              data-evidence-tile={card.id}
            >
              <MediaTile card={card} visible={visible.has(card.id)} />
            </div>
          ))}
          {hidden.length > 0 ? <MoreTile cards={hidden} /> : null}
        </div>
      </div>
    );
  }

  if (documents.length === 0 && overflowCount === 0) return null;

  return (
    <div className="attachment-strip">
      <div className="attachment-strip__pills">
        {documents.map((card) => (
          <AttachmentPill key={card.id} card={card} />
        ))}
        {overflowCount > 0 ? (
          <span className="attachment-strip__more">+{overflowCount} more</span>
        ) : null}
      </div>
    </div>
  );
};
