import type { FormEvent, ReactNode } from "react";
import { cn } from "@/shared/lib/utils";
import { useT } from "@/shared/i18n";
import { Button, type ButtonProps } from "@/ui/button";
import { TextField } from "@/ui/text-field";
import { useMagicLinkAuth } from "./useMagicLinkAuth";
import {
  detectEmailProvider,
  openEmailProvider,
} from "./lib/email-providers";

type MagicLinkAuthFlowProps = {
  className?: string;
  intro?: ReactNode;
  emailLabel?: string;
  hideEmailLabel?: boolean;
  emailPlaceholder?: string;
  inputVariant?: "normal" | "ghost";
  inputClassName?: string;
  formClassName?: string;
  submitLabel?: string;
  sendingLabel?: string;
  buttonClassName?: string;
  buttonVariant?: ButtonProps["variant"];
  buttonSize?: ButtonProps["size"];
  autoFocus?: boolean;
  errorClassName?: string;
  /** Wraps the grow-in region that appears after a successful send. */
  extrasClassName?: string;
  extrasInnerClassName?: string;
  sentClassName?: string;
  sentMessage?: ReactNode;
  openInboxClassName?: string;
  openInboxLabel?: (providerName: string) => string;
  resendCooldownLabel?: (secondsLeft: number) => string;
  /** Submit button label when the entered email matches the last sent. */
  resendLabel?: string;
  skipClassName?: string;
  skipLabel?: string;
  onSkip?: () => void;
};

export function MagicLinkAuthFlow({
  className,
  intro,
  emailLabel: emailLabelProp,
  hideEmailLabel = false,
  emailPlaceholder: emailPlaceholderProp,
  inputVariant = "normal",
  inputClassName,
  formClassName,
  submitLabel: submitLabelProp,
  sendingLabel: sendingLabelProp,
  buttonClassName,
  buttonVariant = "primary",
  buttonSize = "normal",
  autoFocus = false,
  errorClassName,
  extrasClassName,
  extrasInnerClassName,
  sentClassName,
  sentMessage: sentMessageProp,
  openInboxClassName,
  openInboxLabel: openInboxLabelProp,
  resendCooldownLabel: resendCooldownLabelProp,
  resendLabel: resendLabelProp,
  skipClassName,
  skipLabel: skipLabelProp,
  onSkip,
}: MagicLinkAuthFlowProps) {
  const t = useT();
  const emailLabel = emailLabelProp ?? t("global.auth.emailLabel");
  const emailPlaceholder =
    emailPlaceholderProp ?? t("global.auth.emailPlaceholder");
  const submitLabel = submitLabelProp ?? t("global.auth.sendSignInEmail");
  const sendingLabel = sendingLabelProp ?? t("global.auth.sending");
  const sentMessage = sentMessageProp ?? t("global.auth.checkInbox");
  const openInboxLabel =
    openInboxLabelProp ??
    ((provider: string) => t("global.auth.openInbox", { provider }));
  const resendCooldownLabel =
    resendCooldownLabelProp ??
    ((secondsLeft: number) =>
      t("global.auth.resendIn", { seconds: secondsLeft }));
  const resendLabel = resendLabelProp ?? t("global.auth.resendEmail");
  const skipLabel = skipLabelProp ?? t("global.auth.skipForNow");
  const {
    email,
    setEmail,
    status,
    sentToEmail,
    error,
    handleMagicLinkSubmit,
    resend,
    resendCooldownSeconds,
    isResending,
  } = useMagicLinkAuth();

  const normalized = email.trim().toLowerCase();
  const matchesSent = sentToEmail !== null && normalized === sentToEmail;
  const showExtras = matchesSent && (status === "sent" || status === "verifying");
  const provider = showExtras ? detectEmailProvider(normalized) : null;

  const inFlight = status === "sending" || isResending;
  const resendDisabled = matchesSent && (resendCooldownSeconds > 0 || isResending);
  const submitDisabled =
    !normalized || inFlight || status === "verifying" || resendDisabled;

  const submitText =
    status === "sending"
      ? sendingLabel
      : status === "verifying"
        ? t("global.auth.signingIn")
        : isResending
          ? sendingLabel
          : matchesSent
            ? resendCooldownSeconds > 0
              ? resendCooldownLabel(resendCooldownSeconds)
              : resendLabel
            : submitLabel;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (submitDisabled) return;
    if (matchesSent) {
      void resend();
    } else {
      void handleMagicLinkSubmit(event);
    }
  };

  return (
    <div className={cn(className)}>
      {intro}
      <form className={cn(formClassName)} onSubmit={onSubmit}>
        <TextField
          label={emailLabel}
          {...(hideEmailLabel ? { hideLabel: true } : {})}
          type="email"
          placeholder={emailPlaceholder}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="email"
          autoFocus={autoFocus}
          variant={inputVariant}
          className={cn(inputClassName)}
        />
        <Button
          type="submit"
          variant={buttonVariant}
          size={buttonSize}
          className={cn(buttonClassName)}
          disabled={submitDisabled}
        >
          {submitText}
        </Button>
      </form>

      <div
        className={cn(extrasClassName)}
        data-open={showExtras ? "true" : "false"}
        aria-hidden={!showExtras}
      >
        <div className={cn(extrasInnerClassName)}>
          {sentMessage ? (
            <div className={cn(sentClassName)}>{sentMessage}</div>
          ) : null}
          {provider ? (
            <Button
              type="button"
              variant="primary"
              className={cn(openInboxClassName)}
              onClick={() => openEmailProvider(provider)}
            >
              {openInboxLabel(provider.name)}
            </Button>
          ) : null}
        </div>
      </div>

      {error ? <div className={cn(errorClassName)}>{error}</div> : null}

      {onSkip ? (
        <Button
          type="button"
          variant="ghost"
          className={cn(skipClassName)}
          onClick={onSkip}
        >
          {skipLabel}
        </Button>
      ) : null}
    </div>
  );
}
