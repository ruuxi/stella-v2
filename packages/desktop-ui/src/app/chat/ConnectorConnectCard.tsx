/**
 * Inline connect card: an agent asked (via `stella-connect
 * request-connection`) to use an integration that isn't connected yet.
 * Rendered in the flow of the chat surfaces, pinned above the composer
 * while the agent's turn is blocked on the answer. Connect launches the
 * same Composio/OAuth flow as the Store (browser hand-off, no modal);
 * Not now resolves a decline that the runtime persists so the offer is
 * never repeated.
 */

import { useState } from "react";
import { AlertCircle, Check, Globe } from "@/ui/icons";
import { Button } from "@/ui/button";
import {
  respondToConnectorConnect,
  useConnectorConnectRequest,
} from "@/features/chat/connector-connect-store";
import { useT } from "@/shared/i18n";
import "./connector-connect-card.css";

export const ConnectorConnectCard = ({
  compact = false,
  conversationId,
}: {
  compact?: boolean;
  /** Scope: only requests for this chat (or unscoped ones) render here. */
  conversationId?: string | null;
}) => {
  const t = useT();
  const request = useConnectorConnectRequest(conversationId);
  const [iconFailed, setIconFailed] = useState(false);
  if (!request) return null;

  const isBrowserExtension = request.kind === "browser-extension";
  const showIconImage = Boolean(request.iconUrl) && !iconFailed;
  const sub =
    request.phase === "connecting"
      ? isBrowserExtension
        ? t("app.chat.connectorConnect.connectingExtension")
        : t("app.chat.connectorConnect.connectingApp", { name: request.name })
      : request.phase === "connected"
        ? isBrowserExtension
          ? t("app.chat.connectorConnect.connectedExtension")
          : t("app.chat.connectorConnect.connectedApp")
        : request.phase === "error"
          ? (request.message ??
            t("app.chat.connectorConnect.errorBody", { name: request.name }))
          : (request.reason ?? request.description ?? undefined);

  const title =
    request.phase === "connected"
      ? t("app.chat.connectorConnect.titleConnected", { name: request.name })
      : request.phase === "connecting"
        ? t("app.chat.connectorConnect.titleWaiting", { name: request.name })
        : request.phase === "error"
          ? t("app.chat.connectorConnect.titleError", { name: request.name })
          : isBrowserExtension
            ? t("app.chat.connectorConnect.titleOfferExtension", {
                name: request.name,
              })
            : t("app.chat.connectorConnect.titleOffer", {
                name: request.name,
              });

  return (
    <div
      className={`connector-connect-card connector-connect-card--${request.phase}${compact ? " connector-connect-card--compact" : ""}`}
      role="status"
    >
      <div className="connector-connect-card__icon" aria-hidden>
        {request.phase === "connected" ? (
          <Check size={compact ? 14 : 16} />
        ) : request.phase === "error" ? (
          <AlertCircle size={compact ? 14 : 16} />
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
      {request.phase === "offer" ? (
        <div className="connector-connect-card__actions">
          <Button
            type="button"
            variant="ghost"
            className="pill-btn connector-connect-card__decline"
            onClick={() => respondToConnectorConnect(request.requestId, "decline")}
          >
            {t("app.chat.connectorConnect.notNow")}
          </Button>
          <Button
            type="button"
            variant="primary"
            className="pill-btn pill-btn--primary connector-connect-card__accept"
            onClick={() => respondToConnectorConnect(request.requestId, "accept")}
          >
            {isBrowserExtension
              ? t("app.chat.connectorConnect.install")
              : t("app.chat.connectorConnect.connect")}
          </Button>
        </div>
      ) : request.phase === "connecting" ? (
        <div className="connector-connect-card__actions">
          <Button
            type="button"
            variant="ghost"
            className="pill-btn connector-connect-card__decline"
            onClick={() => respondToConnectorConnect(request.requestId, "cancel")}
          >
            {t("app.chat.connectorConnect.cancel")}
          </Button>
        </div>
      ) : null}
    </div>
  );
};
