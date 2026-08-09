/**
 * Per-turn "end-resource" pill rendered after the assistant content.
 *
 * Clickable badge that points at the primary file the agent edited,
 * generated, or read in the turn. Click opens (or re-activates) the matching
 * tab in the workspace panel via the singleton `displayTabs` store.
 */
import { useCallback, useMemo } from "react";
import { getDisplayPayloadTitle } from "@stella/contracts/desktop/display-payload";
import { DisplayTabIcon } from "@/features/workspace-display/icons";
import { openDisplayPayloadTab, openSourceDiffBatch, } from "@/features/workspace-display/open-payload";
import { displayTabKindForPayload } from "@/features/workspace-display/payload-kind";
import { basenameOf, extensionOf, isDeveloperResourceExtension, localFilePathForPayload, } from "@/features/workspace-display/path-to-viewer";
import { OpenWithMenu } from "./OpenWithMenu";
import { useT, useTPlural } from "@/shared/i18n";
import "./end-resource-card.css";
/**
 * Subtitle for an artifact card formatted as "Category · FORMAT".
 *
 * Mirrors the way macOS Finder describes a file (kind + uppercase
 * extension). The "Category" half comes from the `DisplayPayload`
 * kind (as a catalog key the caller resolves with `t()`), the "FORMAT"
 * half from the actual file extension.
 */
const categoryAndFormatForPayload = (payload) => {
    const fmtFromPath = (filePath) => {
        const ext = extensionOf(filePath);
        return ext ? ext.toUpperCase() : null;
    };
    switch (payload.kind) {
        case "pdf":
            return { category: "app.chat.endResource.category.pdf", format: fmtFromPath(payload.filePath) };
        case "markdown":
            return { category: "app.chat.endResource.category.document", format: fmtFromPath(payload.filePath) };
        case "source-diff":
            return { category: "app.chat.endResource.category.code", format: fmtFromPath(payload.filePath) };
        case "office": {
            const ext = extensionOf(payload.previewRef.sourcePath);
            const format = ext ? ext.toUpperCase() : null;
            if (ext === "doc" || ext === "docx") {
                return { category: "app.chat.endResource.category.document", format };
            }
            if (ext === "xls" || ext === "xlsx" || ext === "xlsm") {
                return { category: "app.chat.endResource.category.spreadsheet", format };
            }
            if (ext === "ppt" || ext === "pptx") {
                return { category: "app.chat.endResource.category.slides", format };
            }
            return { category: "app.chat.endResource.category.document", format };
        }
        case "file-artifact":
            switch (payload.artifactKind) {
                case "office-document":
                    return { category: "app.chat.endResource.category.document", format: fmtFromPath(payload.filePath) };
                case "office-spreadsheet":
                    return {
                        category: "app.chat.endResource.category.spreadsheet",
                        format: fmtFromPath(payload.filePath),
                    };
                case "office-slides":
                    return { category: "app.chat.endResource.category.slides", format: fmtFromPath(payload.filePath) };
                case "delimited-table":
                    return { category: "app.chat.endResource.category.table", format: fmtFromPath(payload.filePath) };
            }
            if (isDeveloperResourceExtension(extensionOf(payload.filePath))) {
                return { category: "app.chat.endResource.category.code", format: fmtFromPath(payload.filePath) };
            }
            return { category: "app.chat.endResource.category.file", format: fmtFromPath(payload.filePath) };
        case "media": {
            switch (payload.asset.kind) {
                case "image": {
                    const first = payload.asset.filePaths[0];
                    return {
                        category: "app.chat.endResource.category.image",
                        format: first ? fmtFromPath(first) : null,
                    };
                }
                case "video":
                    return { category: "app.chat.endResource.category.video", format: fmtFromPath(payload.asset.filePath) };
                case "audio":
                    return { category: "app.chat.endResource.category.audio", format: fmtFromPath(payload.asset.filePath) };
                case "model3d":
                    return {
                        category: "app.chat.endResource.category.model3d",
                        format: fmtFromPath(payload.asset.filePath),
                    };
                case "download":
                    return { category: "app.chat.endResource.category.file", format: fmtFromPath(payload.asset.filePath) };
                case "text":
                    return { category: "app.chat.endResource.category.text", format: null };
            }
            return { category: "app.chat.endResource.category.media", format: null };
        }
        case "canvas-html":
            return { category: "app.chat.endResource.category.canvas", format: "HTML" };
        case "url":
            return { category: "app.chat.endResource.category.link", format: null };
        case "trash":
            return { category: "app.chat.endResource.category.trash", format: null };
    }
};
const labelForPayload = (payload, tPlural) => {
    switch (payload.kind) {
        case "canvas-html":
            return getDisplayPayloadTitle(payload);
        case "url":
            return payload.title;
        case "office":
            return basenameOf(payload.previewRef.sourcePath);
        case "markdown":
        case "source-diff":
            return basenameOf(payload.filePath);
        case "file-artifact":
            return basenameOf(payload.filePath);
        case "pdf":
            return basenameOf(payload.filePath);
        case "trash":
            return getDisplayPayloadTitle(payload);
        case "media":
            switch (payload.asset.kind) {
                case "image":
                    return payload.asset.filePaths.length === 1
                        ? basenameOf(payload.asset.filePaths[0])
                        : tPlural("app.chat.endResource.imageCount", payload.asset.filePaths.length);
                case "video":
                case "audio":
                case "model3d":
                case "download":
                    return basenameOf(payload.asset.filePath);
                case "text":
                    return getDisplayPayloadTitle(payload);
            }
    }
};
const tooltipForPayload = (payload) => {
    switch (payload.kind) {
        case "url":
            return payload.tooltip ?? payload.url;
        case "office":
            return payload.previewRef.sourcePath;
        case "markdown":
        case "source-diff":
            return payload.filePath;
        case "file-artifact":
            return payload.filePath;
        case "pdf":
            return payload.filePath;
        case "media":
            switch (payload.asset.kind) {
                case "image":
                    return payload.asset.filePaths.join("\n");
                case "video":
                case "audio":
                case "model3d":
                case "download":
                    return payload.asset.filePath;
                default:
                    return undefined;
            }
        default:
            return undefined;
    }
};
export const EndResourceCard = ({ payload }) => {
    const t = useT();
    const tPlural = useTPlural();
    const kind = displayTabKindForPayload(payload);
    const label = labelForPayload(payload, tPlural);
    const tooltip = tooltipForPayload(payload);
    const handleClick = useCallback(() => {
        // Opening is deferred until click because payload-backed media/canvas
        // registration has side effects in the shell tab adapter.
        openDisplayPayloadTab(payload);
    }, [payload]);
    // Source-diff payloads must always flow through `SourceDiffEndResource`
    // so the batches store is populated before the singleton tab is opened.
    // Routing them through `EndResourceCard` would open an empty / stale
    // "Code changes" tab. Guard placed after hooks so React's hook order
    // stays stable across renders.
    if (payload.kind === "source-diff")
        return null;
    const localFilePath = localFilePathForPayload(payload);
    const { category, format } = categoryAndFormatForPayload(payload);
    const categoryLabel = t(category);
    const subtitle = format ? `${categoryLabel} · ${format}` : categoryLabel;
    return (<div className="end-resource-card" title={tooltip}>
      <button type="button" className="end-resource-card__main" onClick={handleClick}>
        <span className="end-resource-card__icon">
          <DisplayTabIcon kind={kind} size={26}/>
        </span>
        <span className="end-resource-card__text">
          <span className="end-resource-card__label">{label}</span>
          <span className="end-resource-card__subtitle" aria-hidden>
            <span className="end-resource-card__subtitle-default">
              {subtitle}
            </span>
            <span className="end-resource-card__subtitle-hover">
              {t("app.chat.endResource.openPreview")}
            </span>
          </span>
        </span>
      </button>
      {localFilePath && <OpenWithMenu filePath={localFilePath}/>}
    </div>);
};
/**
 * Inline + card surface for per-turn developer file changes.
 *
 * - `batchId` keys the source-diff batch (use the assistant row's
 *   stable id so re-renders of the same turn replace the batch in
 *   place instead of stacking duplicates in the footer).
 * - When `payloads.length === 1`, renders as a quiet underlined
 *   filename.
 * - When `payloads.length > 1`, renders as the artifact card
 *   labeled "N file changes".
 * Either path pushes the batch into the source-diff store and
 * opens (or activates) the singleton "Code changes" tab.
 */
export const SourceDiffEndResource = ({ batchId, payloads, }) => {
    const t = useT();
    const tPlural = useTPlural();
    const sourceDiffPayloads = useMemo(() => payloads.filter((entry) => entry.kind === "source-diff"), [payloads]);
    const isMulti = sourceDiffPayloads.length > 1;
    const primary = sourceDiffPayloads[0];
    const createdAt = useMemo(() => {
        const latest = sourceDiffPayloads.reduce((max, entry) => entry.kind === "source-diff" && (entry.createdAt ?? 0) > max
            ? (entry.createdAt ?? 0)
            : max, 0);
        return latest > 0 ? latest : Date.now();
    }, [sourceDiffPayloads]);
    const handleClick = useCallback(() => {
        if (sourceDiffPayloads.length === 0)
            return;
        openSourceDiffBatch({
            id: batchId,
            createdAt,
            payloads: sourceDiffPayloads,
        });
    }, [batchId, createdAt, sourceDiffPayloads]);
    if (!primary)
        return null;
    if (!isMulti) {
        const tooltip = primary.kind === "source-diff" ? primary.filePath : undefined;
        const label = labelForPayload(primary, tPlural);
        return (<button type="button" className="end-resource-link" onClick={handleClick} title={tooltip}>
        <span className="end-resource-link__label">{label}</span>
      </button>);
    }
    const kind = displayTabKindForPayload(primary);
    return (<button type="button" className="end-resource-card" onClick={handleClick} title={sourceDiffPayloads
            .map((entry) => entry.kind === "source-diff" ? entry.filePath : "")
            .filter(Boolean)
            .join("\n")}>
      <span className="end-resource-card__icon">
        <DisplayTabIcon kind={kind} size={26}/>
      </span>
      <span className="end-resource-card__text">
        <span className="end-resource-card__label">
          {tPlural("app.chat.endResource.fileChangeCount", sourceDiffPayloads.length)}
        </span>
        <span className="end-resource-card__action" aria-hidden>
          {t("app.chat.endResource.openInPanel")}
        </span>
      </span>
    </button>);
};
