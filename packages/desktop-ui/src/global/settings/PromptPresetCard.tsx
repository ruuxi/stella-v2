import { useCallback, useEffect, useState } from "react";
import { Button } from "@/ui/button";
import { Select } from "@/ui/select";
import { useT } from "@/shared/i18n";
import { getSettingsErrorMessage } from "./tabs/shared";
import "./PromptPresetCard.css";

const DEFAULT_PRESET_ID = "default";

const PROMPT_AGENTS = [
  { id: "orchestrator", labelKey: "settings.systemPrompt.agents.assistant" },
  { id: "general", labelKey: "settings.systemPrompt.agents.worker" },
] as const;

type PromptAgentId = (typeof PROMPT_AGENTS)[number]["id"];

type PresetSummary = { id: string; name: string; agentId: string };

type Status = { kind: "info" | "error"; message: string } | null;

export function PromptPresetCard() {
  const t = useT();
  const [agentId, setAgentId] = useState<PromptAgentId>("orchestrator");
  const [presets, setPresets] = useState<PresetSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string>(DEFAULT_PRESET_ID);
  const [editing, setEditing] = useState<{
    id?: string;
    name: string;
    content: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  const api = () => window.electronAPI?.system;

  const refresh = useCallback(
    async (nextAgentId: PromptAgentId) => {
      const systemApi = api();
      if (!systemApi?.listPromptPresets) return;
      try {
        const result = await systemApi.listPromptPresets(nextAgentId);
        setPresets(result.presets);
        setSelectedId(result.selectedId || DEFAULT_PRESET_ID);
      } catch (error) {
        setStatus({
          kind: "error",
          message: getSettingsErrorMessage(
            error,
            t("settings.systemPrompt.error"),
          ),
        });
      }
    },
    [t],
  );

  useEffect(() => {
    setEditing(null);
    setStatus(null);
    void refresh(agentId);
  }, [agentId, refresh]);

  const handleSelect = useCallback(
    async (nextId: string) => {
      const systemApi = api();
      if (!systemApi?.selectPromptPreset) return;
      const previous = selectedId;
      setSelectedId(nextId);
      setEditing(null);
      setStatus(null);
      setBusy(true);
      try {
        const result = await systemApi.selectPromptPreset(agentId, nextId);
        setSelectedId(result.selectedId || DEFAULT_PRESET_ID);
        if (!result.ok) {
          setStatus({
            kind: "error",
            message: t("settings.systemPrompt.error"),
          });
          await refresh(agentId);
        }
      } catch (error) {
        setSelectedId(previous);
        setStatus({
          kind: "error",
          message: getSettingsErrorMessage(
            error,
            t("settings.systemPrompt.error"),
          ),
        });
      } finally {
        setBusy(false);
      }
    },
    [agentId, refresh, selectedId, t],
  );

  const openEditor = useCallback(
    async (mode: "edit" | "duplicate" | "new") => {
      const systemApi = api();
      if (!systemApi?.readPromptPreset) return;
      setBusy(true);
      setStatus(null);
      try {
        const sourceId =
          mode === "edit" || mode === "duplicate"
            ? selectedId
            : DEFAULT_PRESET_ID;
        const source = await systemApi.readPromptPreset(agentId, sourceId);
        const content = source?.content ?? "";
        if (mode === "edit" && selectedId !== DEFAULT_PRESET_ID) {
          setEditing({
            id: selectedId,
            name: source?.name ?? selectedId,
            content,
          });
        } else {
          const base =
            mode === "duplicate" && source?.name
              ? source.name
              : t("settings.systemPrompt.newName");
          setEditing({ name: `${base} copy`.trim(), content });
        }
      } catch (error) {
        setStatus({
          kind: "error",
          message: getSettingsErrorMessage(
            error,
            t("settings.systemPrompt.error"),
          ),
        });
      } finally {
        setBusy(false);
      }
    },
    [agentId, selectedId, t],
  );

  const handleSave = useCallback(async () => {
    const systemApi = api();
    if (!systemApi?.savePromptPreset || !editing) return;
    setBusy(true);
    setStatus(null);
    try {
      const result = await systemApi.savePromptPreset({
        agentId,
        ...(editing.id ? { id: editing.id } : {}),
        name: editing.name,
        content: editing.content,
        select: true,
      });
      if (!result.ok) {
        setStatus({ kind: "error", message: result.error });
        return;
      }
      setEditing(null);
      await refresh(agentId);
      setStatus({ kind: "info", message: t("settings.systemPrompt.saved") });
    } catch (error) {
      setStatus({
        kind: "error",
        message: getSettingsErrorMessage(
          error,
          t("settings.systemPrompt.error"),
        ),
      });
    } finally {
      setBusy(false);
    }
  }, [agentId, editing, refresh, t]);

  const handleDelete = useCallback(async () => {
    const systemApi = api();
    if (!systemApi?.deletePromptPreset || selectedId === DEFAULT_PRESET_ID) {
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      await systemApi.deletePromptPreset(agentId, selectedId);
      setEditing(null);
      await refresh(agentId);
      setStatus({ kind: "info", message: t("settings.systemPrompt.deleted") });
    } catch (error) {
      setStatus({
        kind: "error",
        message: getSettingsErrorMessage(
          error,
          t("settings.systemPrompt.error"),
        ),
      });
    } finally {
      setBusy(false);
    }
  }, [agentId, refresh, selectedId, t]);

  const usingDefault = selectedId === DEFAULT_PRESET_ID;

  return (
    <div className="settings-card">
      <h3 className="settings-card-title">
        {t("settings.systemPrompt.title")}
      </h3>
      <p
        className={
          status?.kind === "error"
            ? "settings-card-desc settings-card-desc--error"
            : "settings-card-desc"
        }
        role={status?.kind === "error" ? "alert" : undefined}
      >
        {status?.message ?? t("settings.systemPrompt.description")}
      </p>

      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-label">
            {t("settings.systemPrompt.agentLabel")}
          </div>
          <div className="settings-row-sublabel">
            {t("settings.systemPrompt.agentSublabel")}
          </div>
        </div>
        <div className="settings-row-control">
          <Select
            className="settings-runtime-select"
            value={agentId}
            disabled={busy}
            aria-label={t("settings.systemPrompt.agentLabel")}
            onValueChange={(value) => {
              if (value === "orchestrator" || value === "general") {
                setAgentId(value);
              }
            }}
            options={PROMPT_AGENTS.map((agent) => ({
              value: agent.id,
              label: t(agent.labelKey),
            }))}
          />
        </div>
      </div>

      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-label">
            {t("settings.systemPrompt.activeLabel")}
          </div>
          <div className="settings-row-sublabel">
            {usingDefault
              ? t("settings.systemPrompt.usingDefault")
              : t("settings.systemPrompt.usingCustom")}
          </div>
        </div>
        <div className="settings-row-control">
          <Select
            className="settings-runtime-select"
            value={selectedId}
            disabled={busy}
            aria-label={t("settings.systemPrompt.activeLabel")}
            onValueChange={(value) => void handleSelect(value)}
            options={[
              {
                value: DEFAULT_PRESET_ID,
                label: t("settings.systemPrompt.defaultOption"),
              },
              ...presets.map((preset) => ({
                value: preset.id,
                label: preset.name,
              })),
            ]}
          />
        </div>
      </div>

      {editing ? (
        <div className="prompt-preset-editor">
          <input
            className="prompt-preset-name-input"
            value={editing.name}
            disabled={busy}
            aria-label={t("settings.systemPrompt.nameLabel")}
            placeholder={t("settings.systemPrompt.nameLabel")}
            onChange={(event) =>
              setEditing({ ...editing, name: event.target.value })
            }
          />
          <textarea
            className="prompt-preset-textarea"
            value={editing.content}
            disabled={busy}
            spellCheck={false}
            aria-label={t("settings.systemPrompt.title")}
            onChange={(event) =>
              setEditing({ ...editing, content: event.target.value })
            }
          />
          <div className="prompt-preset-actions">
            <Button
              type="button"
              className="pill-btn"
              disabled={busy}
              onClick={() => void handleSave()}
            >
              {t("settings.systemPrompt.save")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="pill-btn"
              disabled={busy}
              onClick={() => setEditing(null)}
            >
              {t("settings.systemPrompt.cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="prompt-preset-actions">
          <Button
            type="button"
            variant="ghost"
            className="pill-btn"
            disabled={busy}
            onClick={() => void openEditor("new")}
          >
            {t("settings.systemPrompt.newFromDefault")}
          </Button>
          {!usingDefault ? (
            <>
              <Button
                type="button"
                variant="ghost"
                className="pill-btn"
                disabled={busy}
                onClick={() => void openEditor("edit")}
              >
                {t("settings.systemPrompt.edit")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="pill-btn"
                disabled={busy}
                onClick={() => void openEditor("duplicate")}
              >
                {t("settings.systemPrompt.duplicate")}
              </Button>
              <span className="prompt-preset-actions-spacer" />
              <Button
                type="button"
                variant="ghost"
                className="pill-btn"
                disabled={busy}
                onClick={() => void handleDelete()}
              >
                {t("settings.systemPrompt.delete")}
              </Button>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
