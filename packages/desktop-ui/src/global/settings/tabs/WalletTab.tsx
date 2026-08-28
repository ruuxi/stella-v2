import { useCallback, useEffect, useState } from "react";
import {
  formatLinkSpendUsd,
  type LinkWalletSnapshot,
} from "@stella/contracts/link-wallet";
import { Button } from "@/ui/button";
import { getElectronApi } from "@/platform/electron/electron";
import { useT } from "@/shared/i18n";

export function WalletTab() {
  const t = useT();
  const [snapshot, setSnapshot] = useState<LinkWalletSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const systemApi = getElectronApi()?.system;
    if (!systemApi?.getLinkWalletStatus || !systemApi.onLinkWalletSnapshot) {
      setSnapshot({ status: "disconnected" });
      return;
    }
    void systemApi.getLinkWalletStatus().then(setSnapshot).catch(() => {
      setSnapshot({ status: "disconnected" });
    });
    return systemApi.onLinkWalletSnapshot((_event, next) => {
      setSnapshot(next);
      setError(null);
    });
  }, []);

  const connect = useCallback(async () => {
    const systemApi = getElectronApi()?.system;
    if (!systemApi?.connectLinkWallet || busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await systemApi.connectLinkWallet();
      if (!outcome.ok && outcome.reason !== "already_pending") {
        setError(outcome.reason);
      }
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : t("settings.wallet.connectFailed"),
      );
    } finally {
      setBusy(false);
    }
  }, [busy, t]);

  const disconnect = useCallback(async () => {
    const systemApi = getElectronApi()?.system;
    if (!systemApi?.disconnectLinkWallet || busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await systemApi.disconnectLinkWallet();
      if (!outcome.ok) {
        setError(outcome.error ?? t("settings.wallet.disconnectFailed"));
      }
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : t("settings.wallet.disconnectFailed"),
      );
    } finally {
      setBusy(false);
    }
  }, [busy, t]);

  const addCard = useCallback(async () => {
    const systemApi = getElectronApi()?.system;
    if (!systemApi?.addLinkWalletCard) return;
    const outcome = await systemApi.addLinkWalletCard();
    if (!outcome.ok) {
      setError(outcome.error ?? t("settings.wallet.addCardFailed"));
    }
  }, [t]);

  const status = snapshot?.status ?? "disconnected";
  const connected = snapshot?.status === "connected" ? snapshot : null;

  return (
    <div className="settings-tab-content">
      <div className="settings-card">
        <div className="settings-card-header">
          <h3 className="settings-card-title">{t("settings.wallet.title")}</h3>
          {status === "connected" ? (
            <Button
              type="button"
              variant="ghost"
              className="pill-btn"
              disabled={busy}
              onClick={() => void disconnect()}
            >
              {t("settings.wallet.disconnect")}
            </Button>
          ) : (
            <Button
              type="button"
              variant="primary"
              className="pill-btn pill-btn--primary"
              disabled={busy || status === "connecting"}
              onClick={() => void connect()}
            >
              {status === "connecting"
                ? t("settings.wallet.connecting")
                : t("settings.wallet.connect")}
            </Button>
          )}
        </div>
        <p className="settings-card-desc">{t("settings.wallet.description")}</p>
        <p className="settings-card-desc">
          {status === "connected"
            ? t("settings.wallet.statusConnected")
            : status === "connecting"
              ? t("settings.wallet.statusConnecting")
              : t("settings.wallet.statusDisconnected")}
        </p>
        {error ? (
          <p className="settings-card-desc settings-card-desc--error" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <div className="settings-card">
        <div className="settings-card-header">
          <h3 className="settings-card-title">{t("settings.wallet.cardsTitle")}</h3>
          {connected ? (
            <Button
              type="button"
              variant="ghost"
              className="pill-btn"
              onClick={() => void addCard()}
            >
              {t("settings.wallet.addCard")}
            </Button>
          ) : null}
        </div>
        {connected ? (
          connected.paymentMethods.length === 0 ? (
            <p className="settings-card-desc">{t("settings.wallet.cardsEmpty")}</p>
          ) : (
            connected.paymentMethods.map((method) => (
              <div className="settings-row" key={method.id}>
                <div className="settings-row-info">
                  <div className="settings-row-label">
                    {method.brand} •••• {method.last4}
                  </div>
                  {method.isDefault ? (
                    <div className="settings-row-sublabel">
                      {t("settings.wallet.cardDefault")}
                    </div>
                  ) : null}
                </div>
              </div>
            ))
          )
        ) : (
          <p className="settings-card-desc">{t("settings.wallet.connectHint")}</p>
        )}
      </div>

      <div className="settings-card">
        <h3 className="settings-card-title">{t("settings.wallet.spendTitle")}</h3>
        {connected ? (
          connected.spends.length === 0 ? (
            <p className="settings-card-desc">{t("settings.wallet.spendEmpty")}</p>
          ) : (
            connected.spends.map((spend) => (
              <div className="settings-row" key={spend.id}>
                <div className="settings-row-info">
                  <div className="settings-row-label">{spend.merchantName}</div>
                  <div className="settings-row-sublabel">{spend.status}</div>
                </div>
                <div className="settings-row-control">
                  {formatLinkSpendUsd(spend.amountCents)}
                </div>
              </div>
            ))
          )
        ) : (
          <p className="settings-card-desc">{t("settings.wallet.spendEmpty")}</p>
        )}
      </div>
    </div>
  );
}
