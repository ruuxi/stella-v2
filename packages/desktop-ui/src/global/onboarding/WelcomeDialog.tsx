import { useCallback, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogBody,
  DialogCloseButton,
  DialogTitle,
  DialogDescription,
} from "@/ui/dialog";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { listLocalEvents } from "@/features/chat/services/local-chat-store";
import { LogIn, SlidersHorizontal, Smartphone } from "@/ui/icons";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { openEngineDisplayTab } from "@/features/workspace-display/default-tabs";
import { uiState } from "@/platform/ui-state";
import "./welcome-dialog.css";

const WELCOME_DIALOG_SEEN_KEY = "stella-welcome-dialog-seen";

function useWelcomeMessage(conversationId: string | null): string | null {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;

    const load = async () => {
      try {
        const events = await listLocalEvents(conversationId, 50);
        if (cancelled) return;
        const welcome = events.find(
          (e) => e.type === "assistant_message" && e.payload,
        );
        if (welcome?.payload) {
          const text = (welcome.payload as { text?: string }).text;
          if (text) setMessage(text);
        }
      } catch {
        // silent - fallback will be used
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  return message;
}

type WelcomeDialogProps = {
  conversationId: string | null;
  onConnect: () => void;
  onSignIn: () => void;
};

export function WelcomeDialog({
  conversationId,
  onConnect,
  onSignIn,
}: WelcomeDialogProps) {
  const { hasConnectedAccount } = useAuthSessionState();
  const [open, setOpen] = useState(
    () => uiState.getItem(WELCOME_DIALOG_SEEN_KEY) !== "true",
  );

  const welcomeMessage = useWelcomeMessage(open ? conversationId : null);

  const handleClose = useCallback(() => {
    setOpen(false);
    uiState.setItem(WELCOME_DIALOG_SEEN_KEY, "true");
  }, []);

  const handleConnect = useCallback(() => {
    handleClose();
    onConnect();
  }, [handleClose, onConnect]);

  const handleSignIn = useCallback(() => {
    handleClose();
    onSignIn();
  }, [handleClose, onSignIn]);

  const handleOpenModelPicker = useCallback(() => {
    handleClose();
    openEngineDisplayTab();
  }, [handleClose]);

  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent fit size="md" className="welcome-dialog-content">
        <VisuallyHidden asChild>
          <DialogTitle>Welcome to Stella</DialogTitle>
        </VisuallyHidden>
        <VisuallyHidden asChild>
          <DialogDescription>
            Get started with Stella and pair your phone to message Stella
            anywhere.
          </DialogDescription>
        </VisuallyHidden>
        <DialogCloseButton className="welcome-dialog-close" />
        <DialogBody className="welcome-dialog-body">
          <p className="welcome-dialog-message">
            {welcomeMessage ?? "Welcome to Stella"}
          </p>

          <div className="welcome-dialog-cards">
            <div
              className="welcome-dialog-card welcome-dialog-card--interactive"
              onClick={handleOpenModelPicker}
              role="button"
              tabIndex={0}
              onKeyDown={(e) =>
                e.key === "Enter" && handleOpenModelPicker()
              }
            >
              <div className="welcome-dialog-card-icon">
                <SlidersHorizontal size={20} />
              </div>
              <div className="welcome-dialog-card-text">
                <h3>Pick your model</h3>
                <p>
                  Choose the model that powers Stella. You can switch providers
                  and reasoning at any time.
                </p>
              </div>
              <span className="welcome-dialog-card-arrow">&rsaquo;</span>
            </div>

            <div
              className="welcome-dialog-card welcome-dialog-card--interactive"
              onClick={handleConnect}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && handleConnect()}
            >
              <div className="welcome-dialog-card-icon">
                <Smartphone size={20} />
              </div>
              <div className="welcome-dialog-card-text">
                <h3>Take Stella with you</h3>
                <p>
                  Connect your phone so you can message Stella anywhere. The
                  phone button in the panel&rsquo;s footer pairs your device any
                  time.
                </p>
              </div>
              <span className="welcome-dialog-card-arrow">&rsaquo;</span>
            </div>

            {!hasConnectedAccount && (
              <div
                className="welcome-dialog-card welcome-dialog-card--interactive"
                onClick={handleSignIn}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && handleSignIn()}
              >
                <div className="welcome-dialog-card-icon">
                  <LogIn size={20} />
                </div>
                <div className="welcome-dialog-card-text">
                  <h3>Sign in to Stella</h3>
                  <p>
                    Sign in to keep using Stella and get higher usage limits.
                  </p>
                </div>
                <span className="welcome-dialog-card-arrow">&rsaquo;</span>
              </div>
            )}
          </div>

          <button
            type="button"
            className="welcome-dialog-cta"
            onClick={handleClose}
          >
            Get started
          </button>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
