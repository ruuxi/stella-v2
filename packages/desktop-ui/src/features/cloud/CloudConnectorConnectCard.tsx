/**
 * Inline connect card for a cloud turn: the cloud orchestrator's
 * `connector_status` asked to use a Store integration the account has not
 * connected. Same look and wording as the desktop card
 * (`app/chat/ConnectorConnectCard`), driven by the pending request row
 * instead of Electron IPC. Connect opens the account's hosted OAuth page;
 * the waiting turn observes the finished connection itself.
 */
import { useCallback, useState } from "react";
import { AlertCircle, Check, Globe } from "@/ui/icons";
import { Button } from "@/ui/button";
import { showToast } from "@/ui/toast";
import { openExternalUrl } from "@/platform/electron/open-external";
import { useT } from "@/shared/i18n";
import {
  useCloudConnectRequestActions,
  useCurrentConversationConnectRequest,
} from "./use-cloud-connector-connect";
import "@/app/chat/connector-connect-card.css";

export const CloudConnectorConnectCard = ({
  compact = false,
  conversationId,
}: {
  compact?: boolean;
  conversationId?: string | null;
}) => {
  const t = useT();
  const request = useCurrentConversationConnectRequest(conversationId);
  const { decide } = useCloudConnectRequestActions();
  const [busy, setBusy] = useState<"connect" | "decline" | null>(null);
  const [iconFailed, setIconFailed] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const answer = useCallback(
    async (decision: "connect" | "decline") => {
      if (!request || busy) return;
      setBusy(decision);
      setFailed(null);
      try {
        const outcome = await decide({
          requestId: request.requestId,
          expectedRevision: request.revision,
          decision,
        });
        if (decision === "connect" && outcome.url) openExternalUrl(outcome.url);
      } catch (error) {
        const message =
          error instanceof Error && error.message.trim()
            ? error.message
            : t("app.chat.connectorConnect.errorBody", { name: request.name });
        setFailed(message);
        showToast({ title: message, variant: "error" });
      } finally {
        setBusy(null);
      }
    },
    [busy, decide, request, t],
  );

  if (!request) return null;

  const connecting = request.state === "connecting";
  const phase = failed ? "error" : connecting ? "connecting" : "offer";
  const title = failed
    ? t("app.chat.connectorConnect.titleError", { name: request.name })
    : connecting
      ? t("app.chat.connectorConnect.titleWaiting", { name: request.name })
      : t("app.chat.connectorConnect.titleOffer", { name: request.name });
  const sub = failed
    ? failed
    : connecting
      ? t("app.chat.connectorConnect.connectingApp", { name: request.name })
      : (request.reason ?? request.description);
  const showIconImage = Boolean(request.iconUrl) && !iconFailed;

  return (
    <div
      className={`connector-connect-card connector-connect-card--${phase}${compact ? " connector-connect-card--compact" : ""}`}
      role="status"
      data-connect-request-id={request.requestId}
    >
      <div className="connector-connect-card__icon" aria-hidden>
        {phase === "error" ? (
          <AlertCircle size={compact ? 14 : 16} />
        ) : connecting ? (
          <Check size={compact ? 14 : 16} />
        ) : showIconImage ? (
          <img
            src={request.iconUrl}
            alt=""
            onError={() => setIconFailed(true)}
          />
        ) : (
          <Globe size={compact ? 14 : 16} />
        )}
      </div>
      <div className="connector-connect-card__body">
        <p className="connector-connect-card__title">{title}</p>
        {sub ? <p className="connector-connect-card__sub">{sub}</p> : null}
      </div>
      <div className="connector-connect-card__actions">
        <Button
          type="button"
          variant="ghost"
          className="pill-btn connector-connect-card__decline"
          disabled={Boolean(busy)}
          onClick={() => void answer("decline")}
        >
          {connecting
            ? t("app.chat.connectorConnect.cancel")
            : t("app.chat.connectorConnect.notNow")}
        </Button>
        {!connecting || failed ? (
          <Button
            type="button"
            variant="primary"
            className="pill-btn pill-btn--primary connector-connect-card__accept"
            disabled={Boolean(busy)}
            onClick={() => void answer("connect")}
          >
            {t("app.chat.connectorConnect.connect")}
          </Button>
        ) : null}
      </div>
    </div>
  );
};
