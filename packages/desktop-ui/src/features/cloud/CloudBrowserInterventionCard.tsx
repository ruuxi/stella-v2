import { useCallback, useState } from "react";
import type {
  CloudBrowserDeviceCodeDetail,
  CloudBrowserInteractionDetail,
  CloudBrowserInteractionSummary,
} from "@stella/contracts/cloud-browser";
import { AlertCircle, Check, Copy, ExternalLink, Lock } from "@/ui/icons";
import { Button } from "@/ui/button";
import { showToast } from "@/ui/toast";
import { copyTextToClipboard } from "@/shared/lib/clipboard";
import { openExternalUrl } from "@/platform/electron/open-external";
import { sidebarSections } from "@/features/workspace-display/sidebar-sections";
import { useT } from "@/shared/i18n";
import {
  useCloudBrowserActions,
  useCurrentConversationBrowserInteraction,
} from "./use-cloud-browser-interactions";
import "./cloud-browser-intervention-card.css";

const publicVerificationUrl = (value: string): string | null => {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
};

const displayName = (interaction: CloudBrowserInteractionSummary): string =>
  interaction.displayOrigin;

const deviceCodeDetail = (
  detail: CloudBrowserInteractionDetail | null | undefined,
): CloudBrowserDeviceCodeDetail | null =>
  detail?.kind === "device_code" ? detail : null;

export function CloudBrowserInterventionCard({
  compact = false,
  conversationId,
}: {
  compact?: boolean;
  conversationId?: string | null;
}) {
  const t = useT();
  const { summary, detail } =
    useCurrentConversationBrowserInteraction(conversationId);
  const { decide } = useCloudBrowserActions();
  const [busyDecision, setBusyDecision] = useState<"done" | "cancel" | null>(
    null,
  );
  const [copied, setCopied] = useState(false);

  const decideInteraction = useCallback(
    async (decision: "done" | "cancel") => {
      if (!summary || busyDecision) return;
      setBusyDecision(decision);
      try {
        await decide({
          interactionId: summary.interactionId,
          expectedRevision: detail?.revision ?? summary.revision,
          decision,
        });
      } catch {
        showToast({
          title: t("cloudBrowser.errors.decision"),
          variant: "error",
        });
      } finally {
        setBusyDecision(null);
      }
    },
    [busyDecision, decide, detail?.revision, summary, t],
  );

  if (!summary) return null;

  const device = deviceCodeDetail(detail);
  const origin = displayName(summary);
  const resuming = summary.state === "resuming";
  const title =
    summary.kind === "device_code"
      ? t("cloudBrowser.deviceCode.title", { origin })
      : resuming
        ? t("cloudBrowser.takeover.checking", { origin })
        : t("cloudBrowser.takeover.title", { origin });

  const copyCode = async () => {
    if (!device) return;
    const ok = await copyTextToClipboard(device.userCode);
    setCopied(ok);
  };

  const openVerification = () => {
    if (!device) return;
    const url = publicVerificationUrl(
      device.verificationUriComplete ?? device.verificationUri,
    );
    if (!url) {
      showToast({
        title: t("cloudBrowser.errors.verificationUrl"),
        variant: "error",
      });
      return;
    }
    openExternalUrl(url);
  };

  return (
    <div
      className={`cloud-browser-intervention cloud-browser-intervention--${summary.kind}${compact ? " cloud-browser-intervention--compact" : ""}`}
      role="status"
      data-interaction-id={summary.interactionId}
    >
      <div className="cloud-browser-intervention__icon" aria-hidden="true">
        {resuming ? <Check size={16} /> : <Lock size={16} />}
      </div>
      <div className="cloud-browser-intervention__body">
        <p className="cloud-browser-intervention__title">{title}</p>
        {summary.kind === "device_code" ? (
          device ? (
            <div className="cloud-browser-intervention__device">
              <code aria-label={t("cloudBrowser.deviceCode.codeLabel")}>
                {device.userCode}
              </code>
              <p>{t("cloudBrowser.deviceCode.body")}</p>
            </div>
          ) : (
            <p className="cloud-browser-intervention__sub">
              {t("common.loading")}
            </p>
          )
        ) : (
          <p className="cloud-browser-intervention__sub">
            {resuming
              ? t("cloudBrowser.takeover.resumingBody")
              : t("cloudBrowser.takeover.body")}
          </p>
        )}
      </div>
      {!resuming ? (
        <div className="cloud-browser-intervention__actions">
          <Button
            type="button"
            variant="ghost"
            className="pill-btn"
            disabled={Boolean(busyDecision)}
            onClick={() => void decideInteraction("cancel")}
          >
            {busyDecision === "cancel"
              ? t("cloudBrowser.actions.canceling")
              : t("common.cancel")}
          </Button>
          {summary.kind === "login_takeover" ? (
            <Button
              type="button"
              variant="primary"
              className="pill-btn pill-btn--primary"
              onClick={() =>
                sidebarSections.openLocation("takeover", summary.interactionId)
              }
            >
              {t("common.continue")}
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="ghost"
                className="pill-btn"
                disabled={!device}
                onClick={() => void copyCode()}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied
                  ? t("cloudBrowser.deviceCode.copied")
                  : t("cloudBrowser.deviceCode.copy")}
              </Button>
              <Button
                type="button"
                variant="primary"
                className="pill-btn pill-btn--primary"
                disabled={!device}
                onClick={openVerification}
              >
                <ExternalLink size={14} />
                {t("cloudBrowser.deviceCode.open")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="pill-btn"
                disabled={Boolean(busyDecision) || !device}
                onClick={() => void decideInteraction("done")}
              >
                {busyDecision === "done"
                  ? t("cloudBrowser.actions.finishing")
                  : t("cloudBrowser.actions.done")}
              </Button>
            </>
          )}
        </div>
      ) : null}
      {detail === null ? (
        <span className="cloud-browser-intervention__error" role="alert">
          <AlertCircle size={14} /> {t("cloudBrowser.errors.expired")}
        </span>
      ) : null}
    </div>
  );
}
