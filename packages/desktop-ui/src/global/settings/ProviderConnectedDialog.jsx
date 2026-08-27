import { useCallback, useEffect, useMemo, useState } from "react";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle, } from "@/ui/dialog";
import { Button } from "@/ui/button";
import { PROVIDER_CREDENTIALS } from "@/global/settings/lib/llm-providers";
import { PROVIDER_CONNECTED_EVENT, } from "@/global/settings/hooks/use-llm-credentials";
import { useT } from "@/shared/i18n";
import "./ProviderConnectedDialog.css";
const ASSISTANT_AGENT_KEYS = ["orchestrator", "general"];

const PROVIDER_SURFACES = {
    openai: { assistant: true, image: "openai", voice: "openai" },
    anthropic: { assistant: true, image: null, voice: null },
    google: { assistant: true, image: null, voice: null },
    meta: { assistant: true, image: null, voice: null },
    openrouter: { assistant: true, image: "openrouter", voice: null },
    fal: { assistant: false, image: "fal", voice: null },
    xai: { assistant: true, image: null, voice: "xai" },
    inworld: { assistant: false, image: null, voice: "inworld" },
};

export function ProviderConnectedDialog() {
    const t = useT();
    const [stage, setStage] = useState(null);
    const [assistant, setAssistant] = useState(true);
    const [image, setImage] = useState(true);
    const [voice, setVoice] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    useEffect(() => {
        const handler = (event) => {
            const detail = event.detail;
            const surfaces = PROVIDER_SURFACES[detail.provider];
            if (!surfaces)
                return;

            const offeredCount = (surfaces.assistant ? 1 : 0) +
                (surfaces.image ? 1 : 0) +
                (surfaces.voice ? 1 : 0);
            if (offeredCount === 0)
                return;
            if (offeredCount === 1) {
                if (!surfaces.assistant && (surfaces.image || surfaces.voice)) {
                    const patch = {};
                    if (surfaces.image) {
                        patch.imageGeneration = { provider: surfaces.image };
                    }
                    if (surfaces.voice) {
                        patch.realtimeVoice = { provider: surfaces.voice };
                    }
                    void window.electronAPI?.system
                        ?.setLocalModelPreferences?.(patch)
                        .then(() => {
                        window.dispatchEvent(new CustomEvent("stella:local-model-preferences-changed"));
                    });
                }
                return;
            }
            const llmEntry = PROVIDER_CREDENTIALS.find((entry) => entry.key === detail.provider);
            setStage({
                detail,
                surfaces,
                providerLabel: llmEntry?.label ?? detail.provider,
            });
            setAssistant(surfaces.assistant);
            setImage(Boolean(surfaces.image));
            setVoice(Boolean(surfaces.voice));
            setError(null);
        };
        window.addEventListener(PROVIDER_CONNECTED_EVENT, handler);
        return () => window.removeEventListener(PROVIDER_CONNECTED_EVENT, handler);
    }, []);
    const onClose = useCallback(() => {
        setStage(null);
        setError(null);
    }, []);
    const onApply = useCallback(async () => {
        if (!stage)
            return;
        const { detail, surfaces } = stage;
        const patch = {};
        if (surfaces.assistant && assistant) {
            const existing = (await window.electronAPI?.system?.getLocalModelPreferences?.())
                ?.modelOverrides ?? {};
            const next = { ...existing };

            const defaultModelByProvider = {
                openai: "openai/gpt-5.5",
                anthropic: "anthropic/claude-opus-4.7",
                google: "google/gemini-3.1-pro",
                meta: "meta/muse-spark-1.2",
                openrouter: "openrouter/anthropic/claude-opus-4.7",
                xai: "xai/grok-4.5",
            };
            const model = defaultModelByProvider[detail.provider];
            if (model) {
                for (const key of ASSISTANT_AGENT_KEYS) {
                    next[key] = model;
                }
                patch.modelOverrides = next;
            }
        }
        if (surfaces.image && image) {
            patch.imageGeneration = { provider: surfaces.image };
        }
        if (surfaces.voice && voice) {
            patch.realtimeVoice = { provider: surfaces.voice };
        }
        if (Object.keys(patch).length === 0) {
            onClose();
            return;
        }
        setBusy(true);
        setError(null);
        try {
            await window.electronAPI?.system?.setLocalModelPreferences?.(patch);
            window.dispatchEvent(new CustomEvent("stella:local-model-preferences-changed"));
            onClose();
        }
        catch (caught) {
            setError(caught instanceof Error
                ? caught.message
                : t("settings.providerConnected.errors.apply"));
        }
        finally {
            setBusy(false);
        }
    }, [assistant, image, onClose, stage, t, voice]);
    const anyChecked = useMemo(() => {
        if (!stage)
            return false;
        const { surfaces } = stage;
        return ((surfaces.assistant && assistant) ||
            (Boolean(surfaces.image) && image) ||
            (Boolean(surfaces.voice) && voice));
    }, [assistant, image, stage, voice]);
    if (!stage)
        return null;
    const { providerLabel, surfaces } = stage;
    return (<Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent fit className="provider-connected-dialog">
        <DialogHeader>
          <DialogTitle>
            {t("settings.providerConnected.title", { provider: providerLabel })}
          </DialogTitle>
          <DialogDescription>
            {t("settings.providerConnected.description", {
                provider: providerLabel,
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="provider-connected-dialog-body">
          {surfaces.assistant ? (<label className="provider-connected-row">
              <input type="checkbox" checked={assistant} onChange={(event) => setAssistant(event.target.checked)}/>
              <span>
                <span className="provider-connected-row-label">
                  {t("settings.providerConnected.assistant.label")}
                </span>
                <span className="provider-connected-row-desc">
                  {t("settings.providerConnected.assistant.description", {
                    provider: providerLabel,
                })}
                </span>
              </span>
            </label>) : null}
          {surfaces.image ? (<label className="provider-connected-row">
              <input type="checkbox" checked={image} onChange={(event) => setImage(event.target.checked)}/>
              <span>
                <span className="provider-connected-row-label">
                  {t("settings.providerConnected.image.label")}
                </span>
                <span className="provider-connected-row-desc">
                  {t("settings.providerConnected.image.description", {
                    provider: providerLabel,
                })}
                </span>
              </span>
            </label>) : null}
          {surfaces.voice ? (<label className="provider-connected-row">
              <input type="checkbox" checked={voice} onChange={(event) => setVoice(event.target.checked)}/>
              <span>
                <span className="provider-connected-row-label">
                  {t("settings.providerConnected.voice.label")}
                </span>
                <span className="provider-connected-row-desc">
                  {t("settings.providerConnected.voice.description", {
                    provider: providerLabel,
                })}
                </span>
              </span>
            </label>) : null}
          {error ? (<p className="provider-connected-error" role="alert">
              {error}
            </p>) : null}
          <div className="provider-connected-actions">
            <Button type="button" variant="ghost" className="pill-btn" onClick={onClose} disabled={busy}>
              {t("settings.providerConnected.skip")}
            </Button>
            <Button type="button" variant="primary" className="pill-btn pill-btn--primary" onClick={() => void onApply()} disabled={busy || !anyChecked}>
              {busy
                ? t("settings.providerConnected.applying")
                : t("settings.providerConnected.apply")}
            </Button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>);
}
