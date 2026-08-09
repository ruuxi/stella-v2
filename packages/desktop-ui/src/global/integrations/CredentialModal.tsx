import { useState } from "react";
import { KeyRound } from "@/ui/icons";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogCloseButton,
} from "@/ui/dialog";
import { Button } from "@/ui/button";
import { TextField } from "@/ui/text-field";
import { getProviderDisplayName } from "@/global/settings/lib/model-catalog";
import { useT } from "@/shared/i18n";
import "./credential-modal.css";

type CredentialModalProps = {
  open: boolean;
  provider: string;
  label?: string;
  description?: string;
  placeholder?: string;
  /**
   * Show the "Label" field when a provider can have multiple saved keys.
   * Single-key provider settings can use the provider identifier directly.
   */
  showLabel?: boolean;
  onSubmit: (payload: { label: string; secret: string }) => Promise<void>;
  onCancel: () => void;
};

type CredentialModalContentProps = Omit<CredentialModalProps, "open">;

const CredentialModalContent = ({
  provider,
  label,
  description,
  placeholder,
  showLabel = true,
  onSubmit,
  onCancel,
}: CredentialModalContentProps) => {
  const t = useT();
  const [secret, setSecret] = useState("");
  const [labelValue, setLabelValue] = useState(label ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const providerTitle = label?.trim() || getProviderDisplayName(provider);
  const connectTitle = t("global.integrations.credential.title", {
    provider: providerTitle,
  });
  const defaultDescription = t("global.integrations.credential.description", {
    provider: providerTitle,
  });
  const defaultLabelValue = t("global.integrations.credential.defaultLabel", {
    provider: providerTitle,
  });

  const handleSubmit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    setError(null);
    if (!secret.trim()) {
      setError(t("global.integrations.credential.apiKeyRequired"));
      return;
    }
    const finalLabel = labelValue.trim() || defaultLabelValue;
    try {
      setSubmitting(true);
      await onSubmit({ label: finalLabel, secret: secret.trim() });
    } catch (err) {
      setError(
        (err as Error).message ||
          t("global.integrations.credential.saveFailed"),
      );
      setSubmitting(false);
    }
  };

  return (
    <>
      <VisuallyHidden asChild>
        <DialogTitle>{connectTitle}</DialogTitle>
      </VisuallyHidden>
      <VisuallyHidden asChild>
        <DialogDescription>
          {description ?? defaultDescription}
        </DialogDescription>
      </VisuallyHidden>
      <DialogCloseButton className="credential-modal-close" />
      <DialogBody className="credential-modal-body">
        <div className="credential-modal-hero">
          <div className="credential-modal-icon">
            <KeyRound size={20} />
          </div>
          <p className="credential-modal-headline">{connectTitle}</p>
          <p className="credential-modal-sub">
            {description ?? defaultDescription}
          </p>
        </div>

        <form className="credential-modal-form" onSubmit={handleSubmit}>
          <TextField
            label={t("global.integrations.credential.apiKeyLabel")}
            type="password"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            placeholder={
              placeholder ?? t("global.integrations.credential.keyPlaceholder")
            }
            autoFocus
          />
          {showLabel ? (
            <TextField
              label={t("global.integrations.credential.labelLabel")}
              description={t("global.integrations.credential.labelDescription")}
              value={labelValue}
              onChange={(event) => setLabelValue(event.target.value)}
              placeholder={defaultLabelValue}
            />
          ) : null}
          {error ? <div className="credential-modal-error">{error}</div> : null}

          <div className="credential-modal-actions">
            <Button
              type="button"
              variant="ghost"
              onClick={onCancel}
              disabled={submitting}
              className="pill-btn pill-btn--lg credential-modal-cancel"
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={submitting}
              className="pill-btn pill-btn--primary pill-btn--lg credential-modal-submit"
            >
              {submitting
                ? t("global.integrations.credential.saving")
                : t("global.integrations.credential.saveKey")}
            </Button>
          </div>
        </form>
      </DialogBody>
    </>
  );
};

export const CredentialModal = ({
  open,
  provider,
  label,
  description,
  placeholder,
  showLabel,
  onSubmit,
  onCancel,
}: CredentialModalProps) => {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => (!nextOpen ? onCancel() : undefined)}
    >
      <DialogContent fit className="credential-modal-content">
        {open ? (
          <CredentialModalContent
            key={`${provider}-${label ?? ""}`}
            provider={provider}
            label={label}
            description={description}
            placeholder={placeholder}
            showLabel={showLabel}
            onSubmit={onSubmit}
            onCancel={onCancel}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
