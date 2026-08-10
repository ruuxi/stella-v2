import {
  useState,
  useCallback,
  useRef,
  useEffect,
  useMemo,
  startTransition,
} from "react";
import { useQuery } from "convex/react";
import { Folder } from "@/ui/icons";
import { api } from "@/convex/api";
import { createServiceRequest } from "@/platform/http/service-request";
import { maybeShowPaidMediaTierToast } from "@/global/billing/paid-media-tier-toast";
import { useCapabilityAccess } from "@/global/billing/use-capability-access";
import {
  buildCapabilityRestrictionToast,
  getCapabilityLockLabel,
  getCapabilityRestrictionDescription,
  type Capability as PlanCapability,
} from "@/global/billing/capabilities";
import { showToast } from "@/ui/toast";
import {
  type FormState,
  type HistoryEntry,
  type OutputMedia,
  addHistoryEntry,
  extractOutput,
  generateThumb,
  loadFormState,
  loadHistory,
  openOutputsFolder,
  saveFormState,
  saveOutputToStella,
  updateHistoryEntry,
} from "./media-store";
import { markMediaJobMaterialized } from "./use-media-materializer";
import { fileToDataUri } from "@/features/workspace-display/media-files";
import { useT } from "@/shared/i18n";
import "./media-studio.css";

function FolderIcon() {
  return <Folder size={16} strokeWidth={1.5} />;
}

/* ── Capability catalog ── */

type Category = "image" | "audio" | "music" | "video" | "3d";

type ExtraField = {
  key: string;
  labelKey: string;
  type: "number";
  default: number;
  min?: number;
  max?: number;
};

type CapabilityDef = {
  id: string;
  nameKey: string;
  descriptionKey: string;
  category: Category;
  needsPrompt: boolean;
  needsSource: boolean;
  sourceAccept?: string;
  sourceLabelKey?: string;
  supportsAspectRatio: boolean;
  extraFields?: ExtraField[];
  profiles?: { id: string; nameKey: string }[];
};

const CATEGORIES: { id: Category; labelKey: string }[] = [
  { id: "image", labelKey: "app.media.studio.categoryImage" },
  { id: "audio", labelKey: "app.media.studio.categoryAudio" },
  { id: "music", labelKey: "app.media.studio.categoryMusic" },
  { id: "video", labelKey: "app.media.studio.categoryVideo" },
  { id: "3d", labelKey: "app.media.studio.category3d" },
];

/**
 * The plan capability each studio category needs. This map is the only
 * plan knowledge in the studio — the lock state, the badge and the copy
 * all come from the shared matrix via `useCapabilityAccess`, so flipping
 * a boolean there re-opens these tabs without touching this file.
 *
 * (Note the two senses of "capability" in this file: `CapabilityDef` is
 * a generator in the studio's own catalog; `PlanCapability` is an
 * entitlement on the user's plan.)
 */
const CATEGORY_PLAN_CAPABILITY: Record<Category, PlanCapability> = {
  image: "image_generation",
  audio: "audio_generation",
  music: "audio_generation",
  video: "video_generation",
  "3d": "three_d_generation",
};

const CAPABILITIES: CapabilityDef[] = [
  {
    id: "text_to_image",
    nameKey: "app.media.capability.textToImage.name",
    descriptionKey: "app.media.capability.textToImage.description",
    category: "image",
    needsPrompt: true,
    needsSource: false,
    supportsAspectRatio: true,
    profiles: [
      { id: "best", nameKey: "app.media.studio.profileBest" },
      { id: "fast", nameKey: "app.media.studio.profileFast" },
    ],
  },
  {
    id: "icon",
    nameKey: "app.media.capability.icon.name",
    descriptionKey: "app.media.capability.icon.description",
    category: "image",
    needsPrompt: true,
    needsSource: false,
    supportsAspectRatio: false,
  },
  {
    id: "image_edit",
    nameKey: "app.media.capability.imageEdit.name",
    descriptionKey: "app.media.capability.imageEdit.description",
    category: "image",
    needsPrompt: true,
    needsSource: true,
    sourceAccept: "image/*",
    sourceLabelKey: "app.media.studio.sourceImage",
    supportsAspectRatio: true,
  },
  {
    id: "audio_generation",
    nameKey: "app.media.capability.audioGeneration.name",
    descriptionKey: "app.media.capability.audioGeneration.description",
    category: "audio",
    needsPrompt: true,
    needsSource: false,
    supportsAspectRatio: false,
  },
  {
    id: "text_to_music",
    nameKey: "app.media.capability.textToMusic.name",
    descriptionKey: "app.media.capability.textToMusic.description",
    category: "music",
    needsPrompt: true,
    needsSource: false,
    supportsAspectRatio: false,
  },
  {
    id: "speech_to_text",
    nameKey: "app.media.capability.speechToText.name",
    descriptionKey: "app.media.capability.speechToText.description",
    category: "audio",
    needsPrompt: false,
    needsSource: true,
    sourceAccept: "audio/*",
    sourceLabelKey: "app.media.studio.sourceAudio",
    supportsAspectRatio: false,
  },
  {
    id: "text_to_video",
    nameKey: "app.media.capability.textToVideo.name",
    descriptionKey: "app.media.capability.textToVideo.description",
    category: "video",
    needsPrompt: true,
    needsSource: false,
    supportsAspectRatio: true,
  },
  {
    id: "image_to_video",
    nameKey: "app.media.capability.imageToVideo.name",
    descriptionKey: "app.media.capability.imageToVideo.description",
    category: "video",
    needsPrompt: true,
    needsSource: true,
    sourceAccept: "image/*",
    sourceLabelKey: "app.media.studio.sourceImage",
    supportsAspectRatio: true,
  },
  {
    id: "video_extend",
    nameKey: "app.media.capability.videoExtend.name",
    descriptionKey: "app.media.capability.videoExtend.description",
    category: "video",
    needsPrompt: true,
    needsSource: true,
    sourceAccept: "video/*",
    sourceLabelKey: "app.media.studio.sourceVideo",
    supportsAspectRatio: true,
  },
  {
    id: "video_to_video",
    nameKey: "app.media.capability.videoToVideo.name",
    descriptionKey: "app.media.capability.videoToVideo.description",
    category: "video",
    needsPrompt: true,
    needsSource: true,
    sourceAccept: "video/*",
    sourceLabelKey: "app.media.studio.sourceVideo",
    supportsAspectRatio: true,
    profiles: [{ id: "fast", nameKey: "app.media.studio.profileFast" }],
  },
  {
    id: "text_to_3d",
    nameKey: "app.media.capability.textTo3d.name",
    descriptionKey: "app.media.capability.textTo3d.description",
    category: "3d",
    needsPrompt: true,
    needsSource: false,
    supportsAspectRatio: false,
  },
];

const ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4"] as const;

/* ── Service ── */

type GenerateResponse = {
  jobId: string;
  capability: string;
  profile: string;
  status: string;
};

async function generateMedia(
  body: Record<string, unknown>,
  planCapability: PlanCapability,
): Promise<GenerateResponse> {
  const { endpoint, headers } = await createServiceRequest(
    "/api/media/v1/generate",
    {
      "Content-Type": "application/json",
    },
  );
  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `Generation failed (${res.status})`;
    try {
      const json = (await res.json()) as { error?: string };
      if (json.error) message = json.error;
    } catch {
      const text = await res.text().catch(() => "");
      if (text) message = text;
    }
    const error = new Error(message);
    maybeShowPaidMediaTierToast(error, planCapability);
    throw error;
  }
  return res.json() as Promise<GenerateResponse>;
}

/* ── Component ── */

export default function MediaStudio() {
  const t = useT();
  const { restrictionFor } = useCapabilityAccess();
  // Restore persisted state
  const [savedForm] = useState(loadFormState);
  const [history, setHistory] = useState(loadHistory);

  const [category, setCategory] = useState<Category>(
    savedForm.category as Category,
  );
  const [capabilityId, setCapabilityId] = useState<string | null>(
    savedForm.capabilityId,
  );
  const [prompt, setPrompt] = useState(savedForm.prompt);
  const [sourceUri, setSourceUri] = useState<string | null>(null);
  const [sourceFileName, setSourceFileName] = useState<string | null>(null);
  const [aspectRatio, setAspectRatio] = useState<string | null>(
    savedForm.aspectRatio,
  );
  const [profile, setProfile] = useState<string | null>(savedForm.profile);
  const [extraValues, setExtraValues] = useState<Record<string, number>>(
    savedForm.extraValues,
  );
  const [submitting, setSubmitting] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [viewingEntry, setViewingEntry] = useState<HistoryEntry | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCountRef = useRef(0);
  const savedJobRef = useRef<Set<string>>(new Set());

  const capability = capabilityId
    ? (CAPABILITIES.find((c) => c.id === capabilityId) ?? null)
    : null;

  const filteredCapabilities = CAPABILITIES.filter(
    (c) => c.category === category,
  );

  const sourceType = sourceUri
    ? /^data:image\//i.test(sourceUri)
      ? "image"
      : /^data:video\//i.test(sourceUri)
        ? "video"
        : /^data:audio\//i.test(sourceUri)
          ? "audio"
          : "other"
    : null;
  const sourceCompatible = capability?.needsSource
    ? (capability.sourceAccept?.startsWith(sourceType ?? "") ?? false)
    : false;

  // Convex subscription for active job
  const job = useQuery(
    api.media_jobs.getByJobId,
    activeJobId ? { jobId: activeJobId } : "skip",
  ) as Record<string, unknown> | null | undefined;

  const jobStatus = (job?.status ?? null) as string | null;
  const jobOutput = job?.output;
  const jobError = job?.error as { message?: string } | undefined;

  // When job completes, save to history + desktop/state
  useEffect(() => {
    if (!activeJobId) return;
    if (savedJobRef.current.has(activeJobId)) return;

    if (jobStatus === "succeeded" && jobOutput) {
      savedJobRef.current.add(activeJobId);
      const output = extractOutput(jobOutput);
      const updated = updateHistoryEntry(activeJobId, {
        status: "succeeded",
        output,
      });
      setHistory(updated);
      const jobIdCopy = activeJobId;
      let cancelled = false;

      // Save files to desktop/state
      void saveOutputToStella(output, jobIdCopy).then((saved) => {
        if (!cancelled && saved !== output) {
          setHistory(updateHistoryEntry(jobIdCopy, { output: saved }));
        }
      });

      // Generate thumbnail for the strip
      if (output.kind === "image" && output.urls[0]) {
        void generateThumb(output.urls[0]).then((thumb) => {
          if (!cancelled && thumb) {
            setHistory(updateHistoryEntry(jobIdCopy, { thumb }));
          }
        });
      }

      return () => {
        cancelled = true;
      };
    }

    if (jobStatus === "failed") {
      savedJobRef.current.add(activeJobId);
      setHistory(
        updateHistoryEntry(activeJobId, {
          status: "failed",
          error: jobError?.message ?? t("app.media.studio.generationFailed"),
        }),
      );
    }
  }, [activeJobId, jobStatus, jobOutput, jobError, t]);

  // Persist form state on changes
  const persistForm = useCallback((patch: Partial<FormState>) => {
    saveFormState({ ...loadFormState(), ...patch });
  }, []);

  /* ── Handlers ── */

  const handleCategoryChange = useCallback(
    (cat: Category) => {
      // Pre-emptive gate: a locked tab never opens onto a form whose
      // only possible outcome is a 402.
      const restriction = restrictionFor(CATEGORY_PLAN_CAPABILITY[cat]);
      if (restriction) {
        showToast(buildCapabilityRestrictionToast(restriction, t));
        return;
      }
      startTransition(() => {
        setCategory(cat);
        setCapabilityId(null);
        setAspectRatio(null);
        setProfile(null);
        setExtraValues({});
        setError(null);
        setActiveJobId(null);
        setViewingEntry(null);
        persistForm({
          category: cat,
          capabilityId: null,
          aspectRatio: null,
          profile: null,
          extraValues: {},
        });
      });
    },
    [persistForm, restrictionFor, t],
  );

  const handleCapabilitySelect = useCallback(
    (id: string) => {
      const cap = CAPABILITIES.find((c) => c.id === id);
      const newProfile = cap?.profiles?.[0]?.id ?? null;
      const newExtra = Object.fromEntries(
        (cap?.extraFields ?? []).map((f) => [f.key, f.default]),
      );
      startTransition(() => {
        setCapabilityId(id);
        setPrompt("");
        setAspectRatio(null);
        setError(null);
        setActiveJobId(null);
        setViewingEntry(null);
        setProfile(newProfile);
        setExtraValues(newExtra);
        persistForm({
          capabilityId: id,
          prompt: "",
          aspectRatio: null,
          profile: newProfile,
          extraValues: newExtra,
        });
      });
    },
    [persistForm],
  );

  const handlePromptChange = useCallback(
    (value: string) => {
      setPrompt(value);
      persistForm({ prompt: value });
    },
    [persistForm],
  );

  const handleAspectRatioToggle = useCallback(
    (ar: string) => {
      const next = aspectRatio === ar ? null : ar;
      setAspectRatio(next);
      persistForm({ aspectRatio: next });
    },
    [aspectRatio, persistForm],
  );

  const handleProfileChange = useCallback(
    (id: string) => {
      setProfile(id);
      persistForm({ profile: id });
    },
    [persistForm],
  );

  const ingestFile = useCallback(
    async (file: File) => {
      try {
        const dataUri = await fileToDataUri(file);
        setSourceUri(dataUri);
        setSourceFileName(file.name);
        setError(null);
      } catch {
        setError(t("app.media.studio.fileReadFailed"));
      }
    },
    [t],
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) void ingestFile(file);
    },
    [ingestFile],
  );

  const handleClearSource = useCallback(() => {
    setSourceUri(null);
    setSourceFileName(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCountRef.current += 1;
    if (dragCountRef.current === 1) setDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCountRef.current -= 1;
    if (dragCountRef.current === 0) setDragging(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragCountRef.current = 0;
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) void ingestFile(file);
    },
    [ingestFile],
  );

  const handleGenerate = useCallback(async () => {
    if (!capability) return;

    // Restored form state can point at a category the plan no longer
    // covers, so the gate is re-checked here rather than trusting the
    // tab that was open when the state was saved.
    const planCapability = CATEGORY_PLAN_CAPABILITY[capability.category];
    const restriction = restrictionFor(planCapability);
    if (restriction) {
      showToast(buildCapabilityRestrictionToast(restriction, t));
      return;
    }

    setSubmitting(true);
    setError(null);
    setActiveJobId(null);
    setViewingEntry(null);

    try {
      const body: Record<string, unknown> = {
        capability: capability.id,
        input: { ...extraValues },
      };
      if (prompt.trim()) body.prompt = prompt.trim();
      if (sourceUri) body.source = sourceUri;
      if (aspectRatio) body.aspectRatio = aspectRatio;
      if (profile) body.profile = profile;

      const result = await generateMedia(body, planCapability);

      const entry: HistoryEntry = {
        id: result.jobId,
        capability: capability.id,
        capabilityName: t(capability.nameKey),
        prompt: prompt.trim() || undefined,
        timestamp: Date.now(),
        output: null,
        status: "pending",
      };

      // Tell the global materializer to skip this job — MediaStudio will
      // present the result inline. Mark up-front (not on success) to avoid a
      // race where the materializer's subscription registers a duplicate
      // workspace media entry first.
      markMediaJobMaterialized(result.jobId);

      startTransition(() => {
        setActiveJobId(result.jobId);
        setHistory(addHistoryEntry(entry));
      });
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("app.media.studio.generationFailed"),
      );
    } finally {
      setSubmitting(false);
    }
  }, [
    capability,
    prompt,
    sourceUri,
    aspectRatio,
    profile,
    extraValues,
    restrictionFor,
    t,
  ]);

  const handleHistoryClick = useCallback((entry: HistoryEntry) => {
    setViewingEntry(entry);
    setActiveJobId(null);
  }, []);

  const handleCopyImage = useCallback(async (url: string) => {
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const pngBlob =
        blob.type === "image/png"
          ? blob
          : await new Promise<Blob>((resolve) => {
              const img = new Image();
              img.crossOrigin = "anonymous";
              img.onload = () => {
                const canvas = document.createElement("canvas");
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                canvas.getContext("2d")!.drawImage(img, 0, 0);
                canvas.toBlob((b) => resolve(b!), "image/png");
              };
              img.src = url;
            });
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": pngBlob }),
      ]);
    } catch {
      // silent fail
    }
  }, []);

  /** Load an output URL as the source and switch to a target capability. */
  const handleSendTo = useCallback(
    (targetCapId: string, url: string) => {
      const cap = CAPABILITIES.find((c) => c.id === targetCapId);
      if (!cap) return;
      const targetCat = cap.category as Category;

      // Infer a file name from the URL
      const urlName = url.split("/").pop()?.split("?")[0] ?? "output";

      startTransition(() => {
        setCategory(targetCat);
        setCapabilityId(targetCapId);
        setSourceUri(url);
        setSourceFileName(urlName);
        setPrompt("");
        setAspectRatio(null);
        setError(null);
        setActiveJobId(null);
        setViewingEntry(null);
        setProfile(cap.profiles?.[0]?.id ?? null);
        setExtraValues(
          Object.fromEntries(
            (cap.extraFields ?? []).map((f) => [f.key, f.default]),
          ),
        );
        persistForm({
          category: targetCat,
          capabilityId: targetCapId,
          prompt: "",
          aspectRatio: null,
          profile: cap.profiles?.[0]?.id ?? null,
          extraValues: Object.fromEntries(
            (cap.extraFields ?? []).map((f) => [f.key, f.default]),
          ),
        });
      });
    },
    [persistForm],
  );

  const canSubmit =
    capability &&
    !submitting &&
    (!capability.needsPrompt || prompt.trim().length > 0) &&
    (!capability.needsSource || (sourceUri !== null && sourceCompatible));

  // Determine what to show in the output panel
  const liveOutput = useMemo(
    () =>
      activeJobId && jobStatus === "succeeded" && jobOutput
        ? extractOutput(jobOutput)
        : null,
    [activeJobId, jobStatus, jobOutput],
  );
  const activeOutput: OutputMedia | null = viewingEntry?.output ?? liveOutput;

  const showPending =
    activeJobId &&
    !viewingEntry &&
    (jobStatus === "queued" || jobStatus === "running");
  const showFailed =
    (activeJobId && !viewingEntry && jobStatus === "failed") ||
    viewingEntry?.status === "failed";
  const showOutput = activeOutput && activeOutput.kind !== "unknown";
  const failMessage =
    viewingEntry?.error ??
    jobError?.message ??
    t("app.media.studio.generationFailed");

  return (
    <div
      className={`ms ${dragging ? "ms--dragging" : ""}`}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* ── Left: controls ── */}
      <div className="ms-controls">
        <div className="ms-controls-header">
          <h1 className="ms-title">
            <em>{t("app.media.studio.title")}</em>
          </h1>
          <p className="ms-lead">{t("app.media.studio.lead")}</p>
        </div>

        <nav className="ms-categories">
          {CATEGORIES.map((cat) => {
            // Annotated rather than removed: a locked tab still tells
            // the user the feature exists and which plan carries it.
            // `aria-disabled` over `disabled` keeps it focusable, so the
            // explanation is reachable from the keyboard too.
            const restriction = restrictionFor(
              CATEGORY_PLAN_CAPABILITY[cat.id],
            );
            return (
              <button
                key={cat.id}
                type="button"
                className={`ms-category ${category === cat.id ? "ms-category--active" : ""}`}
                data-locked={restriction ? "" : undefined}
                aria-disabled={restriction ? true : undefined}
                title={
                  restriction
                    ? getCapabilityRestrictionDescription(restriction, t)
                    : undefined
                }
                onClick={() => handleCategoryChange(cat.id)}
              >
                {t(cat.labelKey)}
                {restriction ? (
                  <span className="ms-category-lock">
                    {getCapabilityLockLabel(restriction, t)}
                  </span>
                ) : null}
              </button>
            );
          })}
        </nav>

        <div className="ms-controls-body">
          {/* Capability list */}
          <div className="ms-capabilities">
            {filteredCapabilities.map((cap) => (
              <button
                key={cap.id}
                type="button"
                className={`ms-capability ${capabilityId === cap.id ? "ms-capability--active" : ""}`}
                onClick={() => handleCapabilitySelect(cap.id)}
              >
                <span className="ms-capability-name">{t(cap.nameKey)}</span>
                <span className="ms-capability-desc">
                  {t(cap.descriptionKey)}
                </span>
              </button>
            ))}
          </div>

          {/* Form */}
          {capability && (
            <>
              <hr className="ms-rule" />
              <div className="ms-form">
                {capability.profiles && capability.profiles.length > 1 && (
                  <div className="ms-field">
                    <label className="ms-label">
                      {t("app.media.studio.quality")}
                    </label>
                    <div className="ms-tags">
                      {capability.profiles.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          className={`ms-tag ${profile === p.id ? "ms-tag--active" : ""}`}
                          onClick={() => handleProfileChange(p.id)}
                        >
                          {t(p.nameKey)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {capability.needsPrompt && (
                  <div className="ms-field">
                    <label className="ms-label">
                      {t("app.media.studio.prompt")}
                    </label>
                    <textarea
                      className="ms-textarea"
                      value={prompt}
                      onChange={(e) => handlePromptChange(e.target.value)}
                      placeholder={t("app.media.studio.promptPlaceholder")}
                      rows={3}
                    />
                  </div>
                )}

                {capability.needsSource && (
                  <div className="ms-field">
                    <label className="ms-label">
                      {capability.sourceLabelKey
                        ? t(capability.sourceLabelKey)
                        : t("app.media.studio.sourceFile")}
                    </label>
                    {sourceFileName && sourceCompatible ? (
                      <div className="ms-source-info">
                        {sourceType === "image" && sourceUri && (
                          <img
                            src={sourceUri}
                            alt=""
                            className="ms-source-preview"
                          />
                        )}
                        <span className="ms-source-name">{sourceFileName}</span>
                        <button
                          type="button"
                          className="ms-source-clear"
                          onClick={handleClearSource}
                        >
                          ✕
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="ms-upload"
                        onClick={() => fileInputRef.current?.click()}
                      >
                        {sourceFileName
                          ? t("app.media.studio.chooseDifferentFile")
                          : t("app.media.studio.chooseFile")}
                      </button>
                    )}
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept={capability.sourceAccept}
                      onChange={handleFileChange}
                      className="ms-file-input"
                    />
                  </div>
                )}

                {capability.supportsAspectRatio && (
                  <div className="ms-field">
                    <label className="ms-label">
                      {t("app.media.studio.aspectRatio")}
                    </label>
                    <div className="ms-tags">
                      {ASPECT_RATIOS.map((ar) => (
                        <button
                          key={ar}
                          type="button"
                          className={`ms-tag ${aspectRatio === ar ? "ms-tag--active" : ""}`}
                          onClick={() => handleAspectRatioToggle(ar)}
                        >
                          {ar}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {capability.extraFields?.map((field) => (
                  <div key={field.key} className="ms-field">
                    <label className="ms-label">{t(field.labelKey)}</label>
                    <input
                      type="number"
                      className="ms-number-input"
                      value={extraValues[field.key] ?? field.default}
                      min={field.min}
                      max={field.max}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        setExtraValues((prev) => {
                          const next = { ...prev, [field.key]: val };
                          persistForm({ extraValues: next });
                          return next;
                        });
                      }}
                    />
                  </div>
                ))}

                <button
                  type="button"
                  className="ms-generate"
                  disabled={!canSubmit}
                  onClick={handleGenerate}
                >
                  {submitting
                    ? t("app.media.studio.submitting")
                    : t("app.media.studio.generate")}
                </button>

                {error && <p className="ms-error">{error}</p>}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Right: output + history strip ── */}
      <div className="ms-right">
        <div className="ms-output-panel">
          {dragging && (
            <div className="ms-drop-overlay">
              <div className="ms-drop-label">
                {t("app.media.studio.dropFile")}
              </div>
            </div>
          )}

          {!showPending && !showFailed && !showOutput && !dragging && (
            <div className="ms-empty">
              <div className="ms-empty-title">
                {t("app.media.studio.emptyTitle")}
              </div>
              <div className="ms-empty-desc">
                {t("app.media.studio.emptyDescription")}
              </div>
            </div>
          )}

          {showPending && (
            <div className="ms-status">
              <span className="ms-status-dot" />
              <span className="ms-status-text">
                {jobStatus === "queued"
                  ? t("app.media.studio.queued")
                  : t("app.media.studio.generating")}
              </span>
            </div>
          )}

          {showFailed && <p className="ms-error">{failMessage}</p>}

          {showOutput && activeOutput && (
            <div className="ms-output">
              {activeOutput.kind === "image" && (
                <>
                  <div className="ms-output-images">
                    {activeOutput.urls.map((url, i) => (
                      <button
                        key={url}
                        type="button"
                        className="ms-output-image-btn"
                        onClick={() => setLightboxUrl(url)}
                      >
                        <img
                          src={url}
                          alt={t("app.media.studio.generatedAlt", {
                            index: i + 1,
                          })}
                          className="ms-output-image"
                        />
                      </button>
                    ))}
                  </div>
                  <div className="ms-actions">
                    <button
                      type="button"
                      className="ms-action"
                      onClick={() => void handleCopyImage(activeOutput.urls[0])}
                    >
                      {t("app.media.studio.copy")}
                    </button>
                    <button
                      type="button"
                      className="ms-action"
                      onClick={() =>
                        handleSendTo("image_edit", activeOutput.urls[0])
                      }
                    >
                      {t("app.media.studio.edit")}
                    </button>
                    <button
                      type="button"
                      className="ms-action"
                      onClick={() =>
                        handleSendTo("image_to_video", activeOutput.urls[0])
                      }
                    >
                      {t("app.media.studio.animate")}
                    </button>
                  </div>
                </>
              )}
              {activeOutput.kind === "video" && (
                <>
                  <video
                    src={activeOutput.url}
                    controls
                    className="ms-output-video"
                  />
                  <div className="ms-actions">
                    <button
                      type="button"
                      className="ms-action"
                      onClick={() =>
                        handleSendTo("video_to_video", activeOutput.url)
                      }
                    >
                      {t("app.media.studio.transformVideo")}
                    </button>
                    <button
                      type="button"
                      className="ms-action"
                      onClick={() =>
                        handleSendTo("video_extend", activeOutput.url)
                      }
                    >
                      {t("app.media.studio.extendVideo")}
                    </button>
                  </div>
                </>
              )}
              {activeOutput.kind === "audio" && (
                <audio
                  src={activeOutput.url}
                  controls
                  className="ms-output-audio"
                />
              )}
              {activeOutput.kind === "text" && (
                <div className="ms-output-text">
                  <p>{activeOutput.text}</p>
                </div>
              )}
              {activeOutput.kind === "download" && (
                <a
                  href={activeOutput.url}
                  target="_blank"
                  rel="noreferrer"
                  className="ms-output-download"
                >
                  {activeOutput.label}
                </a>
              )}
            </div>
          )}
        </div>

        {/* History strip */}
        {history.length > 0 && (
          <div className="ms-strip">
            <div className="ms-strip-scroll">
              {history.map((entry) => {
                const isActive =
                  viewingEntry?.id === entry.id || activeJobId === entry.id;
                const thumbSrc = entry.thumb ?? null;

                return (
                  <button
                    key={entry.id}
                    type="button"
                    className={`ms-strip-item ${isActive ? "ms-strip-item--active" : ""}`}
                    onClick={() => handleHistoryClick(entry)}
                    title={entry.prompt ?? entry.capabilityName}
                  >
                    {thumbSrc ? (
                      <img src={thumbSrc} alt="" className="ms-strip-thumb" />
                    ) : (
                      <div
                        className={`ms-strip-placeholder ms-strip-placeholder--${entry.output?.kind ?? "pending"}`}
                      >
                        {entry.status === "pending" && (
                          <span className="ms-strip-dot" />
                        )}
                        {entry.status === "failed" && "✕"}
                        {entry.status === "succeeded" &&
                          entry.output?.kind === "video" &&
                          "▶"}
                        {entry.status === "succeeded" &&
                          entry.output?.kind === "audio" &&
                          "♪"}
                        {entry.status === "succeeded" &&
                          entry.output?.kind === "text" &&
                          "Aa"}
                        {entry.status === "succeeded" &&
                          entry.output?.kind === "download" &&
                          "↓"}
                        {entry.status === "succeeded" &&
                          entry.output?.kind === "unknown" &&
                          "?"}
                      </div>
                    )}
                    <span className="ms-strip-label">
                      {entry.capabilityName}
                    </span>
                  </button>
                );
              })}
              <button
                type="button"
                className="ms-strip-folder"
                onClick={() => void openOutputsFolder()}
                title={t("app.media.studio.openOutputsFolder")}
              >
                <FolderIcon />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Lightbox */}
      {lightboxUrl && (
        <div className="ms-lightbox" onClick={() => setLightboxUrl(null)}>
          <img
            src={lightboxUrl}
            alt=""
            className="ms-lightbox-img"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            className="ms-lightbox-close"
            onClick={() => setLightboxUrl(null)}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
