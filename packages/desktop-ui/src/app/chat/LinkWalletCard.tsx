import type { ReactNode } from "react";
import type { LinkWalletCardView } from "@stella/contracts/link-wallet";
import { AlertCircle, Check, CreditCard } from "@/ui/icons";
import { Button } from "@/ui/button";
import {
  dismissLinkWalletCard,
  respondToLinkWallet,
  useLinkWalletCard,
} from "@/features/chat/link-wallet-store";
import { getElectronApi } from "@/platform/electron/electron";
import { useT } from "@/shared/i18n";
import "./connector-connect-card.css";
import "./link-wallet-card.css";

const cardClassForPhase = (phase: LinkWalletCardView["phase"]): string => {
  switch (phase) {
    case "pairing":
    case "awaiting_approval":
      return "connecting";
    case "add_card":
      return "offer";
    case "offer":
    case "connected":
    case "error":
      return phase;
    default: {
      const _exhaustive: never = phase;
      return _exhaustive;
    }
  }
};

export const LinkWalletCard = ({
  compact = false,
  conversationId,
}: {
  compact?: boolean;
  conversationId?: string | null;
}) => {
  const t = useT();
  const request = useLinkWalletCard(conversationId);
  if (!request) return null;

  let title: string;
  let sub: string;
  switch (request.phase) {
    case "offer":
      title = t("app.chat.linkWallet.titleOffer");
      sub = request.message ?? t("app.chat.linkWallet.offerBody");
      break;
    case "pairing":
      title = t("app.chat.linkWallet.titlePairing");
      sub = request.verificationUrl
        ? t("app.chat.linkWallet.pairingOpen", { url: request.verificationUrl })
        : t("app.chat.linkWallet.pairingBody");
      break;
    case "add_card":
      title = t("app.chat.linkWallet.titleAddCard");
      sub = t("app.chat.linkWallet.addCardBody");
      break;
    case "connected":
      title = t("app.chat.linkWallet.titleConnected");
      sub = t("app.chat.linkWallet.connectedBody");
      break;
    case "awaiting_approval":
      title = t("app.chat.linkWallet.titleApproval");
      sub = t("app.chat.linkWallet.approvalBody", {
        merchant:
          request.merchantName ?? t("app.chat.linkWallet.merchantFallback"),
        amount: request.amountLabel ?? "",
      });
      break;
    case "error":
      title = t("app.chat.linkWallet.titleError");
      sub = request.message ?? t("app.chat.linkWallet.errorBody");
      break;
    default: {
      const _exhaustive: never = request.phase;
      return _exhaustive;
    }
  }

  const cardClass = cardClassForPhase(request.phase);

  let actions: ReactNode = null;
  switch (request.phase) {
    case "offer":
      actions = (
        <div className="connector-connect-card__actions">
          <Button
            type="button"
            variant="ghost"
            className="pill-btn connector-connect-card__decline"
            onClick={() => respondToLinkWallet(request.requestId, "decline")}
          >
            {t("app.chat.linkWallet.notNow")}
          </Button>
          <Button
            type="button"
            variant="primary"
            className="pill-btn pill-btn--primary connector-connect-card__accept"
            onClick={() => respondToLinkWallet(request.requestId, "accept")}
          >
            {t("app.chat.linkWallet.connect")}
          </Button>
        </div>
      );
      break;
    case "pairing":
      actions = (
        <div className="connector-connect-card__actions">
          <Button
            type="button"
            variant="ghost"
            className="pill-btn connector-connect-card__decline"
            onClick={() => respondToLinkWallet(request.requestId, "cancel")}
          >
            {t("app.chat.linkWallet.cancel")}
          </Button>
        </div>
      );
      break;
    case "add_card":
      actions = (
        <div className="connector-connect-card__actions">
          <Button
            type="button"
            variant="ghost"
            className="pill-btn connector-connect-card__decline"
            onClick={() => dismissLinkWalletCard(request.requestId)}
          >
            {t("app.chat.linkWallet.later")}
          </Button>
          <Button
            type="button"
            variant="primary"
            className="pill-btn pill-btn--primary connector-connect-card__accept"
            onClick={() => {
              void getElectronApi()?.system.addLinkWalletCard();
              dismissLinkWalletCard(request.requestId);
            }}
          >
            {t("app.chat.linkWallet.addCard")}
          </Button>
        </div>
      );
      break;
    case "connected":
    case "awaiting_approval":
    case "error":
      actions = null;
      break;
    default: {
      const _exhaustive: never = request.phase;
      return _exhaustive;
    }
  }

  return (
    <div
      className={`connector-connect-card connector-connect-card--${cardClass}${compact ? " connector-connect-card--compact" : ""}`}
      role="status"
    >
      <div className="connector-connect-card__icon" aria-hidden>
        {request.phase === "connected" ? (
          <Check size={compact ? 14 : 16} />
        ) : request.phase === "error" ? (
          <AlertCircle size={compact ? 14 : 16} />
        ) : (
          <CreditCard size={compact ? 14 : 16} />
        )}
      </div>
      <div className="connector-connect-card__body">
        <p className="connector-connect-card__title">{title}</p>
        {sub ? <p className="connector-connect-card__sub">{sub}</p> : null}
        {request.phase === "pairing" && request.userCode ? (
          <p className="connector-connect-card__phrase">{request.userCode}</p>
        ) : null}
      </div>
      {actions}
    </div>
  );
};
