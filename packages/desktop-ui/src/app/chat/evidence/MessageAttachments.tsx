import { useEffect, useMemo, useRef, useState } from "react";
import {
  isEvidenceMediaKind,
  type EvidenceCard,
} from "@stella/contracts/chat-evidence";
import { useEvidenceCards } from "@/features/chat/hooks/use-evidence-cards";
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

export const MessageAttachments = ({ filePaths }: { filePaths: string[] }) => {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const { cards, overflowCount } = useEvidenceCards(filePaths);

  const { media, documents } = useMemo(() => {
    const media: EvidenceCard[] = [];
    const documents: EvidenceCard[] = [];
    for (const card of cards) {
      if (isEvidenceMediaKind(card.kind) && card.kind !== "audio") media.push(card);
      else if (card.kind === "audio" && card.peaks) media.push(card);
      else documents.push(card);
    }
    return { media, documents };
  }, [cards]);

  const visible = useOnscreenTiles(rowRef, media.length);

  if (cards.length === 0) return null;

  return (
    <div className="attachment-strip">
      {media.length > 0 ? (
        <div className="attachment-strip__media" ref={rowRef}>
          {media.map((card) => (
            <div
              key={card.id}
              className="attachment-strip__tile"
              data-evidence-tile={card.id}
            >
              <MediaTile card={card} visible={visible.has(card.id)} />
            </div>
          ))}
        </div>
      ) : null}
      {documents.length > 0 || overflowCount > 0 ? (
        <div className="attachment-strip__pills">
          {documents.map((card) => (
            <AttachmentPill key={card.id} card={card} />
          ))}
          {overflowCount > 0 ? (
            <span className="attachment-strip__more">+{overflowCount} more</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
