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
import { PhoneAccessConnectCard } from "@/global/settings/PhoneAccessCard";
import { ConnectHeroAnimation } from "./ConnectHeroAnimation";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { useT } from "@/shared/i18n";
import "./ConnectDialog.css";

interface ConnectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const ConnectDialog = ({ open, onOpenChange }: ConnectDialogProps) => {
  const t = useT();
  const navigate = useNavigate();
  const { hasConnectedAccount } = useAuthSessionState();
  const isSignedIn = hasConnectedAccount;

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
      <DialogContent
        fit
        className="connect-dialog"
        data-has-selection={isSignedIn || undefined}
        data-phone-detail={isSignedIn || undefined}
      >
        <DialogHeader>
          <DialogTitle>{t("global.integrations.connectStellaApp")}</DialogTitle>
          <DialogCloseButton />
        </DialogHeader>
        <DialogBody>
          {isSignedIn ? (
            <div className="connect-dialog-main">
              <div className="connect-full-view">
                <PhoneAccessConnectCard />
              </div>
            </div>
          ) : (
            <div className="connect-hero-section">
              <p className="connect-hero-tagline">
                {t("global.integrations.heroTagline")}
              </p>
              <ConnectHeroAnimation />
              <button
                type="button"
                className="pill-btn pill-btn--primary connect-signin-pill"
                onClick={handleSignIn}
              >
                {t("global.integrations.signInToConnect")}
              </button>
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
};
