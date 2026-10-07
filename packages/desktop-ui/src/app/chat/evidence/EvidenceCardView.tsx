import { useCallback, useState } from "react";
import type { EvidenceCard } from "@stella/contracts/chat-evidence";
import { Archive, ChevronRight, FileText, Folder } from "@/ui/icons";
import { openDisplayPayloadTab } from "@/features/workspace-display/open-payload";
import { buildPayloadFromBarePath } from "@/features/chat/lib/derive-turn-resource";
import { CompareFrame } from "./CompareFrame";
import { VideoFrame } from "./VideoFrame";
import { WaveformCard } from "./WaveformCard";

const openSource = (filePath: string) => {
  const payload = buildPayloadFromBarePath(filePath, Date.now());
  if (payload) openDisplayPayloadTab(payload);
};

const StackBody = ({ card }: { card: EvidenceCard }) => {
  const frames = card.frames ?? [];
  const [index, setIndex] = useState(0);
  const current = frames[index];
  const advance = useCallback(() => {
    setIndex((value) => (frames.length === 0 ? 0 : (value + 1) % frames.length));
  }, [frames.length]);
  return (
    <div className="evidence-stack" onClick={advance}>
      <span className="evidence-stack__shadow evidence-stack__shadow--far" />
      <span className="evidence-stack__shadow evidence-stack__shadow--near" />
      {current?.thumbnail ? (
        <img className="evidence-stack__face" src={current.thumbnail} alt={current.title} />
      ) : (
        <div className="evidence-stack__face evidence-stack__face--blank" />
      )}
      <span className="evidence-stack__counter">
        {index + 1}/{frames.length}
      </span>
    </div>
  );
};

const TableBody = ({ card }: { card: EvidenceCard }) => {
  const table = card.table;
  if (!table) return null;
  return (
    <div className="evidence-table">
      <table>
        <thead>
          <tr>
            {table.columns.map((column, columnIndex) => (
              <th key={`${column}-${columnIndex}`}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {table.columns.map((_column, columnIndex) => (
                <td key={columnIndex}>{row[columnIndex] ?? ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const BundleBody = ({ card }: { card: EvidenceCard }) => (
  <div className="evidence-bundle">
    <span className="evidence-bundle__glyph" aria-hidden="true">
      {card.sourcePaths[0]?.endsWith(".zip") ? (
        <Archive size={16} />
      ) : (
        <Folder size={16} />
      )}
    </span>
    <span className="evidence-bundle__composition">
      {(card.composition ?? []).map((entry) => (
        <span key={entry.label} className="evidence-bundle__chip">
          {entry.count} {entry.label}
        </span>
      ))}
    </span>
  </div>
);

const PlainBody = ({ card }: { card: EvidenceCard }) => (
  <div className="evidence-plain">
    <span className="evidence-plain__glyph" aria-hidden="true">
      <FileText size={15} />
    </span>
    <span className="evidence-plain__label">{card.extensionLabel}</span>
    <span className="evidence-plain__note">nothing to preview</span>
  </div>
);

const CardBody = ({ card }: { card: EvidenceCard }) => {
  if (card.kind === "image-pair" && card.thumbnail && card.thumbnailAfter) {
    return (
      <CompareFrame
        before={card.thumbnail}
        after={card.thumbnailAfter}
        title={card.title}
      />
    );
  }
  if (card.kind === "video") {
    return (
      <VideoFrame
        poster={card.thumbnail}
        filePath={card.sourcePaths[0] ?? ""}
        mimeType={card.playbackMimeType}
        durationMs={card.durationMs}
        title={card.title}
      />
    );
  }
  if (card.kind === "audio" && card.peaks) {
    return (
      <WaveformCard
        peaks={card.peaks}
        filePath={card.sourcePaths[0] ?? ""}
        mimeType={card.playbackMimeType}
        durationLabel={card.subtitle}
      />
    );
  }
  if (card.kind === "stack") return <StackBody card={card} />;
  if (card.kind === "table") return <TableBody card={card} />;
  if (card.kind === "bundle") return <BundleBody card={card} />;
  if (card.kind === "plain") return <PlainBody card={card} />;
  if (card.thumbnail) {
    return (
      <div className="evidence-raster">
        <img src={card.thumbnail} alt={card.title} draggable={false} />
      </div>
    );
  }
  return <PlainBody card={card} />;
};

export const EvidenceCardView = ({
  card,
  active,
  visible,
  onHover,
}: {
  card: EvidenceCard;
  active: boolean;
  visible: boolean;
  onHover?: (hovering: boolean) => void;
}) => {
  const openable = card.kind !== "plain" && card.kind !== "bundle";
  return (
    <article
      className="evidence-card"
      data-kind={card.kind}
      data-active={active ? "true" : undefined}
      style={{ "--evidence-card-height": `${card.height}px` } as React.CSSProperties}
      onMouseEnter={onHover ? () => onHover(true) : undefined}
      onMouseLeave={onHover ? () => onHover(false) : undefined}
    >
      <div className="evidence-card__media">{visible ? <CardBody card={card} /> : null}</div>
      <header className="evidence-card__caption">
        <span className="evidence-card__title" title={card.sourcePaths.join(", ")}>
          {card.title}
        </span>
        {card.subtitle && card.kind !== "audio" ? (
          <span className="evidence-card__subtitle">{card.subtitle}</span>
        ) : null}
      </header>
      {openable ? (
        <button
          type="button"
          className="evidence-card__open"
          aria-label={`Open ${card.title}`}
          onClick={(event) => {
            event.stopPropagation();
            const target = card.sourcePaths[card.sourcePaths.length - 1];
            if (target) openSource(target);
          }}
        >
          <ChevronRight size={12} />
        </button>
      ) : null}
    </article>
  );
};
