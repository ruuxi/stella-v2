import { AlertCircle, Check, CreditCard } from "@/ui/icons";
import { Button } from "@/ui/button";
import {
  respondToLinkWallet,
  useLinkWalletCard,
} from "@/features/chat/link-wallet-store";
import { useT } from "@/shared/i18n";
import "./connector-connect-card.css";
import "./link-wallet-card.css";

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

  const title =
    request.phase === "connected"
      ? t("app.chat.linkWallet.titleConnected")
      : request.phase === "pairing"
        ? t("app.chat.linkWallet.titlePairing")
        : request.phase === "awaiting_approval"
          ? t("app.chat.linkWallet.titleApproval")
          : request.phase === "error"
            ? t("app.chat.linkWallet.titleError")
            : t("app.chat.linkWallet.titleOffer");

  const sub =
    request.phase === "pairing"
      ? request.verificationUrl
        ? t("app.chat.linkWallet.pairingOpen", { url: request.verificationUrl })
        : t("app.chat.linkWallet.pairingBody")
      : request.phase === "connected"
        ? t("app.chat.linkWallet.connectedBody")
        : request.phase === "awaiting_approval"
          ? t("app.chat.linkWallet.approvalBody", {
              merchant: request.merchantName ?? t("app.chat.linkWallet.merchantFallback"),
              amount: request.amountLabel ?? "",
            })
          : request.phase === "error"
            ? (request.message ?? t("app.chat.linkWallet.errorBody"))
            : (request.message ?? t("app.chat.linkWallet.offerBody"));

  const cardClass =
    request.phase === "pairing"
      ? "connecting"
      : request.phase === "awaiting_approval"
        ? "connecting"
        : request.phase;

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
      {request.phase === "offer" ? (
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
      ) : request.phase === "pairing" ? (
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
      ) : null}
    </div>
  );
};
