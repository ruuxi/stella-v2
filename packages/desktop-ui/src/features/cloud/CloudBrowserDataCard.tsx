import { useState } from "react";
import { useConvexAuth } from "convex/react";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { showToast } from "@/ui/toast";
import { useT } from "@/shared/i18n";
import { useCloudBrowserActions } from "./use-cloud-browser-interactions";

function CloudBrowserDataCardImpl() {
  const t = useT();
  const { resetProfile } = useCloudBrowserActions();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const reset = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await resetProfile();
      setConfirming(false);
      showToast({
        title: t("cloudBrowser.settings.resetComplete"),
        variant: "success",
      });
    } catch {
      showToast({
        title: t("cloudBrowser.settings.resetFailed"),
        variant: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="settings-card" data-cloud-browser-settings>
        <h3 className="settings-card-title">
          {t("cloudBrowser.settings.title")}
        </h3>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">
              {t("cloudBrowser.settings.defaultProfile")}
            </div>
            <div className="settings-row-sublabel">
              {t("cloudBrowser.settings.description")}
            </div>
          </div>
          <div className="settings-row-control">
            <Button
              type="button"
              variant="ghost"
              className="pill-btn pill-btn--danger"
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              {busy
                ? t("cloudBrowser.settings.resetting")
                : t("cloudBrowser.settings.reset")}
            </Button>
          </div>
        </div>
      </div>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("cloudBrowser.settings.confirmTitle")}</DialogTitle>
            <DialogDescription>
              {t("cloudBrowser.settings.confirmBody")}
            </DialogDescription>
          </DialogHeader>
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
              marginTop: 20,
            }}
          >
            <Button
              type="button"
              variant="ghost"
              className="pill-btn"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="pill-btn pill-btn--danger"
              disabled={busy}
              onClick={() => void reset()}
            >
              {busy
                ? t("cloudBrowser.settings.resetting")
                : t("cloudBrowser.settings.reset")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function CloudBrowserDataCard() {
  const { isAuthenticated } = useConvexAuth();
  return isAuthenticated ? <CloudBrowserDataCardImpl /> : null;
}
