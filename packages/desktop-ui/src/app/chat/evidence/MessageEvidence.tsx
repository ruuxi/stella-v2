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
  EVIDENCE_RAIL_WIDTH,
  type EvidenceCard,
} from "@stella/contracts/chat-evidence";
import { useEvidenceCards } from "@/features/chat/hooks/use-evidence-cards";
import { EvidenceCardView } from "./EvidenceCardView";
import { splitMarkdownBlocks, tetherCardsToBlocks } from "./message-blocks";
import "./evidence-rail.css";

const INLINE_HOST_CLASS = "evidence-inline-host";
const ACTIVE_BAND = "-42% 0px -42% 0px";
const RAIL_GAP = 28;
const RAIL_GUTTER = EVIDENCE_RAIL_WIDTH + RAIL_GAP;

const ownChildrenOf = (element: HTMLElement): HTMLElement[] =>
  [...element.children].filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && !child.classList.contains(INLINE_HOST_CLASS),
  );

const resolveBlockContainer = (body: HTMLElement): HTMLElement => {
  let current = body;
  for (let depth = 0; depth < 4; depth += 1) {
    const children = ownChildrenOf(current);
    const only = children[0];
    if (children.length === 1 && only && only.tagName === "DIV") {
      current = only;
      continue;
    }
    break;
  }
  return current;
};

const scrollParentOf = (element: HTMLElement): HTMLElement => {
  let current = element.parentElement;
  while (current) {
    const overflowX = getComputedStyle(current).overflowX;
    if (overflowX === "auto" || overflowX === "scroll") return current;
    current = current.parentElement;
  }
  return document.documentElement;
};

const usePaintEscape = (
  layoutRef: React.RefObject<HTMLDivElement | null>,
  active: boolean,
) => {
  useLayoutEffect(() => {
    const layout = layoutRef.current;
    if (!layout || !active) return;
    const patched: { element: HTMLElement; previous: string }[] = [];
    let current = layout.parentElement;
    while (current && current !== document.body) {
      const contain = getComputedStyle(current).contain;
      if (
        contain.includes("paint") ||
        contain === "content" ||
        contain === "strict"
      ) {
        patched.push({ element: current, previous: current.style.contain });
        current.style.contain = "layout style";
      }
      current = current.parentElement;
    }
    return () => {
      for (const entry of patched) entry.element.style.contain = entry.previous;
    };
  }, [layoutRef, active]);
};

type RailFit = { fits: boolean; offset: number };

const useRailFit = (bodyRef: React.RefObject<HTMLDivElement | null>): RailFit => {
  const [fit, setFit] = useState<RailFit>({ fits: false, offset: 0 });
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body || typeof ResizeObserver === "undefined") return;
    const scroller = scrollParentOf(body);
    const evaluate = () => {
      const scrollerRect = scroller.getBoundingClientRect();
      const bodyRect = body.getBoundingClientRect();
      if (bodyRect.width <= 0 || scroller.clientWidth <= 0) return;
      const anchorX =
        scrollerRect.left + scroller.clientWidth - EVIDENCE_RAIL_WIDTH - RAIL_GAP;
      const fits =
        scroller.clientWidth >= EVIDENCE_RAIL_MIN_VIEWPORT &&
        anchorX >= bodyRect.right + RAIL_GAP;
      const offset = Math.round(anchorX - bodyRect.left);
      setFit((previous) =>
        previous.fits === fits && previous.offset === offset
          ? previous
          : { fits, offset },
      );
    };
    evaluate();
    const observer = new ResizeObserver(evaluate);
    observer.observe(scroller);
    observer.observe(body);
    return () => observer.disconnect();
  }, [bodyRef]);
  return fit;
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
      { root: rail, rootMargin: "240px 0px 240px 0px" },
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
  const railFit = useRailFit(bodyRef);
  const narrow = !railFit.fits;
  const visible = useVisibleCards(railRef, narrow ? 0 : cards.length);
  const [activeBlock, setActiveBlock] = useState<number | null>(null);
  const [hosts, setHosts] = useState<{ cardId: string; host: HTMLElement }[]>([]);
  usePaintEscape(layoutRef, !narrow && cards.length > 0);

  const tethers = useMemo(() => {
    if (cards.length === 0) return new Map<string, number>();
    return tetherCardsToBlocks(splitMarkdownBlocks(text), cards);
  }, [text, cards]);

  const tetheredBlocks = useMemo(() => new Set(tethers.values()), [tethers]);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const blocks = ownChildrenOf(resolveBlockContainer(body));
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
    const blocks = ownChildrenOf(resolveBlockContainer(body));
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
    const blocks = ownChildrenOf(resolveBlockContainer(body));
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
    const container = resolveBlockContainer(body);
    const blocks = ownChildrenOf(container);
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
      else container.append(host);
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
      style={
        {
          "--evidence-rail-width": `${EVIDENCE_RAIL_WIDTH}px`,
          "--evidence-gutter": `${RAIL_GUTTER}px`,
          "--evidence-rail-gap": `${RAIL_GAP}px`,
          "--evidence-rail-offset": `${railFit.offset}px`,
        } as React.CSSProperties
      }
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
