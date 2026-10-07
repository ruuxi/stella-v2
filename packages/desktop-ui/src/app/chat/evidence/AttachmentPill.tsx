import type { EvidenceCard } from "@stella/contracts/chat-evidence";
import { Archive, FileSpreadsheet, FileText, Folder, Globe } from "@/ui/icons";
import { openDisplayPayloadTab } from "@/features/workspace-display/open-payload";
import { buildPayloadFromBarePath } from "@/features/chat/lib/derive-turn-resource";

const GlyphFor = ({ card }: { card: EvidenceCard }) => {
  if (card.kind === "table") return <FileSpreadsheet size={13} />;
  if (card.kind === "page") return <Globe size={13} />;
  if (card.kind === "bundle") {
    return card.sourcePaths[0]?.toLowerCase().endsWith(".zip") ? (
      <Archive size={13} />
    ) : (
      <Folder size={13} />
    );
  }
  return <FileText size={13} />;
};

export const AttachmentPill = ({ card }: { card: EvidenceCard }) => (
  <button
    type="button"
    className="attachment-pill"
    data-kind={card.kind}
    title={card.sourcePaths.join(", ")}
    onClick={() => {
      const target = card.sourcePaths[0];
      if (!target) return;
      const payload = buildPayloadFromBarePath(target, Date.now());
      if (payload) openDisplayPayloadTab(payload);
    }}
  >
    <span className="attachment-pill__glyph" aria-hidden="true">
      <GlyphFor card={card} />
    </span>
    <span className="attachment-pill__title">{card.title}</span>
    {card.subtitle ? (
      <span className="attachment-pill__meta">{card.subtitle}</span>
    ) : null}
  </button>
);
