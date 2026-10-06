import { useEffect, useState } from "react";
import { KeyRound } from "@/ui/icons";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Button } from "@/ui/button";
import { useT } from "@/shared/i18n";
import { invalidateDictationRoute } from "@/features/dictation/services/dictation-transcriber";
import "./dictation-key-dialog.css";

export const DICTATION_KEY_NEEDED_EVENT = "stella:dictation-key-needed";
export const DICTATION_KEY_SAVED_EVENT = "stella:dictation-key-saved";

const OPENROUTER_KEYS_URL = "https://openrouter.ai/keys";

let mountedHosts = 0;

/**
 * Ask for an OpenRouter key: this Stella has no managed dictation. Returns
 * false in a window without the dialog (the small companion panel).
 */
export const requestDictationKey = (): boolean => {
  if (mountedHosts === 0) return false;
  window.dispatchEvent(new CustomEvent(DICTATION_KEY_NEEDED_EVENT));
  return true;
};

/**
 * The first mic press on a Stella without managed dictation lands here. The
 * key is saved in the device's local provider-key store (the same one
 * Settings → Models uses), so it also serves OpenRouter models if the user
 * picks them later. Saving starts the recording the press asked for.
 */
export function DictationKeyDialog() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const show = () => {
      setDraft("");
      setError(null);
      setOpen(true);
    };
    mountedHosts += 1;
    window.addEventListener(DICTATION_KEY_NEEDED_EVENT, show);
    return () => {
      mountedHosts -= 1;
      window.removeEventListener(DICTATION_KEY_NEEDED_EVENT, show);
    };
  }, []);

  const save = async () => {
    const key = draft.trim();
    if (!key || saving) return;
    const saveCredential = window.electronAPI?.system?.saveLlmCredential;
    if (!saveCredential) {
      setError(t("features.dictation.keyDialog.unavailable"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await saveCredential({ provider: "openrouter", label: "OpenRouter", plaintext: key });
      invalidateDictationRoute();
      setOpen(false);
      window.dispatchEvent(new CustomEvent(DICTATION_KEY_SAVED_EVENT));
    } catch (err) {
      setError((err as Error).message || t("features.dictation.keyDialog.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;
  return (
    <Dialog open onOpenChange={(next) => (next ? null : setOpen(false))}>
      <DialogContent fit className="dictation-key-dialog">
        <DialogHeader>
          <DialogTitle>{t("features.dictation.keyDialog.title")}</DialogTitle>
          <DialogDescription>
            {t("features.dictation.keyDialog.description")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="dictation-key-dialog-body">
          <label className="dictation-key-dialog-field">
            <KeyRound size={13} strokeWidth={1.75} aria-hidden />
            <input
              type="password"
              placeholder="sk-or-…"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void save();
              }}
              aria-label={t("features.dictation.keyDialog.inputLabel")}
              spellCheck={false}
              autoComplete="off"
              autoFocus
              disabled={saving}
            />
          </label>
          <button
            type="button"
            className="dictation-key-dialog-link"
            onClick={() => window.electronAPI?.system?.openExternal?.(OPENROUTER_KEYS_URL)}
          >
            {t("features.dictation.keyDialog.getKey")}
          </button>
          {error ? (
            <p className="dictation-key-dialog-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="dictation-key-dialog-actions">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" onClick={() => void save()} disabled={!draft.trim() || saving}>
              {saving ? t("features.dictation.keyDialog.saving") : t("features.dictation.keyDialog.save")}
            </Button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
