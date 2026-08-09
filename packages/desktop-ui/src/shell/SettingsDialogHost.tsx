/**
 * The single mounted host for the Settings dialog. Triggers (gear buttons,
 * toast CTAs) go through `settingsDialog` so exactly one dialog exists no
 * matter how many triggers are on screen.
 */
import { lazy, Suspense, useCallback } from "react";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { secureSignOut } from "@/global/auth/services/auth";
import {
  Dialog,
  DialogBody,
  DialogCloseButton,
  DialogContent,
  DialogTitle,
} from "@/ui/dialog";
import { settingsDialog, useSettingsDialogOpen } from "./settings-dialog-store";
import "./settings-dialog.css";

const SettingsScreen = lazy(() =>
  import("@/global/settings/SettingsView").then((module) => ({
    default: module.SettingsScreen,
  })),
);

export function SettingsDialogHost() {
  const open = useSettingsDialogOpen();
  const handleSignOut = useCallback(() => {
    settingsDialog.close();
    void secureSignOut();
  }, []);

  if (!open) return null;

  return (
    <Dialog open onOpenChange={(next) => settingsDialog.setOpen(next)}>
      <DialogContent
        className="shell-settings-dialog"
        aria-describedby={undefined}
      >
        {/* The settings screen renders its own visible title; keep the
            dialog's accessible name without doubling it on screen. */}
        <VisuallyHidden asChild>
          <DialogTitle>Settings</DialogTitle>
        </VisuallyHidden>
        <DialogCloseButton className="shell-settings-dialog__close" />
        <DialogBody className="shell-settings-dialog__body">
          <Suspense fallback={null}>
            <SettingsScreen onSignOut={handleSignOut} />
          </Suspense>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
