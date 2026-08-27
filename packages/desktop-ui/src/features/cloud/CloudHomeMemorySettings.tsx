import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { CloudMemoryDocument } from "@stella/contracts/cloud-home-sync";
import type { CloudMemoryWipeStatus } from "./cloud-home-api";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Download } from "@/ui/icons";
import { TextField } from "@/ui/text-field";
import { useT } from "@/shared/i18n";
import {
  cloudMemoryDownloadPayload,
  CloudHomeMemoryError,
} from "./cloud-home-memory-client";
import { useCloudHomeMemory } from "./use-cloud-home-memory";

type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

type MemorySummary = Pick<
  CloudMemoryDocument,
  "name" | "displayPath" | "kind" | "revision" | "sizeBytes" | "updatedAt"
>;

type VisibleProblem = Readonly<{
  code: CloudHomeMemoryError["code"] | "missing" | "download";
  message: string;
}>;

type OpenMemoryAuthority = Readonly<{
  expectedSubject: string;
  ownerGeneration: string;
  memoryEpoch: string;
  lifecycleState: "open";
}>;

const visibleProblem = (error: unknown, t: Translate): VisibleProblem => {
  const code =
    error instanceof CloudHomeMemoryError ? error.code : ("network" as const);
  return { code, message: t(`mobile.cloudHome.errors.${code}`) };
};

const summarize = (document: CloudMemoryDocument): MemorySummary => ({
  name: document.name,
  displayPath: document.displayPath,
  kind: document.kind,
  revision: document.revision,
  sizeBytes: document.sizeBytes,
  updatedAt: document.updatedAt,
});

const openAuthority = (
  expectedSubject: string,
  lifecycle: CloudMemoryWipeStatus | null,
): OpenMemoryAuthority | null =>
  lifecycle?.state === "open" && lifecycle.subject === expectedSubject
    ? {
        expectedSubject,
        ownerGeneration: lifecycle.ownerGeneration,
        memoryEpoch: lifecycle.memoryEpoch,
        lifecycleState: "open",
      }
    : null;

const sameAuthority = (
  left: OpenMemoryAuthority | null,
  right: OpenMemoryAuthority | null,
): boolean =>
  Boolean(
    left &&
    right &&
    left.expectedSubject === right.expectedSubject &&
    left.ownerGeneration === right.ownerGeneration &&
    left.memoryEpoch === right.memoryEpoch &&
    left.lifecycleState === right.lifecycleState,
  );

const formatBytes = (sizeBytes: number, t: Translate): string =>
  sizeBytes < 1024
    ? t("mobile.cloudHome.sizes.bytes", { count: sizeBytes })
    : sizeBytes < 1024 * 1024
      ? t("mobile.cloudHome.sizes.kilobytes", {
          count: Math.ceil(sizeBytes / 1024),
        })
      : t("mobile.cloudHome.sizes.megabytes", {
          count: (sizeBytes / (1024 * 1024)).toFixed(1),
        });

const formatKind = (kind: CloudMemoryDocument["kind"], t: Translate): string =>
  t(`mobile.cloudHome.kinds.${kind}`);

const editorStyle = {
  fontFamily: "var(--font-family-mono, monospace)",
  fontSize: "var(--font-size-sm)",
  lineHeight: 1.55,
  maxHeight: "48vh",
  minHeight: 300,
  overflow: "auto",
  resize: "vertical" as const,
};

/**
 * Browse/edit/download for cloud-canonical memory documents. This surface is
 * intentionally independent of the Memory context preference: turning Memory
 * off stops future prompt injection, but never locks the owner's documents.
 */
export function CloudHomeMemorySettings() {
  const t = useT();
  const {
    identity,
    lifecycle,
    available,
    loading: capabilityLoading,
    unavailable,
    listMemory,
    writeMemory,
  } = useCloudHomeMemory();
  const identityKey = identity
    ? `${identity.accountScope}:${identity.identityRevision}:${identity.expectedSubject}`
    : null;
  const lifecycleKey = lifecycle
    ? JSON.stringify([
        lifecycle.subject,
        lifecycle.ownerGeneration,
        lifecycle.memoryEpoch,
        lifecycle.state,
      ])
    : null;
  const activeIdentityRef = useRef<string | null>(null);
  const activeLifecycleRef = useRef<CloudMemoryWipeStatus | null>(null);
  const requestEpoch = useRef(0);
  const exportEpoch = useRef(0);
  const pendingExportIdRef = useRef<string | null>(null);
  const [summaries, setSummaries] = useState<MemorySummary[]>([]);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loadingDocuments, setLoadingDocuments] = useState(false);
  const [openingName, setOpeningName] = useState<string | null>(null);
  const [selected, setSelected] = useState<CloudMemoryDocument | null>(null);
  const [selectedOwnerGeneration, setSelectedOwnerGeneration] = useState<
    string | null
  >(null);
  const [selectedMemoryEpoch, setSelectedMemoryEpoch] = useState<string | null>(
    null,
  );
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [problem, setProblem] = useState<VisibleProblem | null>(null);
  const [conflict, setConflict] = useState<
    CloudMemoryDocument | null | undefined
  >(undefined);
  const [notice, setNotice] = useState<string | null>(null);

  const isCurrent = useCallback(
    (epoch: number, owner: string | null) =>
      requestEpoch.current === epoch && activeIdentityRef.current === owner,
    [],
  );

  const isExportCurrent = useCallback(
    (epoch: number, owner: string | null, authority: OpenMemoryAuthority) =>
      exportEpoch.current === epoch &&
      activeIdentityRef.current === owner &&
      sameAuthority(
        openAuthority(authority.expectedSubject, activeLifecycleRef.current),
        authority,
      ),
    [],
  );

  const cancelPendingExport = useCallback(() => {
    const exportId = pendingExportIdRef.current;
    pendingExportIdRef.current = null;
    const cancel = window.electronAPI?.cloudHome.cancelMemoryExport;
    if (exportId && cancel) void cancel(exportId).catch(() => undefined);
  }, []);

  const refreshDocuments = useCallback(async () => {
    if (!identityKey || !identity || !available) return;
    const authorityAtStart = openAuthority(
      identity.expectedSubject,
      activeLifecycleRef.current,
    );
    if (!authorityAtStart) return;
    const ownerAtStart = identityKey;
    const epoch = ++requestEpoch.current;
    setLoadingDocuments(true);
    setProblem(null);
    try {
      const snapshot = await listMemory();
      if (!isCurrent(epoch, ownerAtStart)) return;
      const authorityNow = openAuthority(
        authorityAtStart.expectedSubject,
        activeLifecycleRef.current,
      );
      if (
        !sameAuthority(authorityAtStart, authorityNow) ||
        snapshot.ownerGeneration !== authorityAtStart.ownerGeneration ||
        snapshot.memoryEpoch !== authorityAtStart.memoryEpoch
      ) {
        throw new CloudHomeMemoryError("invalid");
      }
      setSummaries(snapshot.documents.map(summarize));
      setHasLoaded(true);
    } catch (error) {
      if (isCurrent(epoch, ownerAtStart)) {
        setProblem(visibleProblem(error, t));
        setHasLoaded(true);
      }
    } finally {
      if (isCurrent(epoch, ownerAtStart)) setLoadingDocuments(false);
    }
  }, [available, identity, identityKey, isCurrent, listMemory, t]);

  useLayoutEffect(() => {
    activeIdentityRef.current = identityKey;
    requestEpoch.current += 1;
    exportEpoch.current += 1;
    cancelPendingExport();
    setSummaries([]);
    setHasLoaded(false);
    setLoadingDocuments(false);
    setOpeningName(null);
    setSelected(null);
    setSelectedOwnerGeneration(null);
    setSelectedMemoryEpoch(null);
    setDraft("");
    setSaving(false);
    setDownloading(false);
    setProblem(null);
    setConflict(undefined);
    setNotice(null);
    return () => {
      activeIdentityRef.current = null;
      requestEpoch.current += 1;
      exportEpoch.current += 1;
      cancelPendingExport();
    };
  }, [cancelPendingExport, identityKey]);

  useLayoutEffect(() => {
    activeLifecycleRef.current = lifecycle;
  }, [lifecycle]);

  useLayoutEffect(() => {
    requestEpoch.current += 1;
    exportEpoch.current += 1;
    cancelPendingExport();
    setSummaries([]);
    setHasLoaded(false);
    setLoadingDocuments(false);
    setOpeningName(null);
    setSelected(null);
    setSelectedOwnerGeneration(null);
    setSelectedMemoryEpoch(null);
    setDraft("");
    setSaving(false);
    setDownloading(false);
    setProblem(null);
    setConflict(undefined);
    setNotice(null);
  }, [cancelPendingExport, lifecycleKey]);

  useLayoutEffect(() => {
    if (identityKey && available) void refreshDocuments();
    return () => {
      requestEpoch.current += 1;
    };
  }, [available, identityKey, lifecycleKey, refreshDocuments]);

  const openDocument = useCallback(
    async (name: string) => {
      if (!identityKey || !identity || !available) return;
      const authorityAtStart = openAuthority(
        identity.expectedSubject,
        activeLifecycleRef.current,
      );
      if (!authorityAtStart) return;
      const ownerAtStart = identityKey;
      const epoch = ++requestEpoch.current;
      setOpeningName(name);
      setProblem(null);
      setConflict(undefined);
      setNotice(null);
      try {
        const snapshot = await listMemory();
        if (!isCurrent(epoch, ownerAtStart)) return;
        const authorityNow = openAuthority(
          authorityAtStart.expectedSubject,
          activeLifecycleRef.current,
        );
        if (
          !sameAuthority(authorityAtStart, authorityNow) ||
          snapshot.ownerGeneration !== authorityAtStart.ownerGeneration ||
          snapshot.memoryEpoch !== authorityAtStart.memoryEpoch
        ) {
          throw new CloudHomeMemoryError("invalid");
        }
        setSummaries(snapshot.documents.map(summarize));
        const document = snapshot.documents.find(
          (candidate) => candidate.name === name,
        );
        if (!document) {
          setProblem({
            code: "missing",
            message: t("mobile.cloudHome.errors.missingFromList"),
          });
          return;
        }
        setSelected(document);
        setSelectedOwnerGeneration(snapshot.ownerGeneration);
        setSelectedMemoryEpoch(snapshot.memoryEpoch);
        setDraft(document.content);
      } catch (error) {
        if (isCurrent(epoch, ownerAtStart)) {
          setProblem(visibleProblem(error, t));
        }
      } finally {
        if (isCurrent(epoch, ownerAtStart)) setOpeningName(null);
      }
    },
    [available, identity, identityKey, isCurrent, listMemory, t],
  );

  const saveDocument = useCallback(async () => {
    if (
      !selected ||
      !selectedOwnerGeneration ||
      !selectedMemoryEpoch ||
      !identityKey ||
      !identity ||
      draft === selected.content ||
      saving ||
      downloading
    ) {
      return;
    }
    const authorityAtStart = openAuthority(
      identity.expectedSubject,
      activeLifecycleRef.current,
    );
    if (
      !authorityAtStart ||
      authorityAtStart.ownerGeneration !== selectedOwnerGeneration ||
      authorityAtStart.memoryEpoch !== selectedMemoryEpoch
    ) {
      return;
    }
    const ownerAtStart = identityKey;
    const base = selected;
    const draftAtStart = draft;
    const epoch = ++requestEpoch.current;
    setSaving(true);
    setProblem(null);
    setConflict(undefined);
    setNotice(null);
    try {
      const result = await writeMemory({
        ownerGeneration: selectedOwnerGeneration,
        memoryEpoch: selectedMemoryEpoch,
        document: base,
        content: draftAtStart,
      });
      if (!isCurrent(epoch, ownerAtStart)) return;
      if (result.status === "committed") {
        setSelected(result.document);
        setDraft(result.document.content);
        setSummaries((current) =>
          current.map((summary) =>
            summary.name === result.document.name
              ? summarize(result.document)
              : summary,
          ),
        );
        setNotice(t("mobile.cloudHome.notices.saved"));
        return;
      }
      // The server's head is shown as context only. The textarea deliberately
      // keeps draftAtStart until the owner explicitly chooses reload below.
      setConflict(result.document);
    } catch (error) {
      if (isCurrent(epoch, ownerAtStart)) {
        setProblem(visibleProblem(error, t));
      }
    } finally {
      if (isCurrent(epoch, ownerAtStart)) setSaving(false);
    }
  }, [
    draft,
    downloading,
    identity,
    identityKey,
    isCurrent,
    saving,
    selected,
    selectedMemoryEpoch,
    selectedOwnerGeneration,
    t,
    writeMemory,
  ]);

  const reloadCloudVersion = useCallback(async () => {
    if (!selected || !identityKey || !identity || saving || downloading) {
      return;
    }
    const authorityAtStart = openAuthority(
      identity.expectedSubject,
      activeLifecycleRef.current,
    );
    if (!authorityAtStart) return;
    const ownerAtStart = identityKey;
    const name = selected.name;
    const epoch = ++requestEpoch.current;
    setOpeningName(name);
    setProblem(null);
    setNotice(null);
    try {
      const snapshot = await listMemory();
      if (!isCurrent(epoch, ownerAtStart)) return;
      const authorityNow = openAuthority(
        authorityAtStart.expectedSubject,
        activeLifecycleRef.current,
      );
      if (
        !sameAuthority(authorityAtStart, authorityNow) ||
        snapshot.ownerGeneration !== authorityAtStart.ownerGeneration ||
        snapshot.memoryEpoch !== authorityAtStart.memoryEpoch
      ) {
        throw new CloudHomeMemoryError("invalid");
      }
      setSummaries(snapshot.documents.map(summarize));
      const latest = snapshot.documents.find(
        (candidate) => candidate.name === name,
      );
      if (!latest) {
        setConflict(null);
        setProblem({
          code: "missing",
          message: t("mobile.cloudHome.errors.removedWhileEditing"),
        });
        return;
      }
      setSelected(latest);
      setSelectedOwnerGeneration(snapshot.ownerGeneration);
      setSelectedMemoryEpoch(snapshot.memoryEpoch);
      setDraft(latest.content);
      setConflict(undefined);
      setNotice(t("mobile.cloudHome.notices.loadedLatest"));
    } catch (error) {
      if (isCurrent(epoch, ownerAtStart)) {
        setProblem(visibleProblem(error, t));
      }
    } finally {
      if (isCurrent(epoch, ownerAtStart)) setOpeningName(null);
    }
  }, [
    downloading,
    identity,
    identityKey,
    isCurrent,
    listMemory,
    saving,
    selected,
    t,
  ]);

  const downloadDocument = useCallback(async () => {
    if (
      !selected ||
      !selectedOwnerGeneration ||
      !selectedMemoryEpoch ||
      !identityKey ||
      !identity ||
      downloading ||
      saving ||
      openingName !== null
    ) {
      return;
    }
    const bridge = window.electronAPI?.cloudHome;
    if (
      !bridge?.beginMemoryExport ||
      !bridge.commitMemoryExport ||
      !bridge.cancelMemoryExport
    ) {
      setProblem({
        code: "download",
        message: t("mobile.cloudHome.errors.unavailable"),
      });
      return;
    }
    const authorityAtStart = openAuthority(
      identity.expectedSubject,
      activeLifecycleRef.current,
    );
    if (
      !authorityAtStart ||
      authorityAtStart.ownerGeneration !== selectedOwnerGeneration ||
      authorityAtStart.memoryEpoch !== selectedMemoryEpoch
    ) {
      return;
    }
    const ownerAtStart = identityKey;
    const epoch = ++exportEpoch.current;
    const downloadPayload = cloudMemoryDownloadPayload({
      ...selected,
      content: draft,
    });
    let exportId: string | null = null;
    setDownloading(true);
    setProblem(null);
    try {
      // The picker receives no content. Its destination remains behind a
      // short-lived opaque id until a fresh subject/gen/epoch-fenced GET has
      // verified that this is still the open cloud Memory lifecycle.
      const selection = await bridge.beginMemoryExport({
        suggestedName: downloadPayload.suggestedName,
        ...authorityAtStart,
      });
      if (!selection.ok) return;
      exportId = selection.exportId;
      pendingExportIdRef.current = exportId;
      if (!isExportCurrent(epoch, ownerAtStart, authorityAtStart)) {
        await bridge.cancelMemoryExport(exportId);
        return;
      }

      const snapshot = await listMemory();
      if (!isExportCurrent(epoch, ownerAtStart, authorityAtStart)) {
        await bridge.cancelMemoryExport(exportId);
        return;
      }
      if (
        snapshot.ownerGeneration !== authorityAtStart.ownerGeneration ||
        snapshot.memoryEpoch !== authorityAtStart.memoryEpoch
      ) {
        await bridge.cancelMemoryExport(exportId);
        requestEpoch.current += 1;
        exportEpoch.current += 1;
        setSummaries([]);
        setHasLoaded(false);
        setSelected(null);
        setSelectedOwnerGeneration(null);
        setSelectedMemoryEpoch(null);
        setDraft("");
        setConflict(undefined);
        setNotice(null);
        setProblem(visibleProblem(new CloudHomeMemoryError("invalid"), t));
        return;
      }

      const result = await bridge.commitMemoryExport({
        exportId,
        content: downloadPayload.content,
        ...authorityAtStart,
      });
      if (pendingExportIdRef.current === exportId) {
        pendingExportIdRef.current = null;
      }
      if (
        isExportCurrent(epoch, ownerAtStart, authorityAtStart) &&
        !result.ok
      ) {
        setProblem({
          code: "download",
          message: t("mobile.cloudHome.errors.unavailable"),
        });
      }
    } catch {
      if (exportId) {
        await bridge.cancelMemoryExport(exportId).catch(() => undefined);
      }
      if (isExportCurrent(epoch, ownerAtStart, authorityAtStart)) {
        setProblem({
          code: "download",
          message: t("mobile.cloudHome.errors.unavailable"),
        });
      }
    } finally {
      if (exportId && pendingExportIdRef.current === exportId) {
        pendingExportIdRef.current = null;
      }
      if (isExportCurrent(epoch, ownerAtStart, authorityAtStart)) {
        setDownloading(false);
      }
    }
  }, [
    downloading,
    draft,
    identity,
    identityKey,
    isExportCurrent,
    listMemory,
    openingName,
    saving,
    selected,
    selectedMemoryEpoch,
    selectedOwnerGeneration,
    t,
  ]);

  const closeEditor = useCallback(() => {
    requestEpoch.current += 1;
    exportEpoch.current += 1;
    cancelPendingExport();
    setSelected(null);
    setSelectedOwnerGeneration(null);
    setSelectedMemoryEpoch(null);
    setDraft("");
    setSaving(false);
    setDownloading(false);
    setProblem(null);
    setConflict(undefined);
    setNotice(null);
    setOpeningName(null);
  }, [cancelPendingExport]);

  if (!identity) return null;

  const dirty = Boolean(selected && draft !== selected.content);
  const conflictVisible = conflict !== undefined;

  return (
    <>
      <div className="settings-card" data-cloud-home-memory-documents>
        <h3 className="settings-card-title">
          {t("mobile.cloudHome.settingsRowTitle")}
        </h3>
        <p className="settings-card-desc">
          {t("mobile.cloudHome.settingsRowBody")}
        </p>
        {capabilityLoading ? (
          <div className="settings-row-sublabel" role="status">
            {t("mobile.cloudHome.loading")}
          </div>
        ) : unavailable ? (
          <div className="settings-row-sublabel" role="alert">
            {t("mobile.cloudHome.unavailableBody")}
          </div>
        ) : problem && !selected ? (
          <div className="settings-row">
            <div className="settings-row-info">
              <div className="settings-row-sublabel" role="alert">
                {problem.message}
              </div>
            </div>
            <div className="settings-row-control">
              <Button
                type="button"
                variant="ghost"
                className="pill-btn"
                onClick={() => void refreshDocuments()}
              >
                {t("mobile.cloudHome.list.retry")}
              </Button>
            </div>
          </div>
        ) : null}
        {loadingDocuments ? (
          <div className="settings-row-sublabel" role="status">
            {t("mobile.cloudHome.list.loading")}
          </div>
        ) : hasLoaded && summaries.length === 0 && !problem ? (
          <div className="settings-row">
            <div className="settings-row-info">
              <div className="settings-row-label">
                {t("mobile.cloudHome.list.emptyTitle")}
              </div>
              <div className="settings-row-sublabel">
                {t("mobile.cloudHome.list.emptyBody")}
              </div>
            </div>
          </div>
        ) : (
          summaries.map((summary) => (
            <div className="settings-row" key={summary.name}>
              <div className="settings-row-info">
                <div className="settings-row-label">{summary.name}</div>
                <div
                  className="settings-row-sublabel"
                  style={{
                    fontFamily: "var(--font-family-mono, monospace)",
                    overflowWrap: "anywhere",
                  }}
                >
                  {summary.displayPath}
                </div>
                <div className="settings-row-sublabel">
                  {t("mobile.cloudHome.listMeta", {
                    kind: formatKind(summary.kind, t),
                    revision: summary.revision,
                    size: formatBytes(summary.sizeBytes, t),
                  })}
                </div>
              </div>
              <div className="settings-row-control">
                <Button
                  type="button"
                  variant="ghost"
                  className="pill-btn"
                  aria-label={t("mobile.cloudHome.list.openDocumentLabel", {
                    name: summary.name,
                  })}
                  disabled={openingName !== null || saving || downloading}
                  onClick={() => void openDocument(summary.name)}
                >
                  {openingName === summary.name
                    ? t("common.loading")
                    : t("common.open")}
                </Button>
              </div>
            </div>
          ))
        )}
      </div>

      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) closeEditor();
        }}
      >
        <DialogContent size="lg" aria-describedby={undefined}>
          {selected ? (
            <>
              <DialogHeader>
                <DialogTitle>{selected.name}</DialogTitle>
              </DialogHeader>
              <DialogDescription>
                {selected.displayPath}
                {" · "}
                {t("mobile.cloudHome.editorMeta", {
                  kind: formatKind(selected.kind, t),
                  revision: selected.revision,
                })}
              </DialogDescription>
              {conflictVisible ? (
                <div role="alert" style={{ marginTop: 14 }}>
                  <div className="settings-row-label">
                    {t("mobile.cloudHome.conflict.title")}
                  </div>
                  <div className="settings-row-sublabel">
                    {conflict
                      ? t("mobile.cloudHome.conflict.changedBody", {
                          revision: conflict.revision,
                        })
                      : t("mobile.cloudHome.conflict.removedBody")}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    className="pill-btn"
                    style={{ marginTop: 10 }}
                    disabled={
                      openingName === selected.name || saving || downloading
                    }
                    onClick={() => void reloadCloudVersion()}
                  >
                    {openingName === selected.name
                      ? t("mobile.cloudHome.conflict.reloading")
                      : t("mobile.cloudHome.conflict.reload")}
                  </Button>
                </div>
              ) : null}
              {problem ? (
                <div
                  className="settings-card-desc settings-card-desc--error"
                  role="alert"
                  style={{ marginTop: 14 }}
                >
                  {problem.message}
                </div>
              ) : null}
              {notice ? (
                <div
                  className="settings-row-sublabel"
                  role="status"
                  style={{ marginTop: 14 }}
                >
                  {notice}
                </div>
              ) : null}
              <div style={{ marginTop: 16 }}>
                <TextField
                  multiline
                  label={t("mobile.cloudHome.editor.editLabel", {
                    name: selected.name,
                  })}
                  hideLabel
                  value={draft}
                  disabled={
                    saving || downloading || openingName === selected.name
                  }
                  spellCheck={false}
                  autoCapitalize="none"
                  autoCorrect="off"
                  style={editorStyle}
                  onChange={(event) => {
                    setDraft(event.currentTarget.value);
                    setNotice(null);
                  }}
                />
              </div>
              <div
                className="settings-row-sublabel"
                role="status"
                style={{ marginTop: 8 }}
              >
                {dirty
                  ? t("mobile.cloudHome.editor.unsaved")
                  : t("mobile.cloudHome.editor.upToDate")}
              </div>
              <div
                className="settings-confirm-actions"
                style={{ marginTop: 18 }}
              >
                <Button
                  type="button"
                  variant="ghost"
                  className="pill-btn"
                  data-action="download-cloud-memory"
                  aria-label={`${t("common.save")} ${selected.name}`}
                  disabled={downloading || saving || openingName !== null}
                  onClick={() => void downloadDocument()}
                >
                  <Download size={15} aria-hidden="true" />
                  {t("common.save")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="pill-btn"
                  disabled={saving}
                  onClick={closeEditor}
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  className="pill-btn"
                  data-action="save-cloud-memory"
                  disabled={
                    !dirty || saving || downloading || openingName !== null
                  }
                  onClick={() => void saveDocument()}
                >
                  {saving
                    ? t("mobile.cloudHome.editor.saving")
                    : t("mobile.cloudHome.editor.save")}
                </Button>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
