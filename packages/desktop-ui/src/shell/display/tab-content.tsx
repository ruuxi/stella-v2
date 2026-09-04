/**
 * Per-kind viewer components used by the workspace panel's tab manager.
 *
 * Each component is a thin wrapper that delegates to the existing card UI
 * (MediaPreviewCard sub-renderers, OfficePreviewCard, PdfViewerCard). The
 * wrappers exist so the tab spec's `render()` function can be a single
 * `createElement(Component, props)` call — no per-call branching, no
 * `kind` discriminator inside the render path.
 *
 * The media viewer is its own world (preview, prompt, action bar) and
 * lives in `./media-tab/`.
 */

import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import type { OfficePreviewRef } from "@stella/contracts/office-preview";
import { useDisplayFileBytes } from "@/shared/hooks/use-display-file-data";
import { useT } from "@/shared/i18n";
import { openExternalUrl } from "@/platform/electron/open-external";
import { useFilePreviewActions } from "@/features/chat/hooks/use-file-preview-actions";
import type { DisplayPayload } from "@stella/contracts/desktop/display-payload";
import { DELIMITED_PREVIEW_MAX_BYTES } from "@/shell/display/parse-delimited-rows";
import {
  sourceDiffBatches,
  useSourceDiffBatches,
  type SourceDiffBatch,
} from "@/features/workspace-display/source-diff-batches";

import { DIFF_PREVIEW_MAX_BYTES, type PreviewResult } from "./preview-parser";
import { usePreviewParser } from "./use-preview-parser";
import { usePreviewWindow } from "./use-preview-window";

// Heavy, payload-specific renderers are lazy-loaded so they stay out of the
// always-eager shell's first-paint module graph (dev server transforms every
// statically-reachable module before first paint). Their `createElement`
// closures only run when a tab of the matching kind actually opens, so the
// chunks are fetched on demand.
const PdfViewerCard = lazy(() =>
  import("@/app/chat/PdfViewerCard").then((m) => ({
    default: m.PdfViewerCard,
  })),
);
const Markdown = lazy(() =>
  import("@/app/chat/Markdown").then((m) => ({ default: m.Markdown })),
);
const MediaPreviewCard = lazy(() =>
  import("@/shell/MediaPreviewCard").then((m) => ({
    default: m.MediaPreviewCard,
  })),
);
const OfficeArtifactPanel = lazy(() =>
  import("./office-artifact-panel").then((m) => ({
    default: m.OfficeArtifactPanel,
  })),
);

type WithMediaMeta = {
  prompt?: string;
  capability?: string;
};

export { MediaTabContent } from "./media-tab";

/**
 * Live URL preview tab. An iframe pointed at a dev server, with a tiny
 * reload affordance so the user can force a refresh when the page does
 * not hot-reload on its own.
 */
export const UrlTabContent = ({
  url,
  title,
}: {
  url: string;
  title: string;
}) => {
  const t = useT();
  const [reloadKey, setReloadKey] = useState(0);
  return (
    <div className="right-sidebar__rich right-sidebar__rich--url">
      <header className="display-file-preview__header">
        <div className="display-file-preview__title-group">
          <span className="display-file-preview__eyebrow">
            {t("shell.display.url.eyebrow")}
          </span>
          <div className="display-file-preview__title" title={url}>
            {title}
          </div>
        </div>
        <div className="display-file-preview__actions">
          <button
            type="button"
            onClick={() => setReloadKey((value) => value + 1)}
          >
            {t("shell.display.url.reload")}
          </button>
          <button
            type="button"
            onClick={() => {
              openExternalUrl(url);
            }}
          >
            {t("shell.display.url.openInBrowser")}
          </button>
        </div>
      </header>
      <iframe
        key={reloadKey}
        src={url}
        title={title}
        className="display-url-iframe"
        sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-modals"
        referrerPolicy="no-referrer"
      />
    </div>
  );
};

export { TrashTabContent } from "./TrashTabContent";

export const OfficeTabContent = ({
  previewRef,
}: {
  previewRef: OfficePreviewRef;
}) => (
  <div className="right-sidebar__rich">
    <Suspense fallback={null}>
      <OfficeArtifactPanel previewRef={previewRef} />
    </Suspense>
  </div>
);

const startOfficePreviewForPath = (
  filePath: string,
): Promise<OfficePreviewRef> => {
  return (async () => {
    const api = window.electronAPI?.officePreview;
    if (typeof api?.start !== "function") {
      throw new Error("Office previews require the Stella desktop app.");
    }
    return await api.start(filePath);
  })();
};

export const OfficeFileTabContent = ({
  filePath,
  title,
  refreshToken,
}: {
  filePath: string;
  title?: string;
  refreshToken?: number;
}) => {
  const t = useT();
  const [previewRef, setPreviewRef] = useState<OfficePreviewRef | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPreviewRef(null);
    setError(null);
    void startOfficePreviewForPath(filePath)
      .then((ref) => {
        if (!cancelled) setPreviewRef(title ? { ...ref, title } : ref);
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [filePath, title, refreshToken]);

  if (previewRef) {
    return <OfficeTabContent previewRef={previewRef} />;
  }

  return (
    <div className="right-sidebar__rich">
      <section className="display-artifact-panel">
        <div className="display-artifact-panel__body">
          <div className="display-artifact-status">
            <div
              className={
                error
                  ? "display-artifact-status__text"
                  : "display-artifact-status__text loading-shimmer-pure-text"
              }
              title={filePath}
            >
              {error || t("shell.display.office.preparing")}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};

const textDecoder = new TextDecoder("utf-8");

const PreviewLimitNotice = () => (
  <div className="display-preview-limit" role="status">
    Preview limited. Save or open the original file to view all content.
  </div>
);

export const DelimitedTableTabContent = ({
  filePath,
  title,
}: {
  filePath: string;
  title?: string;
}) => {
  const t = useT();
  const { bytes, error, loading, truncated } = useDisplayFileBytes(
    filePath,
    t("shell.display.spreadsheet.desktopRequired"),
    undefined,
    undefined,
    DELIMITED_PREVIEW_MAX_BYTES,
  );
  const delimiter: "," | "\t" = filePath.toLowerCase().endsWith(".tsv")
    ? "\t"
    : ",";
  const request = useMemo(
    () =>
      bytes
        ? {
            kind: "table" as const,
            bytes,
            delimiter,
            truncated,
          }
        : null,
    [bytes, delimiter, truncated],
  );
  const parsed = usePreviewParser(request);
  const rows = parsed?.result?.rows ?? [];
  const windowed = usePreviewWindow(Math.max(0, rows.length - 1), 32);
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const header = rows[0] ?? [];
  const body = rows.slice(1);
  const { actionStatus, handleSave, handleCopy } = useFilePreviewActions({
    sourcePath: filePath,
    suggestedName: title ?? filePath.split(/[\\/]/).pop() ?? "data.csv",
  });

  return (
    <div className="right-sidebar__rich right-sidebar__rich--table">
      <section className="display-file-preview display-file-preview--table">
        <header className="display-file-preview__header">
          <div className="display-file-preview__title-group">
            <span className="display-file-preview__eyebrow">
              {t("shell.display.spreadsheet.eyebrow")}
            </span>
            <div className="display-file-preview__title" title={filePath}>
              {title ??
                filePath.split(/[\\/]/).pop() ??
                t("shell.display.spreadsheet.eyebrow")}
            </div>
          </div>
          <div className="display-file-preview__actions">
            <button type="button" onClick={handleSave}>
              {t("shell.display.filePreview.save")}
            </button>
            <button type="button" onClick={handleCopy}>
              {t("shell.display.filePreview.copy")}
            </button>
            {actionStatus && <span>{actionStatus}</span>}
          </div>
        </header>
        {error || parsed?.error ? (
          <div className="display-file-preview__error">
            {error || parsed?.error}
          </div>
        ) : loading || (request && !parsed) ? (
          <div className="display-file-preview__empty">
            {t("common.loading")}
          </div>
        ) : rows.length === 0 ? (
          <div className="display-file-preview__empty">
            {t("shell.display.spreadsheet.noRows")}
          </div>
        ) : (
          <div
            className="display-file-preview__table-wrap"
            onScroll={windowed.onScroll}
            style={{
              height: Math.min(480, (body.length + 1) * 32),
              flex: "0 1 auto",
            }}
          >
            <table
              className="display-file-preview__table display-file-preview__table--virtual"
              aria-rowcount={rows.length}
              style={{ width: columnCount * 160 }}
            >
              <colgroup>
                {Array.from({ length: columnCount }, (_, index) => (
                  <col key={index} style={{ width: 160 }} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  {Array.from({ length: columnCount }, (_, index) => (
                    <th key={index}>
                      {header[index] ||
                        t("shell.display.spreadsheet.column", {
                          index: index + 1,
                        })}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {windowed.top > 0 && (
                  <tr aria-hidden="true">
                    <td
                      colSpan={columnCount}
                      style={{ height: windowed.top, padding: 0, border: 0 }}
                    />
                  </tr>
                )}
                {body
                  .slice(windowed.start, windowed.end)
                  .map((row, rowIndex) => (
                    <tr
                      key={windowed.start + rowIndex}
                      aria-rowindex={windowed.start + rowIndex + 2}
                    >
                      {Array.from({ length: columnCount }, (_, colIndex) => (
                        <td key={colIndex}>{row[colIndex] ?? ""}</td>
                      ))}
                    </tr>
                  ))}
                {windowed.bottom > 0 && (
                  <tr aria-hidden="true">
                    <td
                      colSpan={columnCount}
                      style={{ height: windowed.bottom, padding: 0, border: 0 }}
                    />
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        {parsed?.result?.limited && <PreviewLimitNotice />}
      </section>
    </div>
  );
};

export const PdfTabContent = ({
  filePath,
  title,
}: {
  filePath: string;
  title?: string;
}) => (
  <div className="right-sidebar__rich right-sidebar__rich--pdf">
    <Suspense fallback={null}>
      <PdfViewerCard filePath={filePath} {...(title ? { title } : {})} />
    </Suspense>
  </div>
);

const decodeTextBytes = (bytes: Uint8Array | null): string =>
  bytes ? textDecoder.decode(bytes) : "";

export const MarkdownTabContent = ({
  filePath,
  title,
}: {
  filePath: string;
  title?: string;
}) => {
  const t = useT();
  const { bytes, error, loading } = useDisplayFileBytes(
    filePath,
    t("shell.display.markdown.desktopRequired"),
  );
  const markdown = useMemo(() => decodeTextBytes(bytes), [bytes]);
  const { actionStatus, handleSave, handleCopy } = useFilePreviewActions({
    sourcePath: filePath,
    copyText: markdown,
    suggestedName: title ?? filePath.split(/[\\/]/).pop() ?? "document.md",
  });

  return (
    <div className="right-sidebar__rich right-sidebar__rich--markdown">
      <section className="display-file-preview display-file-preview--markdown">
        <header className="display-file-preview__header">
          <div className="display-file-preview__title-group">
            <span className="display-file-preview__eyebrow">
              {t("shell.display.markdown.eyebrow")}
            </span>
            <div className="display-file-preview__title" title={filePath}>
              {title ??
                filePath.split(/[\\/]/).pop() ??
                t("shell.display.markdown.eyebrow")}
            </div>
          </div>
          <div className="display-file-preview__actions">
            <button type="button" onClick={handleSave}>
              {t("shell.display.filePreview.save")}
            </button>
            <button type="button" onClick={handleCopy}>
              {t("shell.display.filePreview.copy")}
            </button>
            {actionStatus && <span>{actionStatus}</span>}
          </div>
        </header>
        <div className="display-markdown-viewer">
          {error ? (
            <div className="display-file-preview__error">{error}</div>
          ) : loading ? (
            <div className="display-file-preview__empty">
              {t("shell.display.filePreview.loading")}
            </div>
          ) : markdown.trim().length === 0 ? (
            <div className="display-file-preview__empty">
              {t("shell.display.markdown.noContent")}
            </div>
          ) : (
            <Suspense fallback={null}>
              <Markdown text={markdown} />
            </Suspense>
          )}
        </div>
      </section>
    </div>
  );
};

const DiffRows = ({ preview }: { preview: PreviewResult }) => {
  const windowed = usePreviewWindow(preview.lines.length, 24);
  return (
    <>
      <div
        className="display-diff-viewer__files display-diff-viewer__files--virtual"
        onScroll={windowed.onScroll}
        style={{ height: windowed.height }}
      >
        <div style={{ height: windowed.top }} aria-hidden="true" />
        {preview.lines.slice(windowed.start, windowed.end).map((line, index) =>
          line.kind === "header" ? (
            <header
              key={windowed.start + index}
              className="display-diff-file__header"
            >
              {line.text}
            </header>
          ) : (
            <div
              key={windowed.start + index}
              className={`display-diff-line display-diff-line--${line.kind}`}
            >
              <span className="display-diff-line__marker">
                {line.kind === "add"
                  ? "+"
                  : line.kind === "delete"
                    ? "-"
                    : line.kind === "meta"
                      ? "@"
                      : " "}
              </span>
              <code>{line.text || " "}</code>
            </div>
          ),
        )}
        <div style={{ height: windowed.bottom }} aria-hidden="true" />
      </div>
      {preview.limited && <PreviewLimitNotice />}
    </>
  );
};

type SourceDiffPayload = Extract<DisplayPayload, { kind: "source-diff" }>;

const ParsedDiff = ({
  parsed,
}: {
  parsed: ReturnType<typeof usePreviewParser>;
}) => {
  const t = useT();
  if (parsed?.error)
    return <div className="display-file-preview__error">{parsed.error}</div>;
  if (!parsed?.result)
    return (
      <div className="display-file-preview__empty">
        {t("shell.display.filePreview.loading")}
      </div>
    );
  if (!parsed.result.lines.length && !parsed.result.limited)
    return (
      <div className="display-file-preview__empty">
        {t("shell.display.diff.noChanges")}
      </div>
    );
  return <DiffRows preview={parsed.result} />;
};

const SourceDiffPatchBlock = ({ patch }: { patch: string }) => {
  // Cap before structured cloning to avoid sending an enormous patch to the worker.
  const request = useMemo(
    () => ({
      kind: "diff" as const,
      patch: patch.slice(0, DIFF_PREVIEW_MAX_BYTES),
      filePath: "",
      truncated: patch.length > DIFF_PREVIEW_MAX_BYTES,
    }),
    [patch],
  );
  return <ParsedDiff parsed={usePreviewParser(request)} />;
};

const SourceDiffFileBytesBlock = ({ filePath }: { filePath: string }) => {
  const t = useT();
  const { bytes, error, truncated } = useDisplayFileBytes(
    filePath,
    t("shell.display.diff.desktopRequired"),
    undefined,
    undefined,
    DIFF_PREVIEW_MAX_BYTES,
  );
  const request = useMemo(
    () =>
      bytes ? { kind: "diff" as const, bytes, filePath, truncated } : null,
    [bytes, filePath, truncated],
  );
  const parsed = usePreviewParser(request);
  if (error) return <div className="display-file-preview__error">{error}</div>;
  return <ParsedDiff parsed={parsed} />;
};

const SourceDiffFileBlock = ({ payload }: { payload: SourceDiffPayload }) => {
  if (payload.patch && payload.patch.trim().length > 0) {
    return <SourceDiffPatchBlock patch={payload.patch} />;
  }
  return <SourceDiffFileBytesBlock filePath={payload.filePath} />;
};

const formatRelativeTime = (timestamp: number, now: number): string => {
  const delta = Math.max(0, now - timestamp);
  if (delta < 45_000) return "just now";
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
};

const useNowTick = (intervalMs: number): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
};

const SourceDiffBatchFooter = ({
  batches,
  activeBatchId,
  now,
}: {
  batches: ReadonlyArray<SourceDiffBatch>;
  activeBatchId: string | null;
  now: number;
}) => {
  if (batches.length <= 1) return null;
  return (
    <footer className="display-diff-batches-footer">
      {batches.map((batch) => {
        const isActive = batch.id === activeBatchId;
        const fileLabel =
          batch.payloads.length === 1
            ? "1 file"
            : `${batch.payloads.length} files`;
        const label = batch.label ?? fileLabel;
        return (
          <button
            key={batch.id}
            type="button"
            className={`display-diff-batches-chip${
              isActive ? " display-diff-batches-chip--active" : ""
            }`}
            onClick={() => sourceDiffBatches.select(batch.id)}
            title={batch.payloads
              .filter(
                (entry): entry is SourceDiffPayload =>
                  entry.kind === "source-diff",
              )
              .map((entry) => entry.filePath)
              .join("\n")}
          >
            <span className="display-diff-batches-chip__label">{label}</span>
            <span className="display-diff-batches-chip__time">
              {formatRelativeTime(batch.createdAt, now)}
            </span>
          </button>
        );
      })}
    </footer>
  );
};

export const SourceDiffTabContent = () => {
  const t = useT();
  const { batches, activeBatchId } = useSourceDiffBatches();
  const now = useNowTick(30_000);

  const activeBatch = useMemo(() => {
    if (batches.length === 0) return null;
    const byId = batches.find((entry) => entry.id === activeBatchId);
    return byId ?? batches[0]!;
  }, [batches, activeBatchId]);

  const headerLabel = activeBatch
    ? activeBatch.payloads.length === 1
      ? activeBatch.payloads[0]!.kind === "source-diff"
        ? ((activeBatch.payloads[0] as SourceDiffPayload).filePath
            .split(/[\\/]/)
            .pop() ?? t("shell.display.diff.changes"))
        : t("shell.display.diff.changes")
      : `${activeBatch.payloads.length} files changed`
    : t("shell.display.diff.codeChanges");

  return (
    <div className="right-sidebar__rich right-sidebar__rich--diff">
      <section className="display-file-preview display-file-preview--diff">
        <header className="display-file-preview__header">
          <div className="display-file-preview__title-group">
            <span className="display-file-preview__eyebrow">
              {t("shell.display.diff.changes")}
            </span>
            <div className="display-file-preview__title" title={headerLabel}>
              {headerLabel}
            </div>
          </div>
        </header>
        <div className="display-diff-batches-body">
          {!activeBatch ? (
            <div className="display-file-preview__empty">
              {t("shell.display.diff.empty")}
            </div>
          ) : (
            <div className="display-diff-batches-body__scroll">
              {activeBatch.payloads
                .filter(
                  (payload): payload is SourceDiffPayload =>
                    payload.kind === "source-diff",
                )
                .map((payload) => (
                  <SourceDiffFileBlock
                    key={payload.filePath}
                    payload={payload}
                  />
                ))}
            </div>
          )}
        </div>
        <SourceDiffBatchFooter
          batches={batches}
          activeBatchId={activeBatchId}
          now={now}
        />
      </section>
    </div>
  );
};

export const ImageTabContent = ({
  filePaths,
  prompt,
  capability,
}: { filePaths: string[] } & WithMediaMeta) => (
  <div className="right-sidebar__rich right-sidebar__rich--media">
    <Suspense fallback={null}>
      <MediaPreviewCard
        asset={{ kind: "image", filePaths }}
        {...(prompt ? { prompt } : {})}
        {...(capability ? { capability } : {})}
      />
    </Suspense>
  </div>
);

export const VideoTabContent = ({
  filePath,
  prompt,
  capability,
}: { filePath: string } & WithMediaMeta) => (
  <div className="right-sidebar__rich right-sidebar__rich--media">
    <Suspense fallback={null}>
      <MediaPreviewCard
        asset={{ kind: "video", filePath }}
        {...(prompt ? { prompt } : {})}
        {...(capability ? { capability } : {})}
      />
    </Suspense>
  </div>
);

export const AudioTabContent = ({
  filePath,
  prompt,
  capability,
}: { filePath: string } & WithMediaMeta) => (
  <div className="right-sidebar__rich right-sidebar__rich--media">
    <Suspense fallback={null}>
      <MediaPreviewCard
        asset={{ kind: "audio", filePath }}
        {...(prompt ? { prompt } : {})}
        {...(capability ? { capability } : {})}
      />
    </Suspense>
  </div>
);

export const Model3dTabContent = ({
  filePath,
  label,
  prompt,
  capability,
}: { filePath: string; label?: string } & WithMediaMeta) => (
  <div className="right-sidebar__rich right-sidebar__rich--media">
    <Suspense fallback={null}>
      <MediaPreviewCard
        asset={{ kind: "model3d", filePath, ...(label ? { label } : {}) }}
        {...(prompt ? { prompt } : {})}
        {...(capability ? { capability } : {})}
      />
    </Suspense>
  </div>
);

export const DownloadTabContent = ({
  filePath,
  label,
  prompt,
  capability,
}: { filePath: string; label: string } & WithMediaMeta) => (
  <div className="right-sidebar__rich right-sidebar__rich--media">
    <Suspense fallback={null}>
      <MediaPreviewCard
        asset={{ kind: "download", filePath, label }}
        {...(prompt ? { prompt } : {})}
        {...(capability ? { capability } : {})}
      />
    </Suspense>
  </div>
);

export const TextTabContent = ({
  text,
  prompt,
  capability,
}: { text: string } & WithMediaMeta) => (
  <div className="right-sidebar__rich right-sidebar__rich--media">
    <Suspense fallback={null}>
      <MediaPreviewCard
        asset={{ kind: "text", text }}
        {...(prompt ? { prompt } : {})}
        {...(capability ? { capability } : {})}
      />
    </Suspense>
  </div>
);
