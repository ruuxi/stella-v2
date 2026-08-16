import { useCallback, useState } from "react";
import { ArrowLeft, ChevronRight, Smartphone } from "@/ui/icons";
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

interface ConnectSurfaceBodyProps {
  selectedProvider: string | undefined;
  onSelectedProviderChange: (provider: string | undefined) => void;
}

const PHONE_ICON = <Smartphone strokeWidth={1.75} aria-hidden />;

const ConnectSurfaceBody = ({
  selectedProvider,
  onSelectedProviderChange,
}: ConnectSurfaceBodyProps) => {
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

  const isPhoneSelected = selectedProvider === "phone";
  const hasSelection = Boolean(selectedProvider);

  return (
    <>
      {!hasSelection && (
        <div className="connect-hero-section">
          <p className="connect-hero-tagline">
            {t("global.integrations.heroTagline")}
          </p>
          <ConnectHeroAnimation />
          {!isSignedIn && (
            <button
              type="button"
              className="pill-btn pill-btn--primary connect-signin-pill"
              onClick={handleSignIn}
            >
              {t("global.integrations.signInToConnect")}
            </button>
          )}
        </div>
      )}
      <div className="connect-dialog-main">
        {isPhoneSelected ? (
          <div className="connect-full-view">
            <PhoneAccessConnectCard />
          </div>
        ) : (
          <button
            className="connect-grid-card connect-grid-card--wide"
            onClick={() => onSelectedProviderChange("phone")}
            type="button"
            disabled={!isSignedIn}
            aria-disabled={!isSignedIn || undefined}
          >
            <span className="connect-grid-card-icon">{PHONE_ICON}</span>
            <span className="connect-grid-card-text">
              <span className="connect-grid-card-name">
                {t("global.integrations.connectStellaApp")}
              </span>
              <span className="connect-grid-card-sub">
                {t("global.integrations.connectStellaAppSub")}
              </span>
            </span>
            <ChevronRight
              className="connect-grid-card-chevron"
              size={16}
              strokeWidth={2}
              aria-hidden
            />
          </button>
        )}
      </div>
    </>
  );
};

export const ConnectDialog = ({ open, onOpenChange }: ConnectDialogProps) => {
  const t = useT();
  const [selectedProvider, setSelectedProvider] = useState<string | undefined>(
    undefined,
  );
  const isPhoneSelected = selectedProvider === "phone";
  const hasSelection = Boolean(selectedProvider);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) setSelectedProvider(undefined);
      onOpenChange(nextOpen);
    },
    [onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        fit
        className="connect-dialog"
        data-has-selection={hasSelection || undefined}
        data-phone-detail={isPhoneSelected || undefined}
      >
        <DialogHeader>
          {hasSelection ? (
            <button
              type="button"
              className="connect-back-button"
              onClick={() => setSelectedProvider(undefined)}
            >
              <ArrowLeft size={16} />
            </button>
          ) : null}
          <DialogTitle>
            {isPhoneSelected
              ? t("global.integrations.connectStellaApp")
              : t("global.integrations.phoneTitle")}
          </DialogTitle>
          <DialogCloseButton />
        </DialogHeader>
        <DialogBody>
          <ConnectSurfaceBody
            selectedProvider={selectedProvider}
            onSelectedProviderChange={setSelectedProvider}
          />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
};
