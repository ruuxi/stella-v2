import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogCloseButton,
} from "@/ui/dialog";
import { Button } from "@/ui/button";
import { ExecutionDevicesCard } from "@/global/settings/ExecutionDevicesCard";
import { GetTheApp } from "@/global/integrations/GetTheApp";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { useT } from "@/shared/i18n";
import "./ConnectDialog.css";

interface ConnectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The phone app and the account's computers, and nothing else.
 *
 * A phone signed in to the same account reaches these computers on its own,
 * so there is no pairing step: the dialog offers the app's store link as a QR
 * code, and lists every computer with the switch that lets it accept work.
 * The dialog sizes to its content and only the body scrolls, so the header
 * stays put on a short window.
 */
export const ConnectDialog = ({ open, onOpenChange }: ConnectDialogProps) => {
  const t = useT();
  const navigate = useNavigate();
  const { hasConnectedAccount } = useAuthSessionState();

  const handleSignIn = useCallback(() => {
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown> | undefined) => ({
        ...(prev ?? {}),
        dialog: "auth" as const,
      }),
    });
  }, [navigate]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent fit className="connect-dialog">
        <DialogHeader>
          <DialogTitle>{t("global.integrations.connectStellaApp")}</DialogTitle>
          <DialogCloseButton />
        </DialogHeader>
        <DialogBody>
          <section className="connect-section">
            <h3 className="connect-section__title">
              {t("global.integrations.getApp.title")}
            </h3>
            <div className="connect-panel">
              <GetTheApp />
            </div>
          </section>

          <section className="connect-section">
            <h3 className="connect-section__title">
              {t("settings.executionDevices.title")}
            </h3>
            {hasConnectedAccount ? (
              <ExecutionDevicesCard />
            ) : (
              <Button variant="secondary" onClick={handleSignIn}>
                {t("global.integrations.signInToConnect")}
              </Button>
            )}
          </section>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
};
