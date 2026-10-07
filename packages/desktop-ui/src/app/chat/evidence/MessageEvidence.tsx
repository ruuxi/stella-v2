import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  EVIDENCE_RAIL_MIN_VIEWPORT,
  type EvidenceCard,
} from "@stella/contracts/chat-evidence";
import { useEvidenceCards } from "@/features/chat/hooks/use-evidence-cards";
import { EvidenceCardView } from "./EvidenceCardView";
import { splitMarkdownBlocks, tetherCardsToBlocks } from "./message-blocks";
import "./evidence-rail.css";

const INLINE_HOST_CLASS = "evidence-inline-host";
const ACTIVE_BAND = "-42% 0px -42% 0px";

const blockElementsOf = (body: HTMLElement): HTMLElement[] =>
  [...body.children].filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && !child.classList.contains(INLINE_HOST_CLASS),
  );

const useNarrowLayout = (ref: React.RefObject<HTMLDivElement | null>): boolean => {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width > 0) setNarrow(width < EVIDENCE_RAIL_MIN_VIEWPORT);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return narrow;
};

const useVisibleCards = (
  railRef: React.RefObject<HTMLDivElement | null>,
  cardCount: number,
): Set<string> => {
  const [visible, setVisible] = useState<Set<string>>(new Set());
  useEffect(() => {
    const rail = railRef.current;
    if (!rail || cardCount === 0 || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        setVisible((previous) => {
          const next = new Set(previous);
          let changed = false;
          for (const entry of entries) {
            const id = (entry.target as HTMLElement).dataset.evidenceCard;
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
      { rootMargin: "240px 0px 240px 0px" },
    );
    for (const slot of rail.querySelectorAll<HTMLElement>("[data-evidence-card]")) {
      observer.observe(slot);
    }
    return () => observer.disconnect();
  }, [railRef, cardCount]);
  return visible;
};

export const MessageEvidence = ({
  text,
  filePaths,
  children,
}: {
  text: string;
  filePaths: string[];
  children: ReactNode;
}) => {
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);
  const { cards, overflowCount } = useEvidenceCards(filePaths);
  const narrow = useNarrowLayout(layoutRef);
  const visible = useVisibleCards(railRef, narrow ? 0 : cards.length);
  const [activeBlock, setActiveBlock] = useState<number | null>(null);
  const [hosts, setHosts] = useState<{ cardId: string; host: HTMLElement }[]>([]);

  const tethers = useMemo(() => {
    if (cards.length === 0) return new Map<string, number>();
    return tetherCardsToBlocks(splitMarkdownBlocks(text), cards);
  }, [text, cards]);

  const tetheredBlocks = useMemo(() => new Set(tethers.values()), [tethers]);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const blocks = blockElementsOf(body);
    for (const [index, block] of blocks.entries()) {
      if (tetheredBlocks.has(index)) {
        block.dataset.evidenceTether = "true";
      } else {
        delete block.dataset.evidenceTether;
      }
    }
    return () => {
      for (const block of blocks) delete block.dataset.evidenceTether;
    };
  }, [tetheredBlocks, text]);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const blocks = blockElementsOf(body);
    const active = activeBlock === null ? null : blocks[activeBlock];
    if (active) active.dataset.evidenceActive = "true";
    return () => {
      if (active) delete active.dataset.evidenceActive;
    };
  }, [activeBlock]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body || tetheredBlocks.size === 0) {
      setActiveBlock(null);
      return;
    }
    if (typeof IntersectionObserver === "undefined") return;
    const blocks = blockElementsOf(body);
    const indexByElement = new Map<Element, number>();
    for (const [index, block] of blocks.entries()) {
      if (tetheredBlocks.has(index)) indexByElement.set(block, index);
    }
    if (indexByElement.size === 0) return;
    const inBand = new Set<number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = indexByElement.get(entry.target);
          if (index === undefined) continue;
          if (entry.isIntersecting) inBand.add(index);
          else inBand.delete(index);
        }
        setActiveBlock(inBand.size === 0 ? null : Math.min(...inBand));
      },
      { rootMargin: ACTIVE_BAND, threshold: 0 },
    );
    for (const element of indexByElement.keys()) observer.observe(element);
    return () => observer.disconnect();
  }, [tetheredBlocks, text]);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body || !narrow || cards.length === 0) {
      setHosts([]);
      return;
    }
    const blocks = blockElementsOf(body);
    const created: { cardId: string; host: HTMLElement }[] = [];
    const planned: { cardId: string; anchor: HTMLElement | null }[] = cards.map(
      (card) => ({
        cardId: card.id,
        anchor: blocks[tethers.get(card.id) ?? -1] ?? null,
      }),
    );
    for (const entry of planned) {
      const host = document.createElement("div");
      host.className = INLINE_HOST_CLASS;
      if (entry.anchor) entry.anchor.after(host);
      else body.append(host);
      created.push({ cardId: entry.cardId, host });
    }
    setHosts(created);
    return () => {
      for (const entry of created) entry.host.remove();
      setHosts([]);
    };
  }, [narrow, cards, tethers]);

  const cardById = useMemo(() => {
    const map = new Map<string, EvidenceCard>();
    for (const card of cards) map.set(card.id, card);
    return map;
  }, [cards]);

  const activeCardIds = useMemo(() => {
    if (activeBlock === null) return new Set<string>();
    const ids = new Set<string>();
    for (const [cardId, index] of tethers) {
      if (index === activeBlock) ids.add(cardId);
    }
    return ids;
  }, [activeBlock, tethers]);

  const hasRail = !narrow && cards.length > 0;

  return (
    <div
      ref={layoutRef}
      className="evidence-layout"
      data-narrow={narrow ? "true" : undefined}
      data-has-rail={hasRail ? "true" : undefined}
    >
      <div ref={bodyRef} className="evidence-layout__body">
        {children}
      </div>
      {hasRail ? (
        <aside className="evidence-layout__rail" aria-label="Attached evidence">
          <div ref={railRef} className="evidence-rail">
            {cards.map((card) => (
              <div
                key={card.id}
                className="evidence-rail__slot"
                data-evidence-card={card.id}
                style={{ minHeight: `${card.height + 26}px` }}
              >
                <EvidenceCardView
                  card={card}
                  active={activeCardIds.has(card.id)}
                  visible={visible.has(card.id)}
                />
              </div>
            ))}
            {overflowCount > 0 ? (
              <p className="evidence-rail__overflow">+{overflowCount} more</p>
            ) : null}
          </div>
        </aside>
      ) : null}
      {narrow
        ? hosts.map((entry) => {
            const card = cardById.get(entry.cardId);
            if (!card) return null;
            return createPortal(
              <figure className="evidence-inline">
                <EvidenceCardView card={card} active={false} visible />
              </figure>,
              entry.host,
              entry.cardId,
            );
          })
        : null}
      {narrow && overflowCount > 0 ? (
        <p className="evidence-rail__overflow evidence-rail__overflow--inline">
          +{overflowCount} more
        </p>
      ) : null}
    </div>
  );
};
