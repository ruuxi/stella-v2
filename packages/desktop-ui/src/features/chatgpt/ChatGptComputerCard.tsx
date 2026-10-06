import { useCallback, useState } from "react";
import { showToast } from "@/ui/toast";
import { useT } from "@/shared/i18n";
import { useAuthState } from "@/global/auth/BackendAuthProvider";
import { useCloudEngines } from "@/features/cloud/cloud-engines-api";
import { EngineAccountList, type EngineAccountRow } from "@/features/cloud/EngineAccountList";
import {
  announceChatGptPlanUse,
  ContinueWithChatGptButton,
  ManageChatGptUsageLink,
} from "./ChatGptBrand";
import { ChatGptSharedRegistrations } from "./ChatGptSharedRegistrations";
import { useChatGptProfiles } from "./use-chatgpt-profiles";

/**
 * "ChatGPT on this computer": this install's own Sign in with ChatGPT
 * accounts. Desktop only. The computer signs in through the browser,
 * keeps the credentials in its keychain-protected store, refreshes them
 * itself, and calls OpenAI directly; Stella's server never sees them. A
 * registration another of the owner's hosts made can be reused in one click.
 */

const K = "settings.engineAccounts";

const sameEmail = (a: string | undefined, b: string | undefined) =>
  Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());

export function ChatGptComputerCard() {
  const t = useT();
  const chatgpt = useChatGptProfiles();
  const { isAuthenticated } = useAuthState();
  const engines = useCloudEngines(isAuthenticated && chatgpt.available);
  const [busy, setBusy] = useState(false);
  const { signIn } = chatgpt;

  const errorTitle = useCallback(
    (error: unknown) =>
      error instanceof Error && error.message ? error.message : t(`${K}.errorGeneric`),
    [t],
  );

  const run = useCallback(
    async (action: () => Promise<unknown>, done?: string) => {
      setBusy(true);
      try {
        await action();
        if (done) showToast({ title: done });
      } catch (error) {
        showToast({ title: errorTitle(error), variant: "error" });
      } finally {
        setBusy(false);
      }
    },
    [errorTitle],
  );

  const handleSignIn = useCallback(
    async (options?: { profileId?: string; sharedClientId?: string; enablePlanUsage?: boolean }) => {
      try {
        const profile = await signIn(options);
        if (!profile) return;
        if (profile.planUsage) {
          showToast({ title: t(`${K}.chatgptComputerSignedIn`) });
          announceChatGptPlanUse();
        } else {
          showToast({
            title: t(`${K}.planUsageOffTitle`),
            description: t(`${K}.planUsageOffBody`),
          });
        }
      } catch (error) {
        showToast({ title: errorTitle(error), variant: "error" });
      }
    },
    [errorTitle, signIn, t],
  );

  if (!chatgpt.available) return null;

  const accounts: EngineAccountRow[] = chatgpt.profiles.map((profile) => ({
    id: profile.id,
    label: profile.name ?? profile.label,
    ...(profile.email ? { email: profile.email } : {}),
    active: profile.active,
    ...(profile.status !== "signed_in" ? { status: profile.status } : {}),
    planUsage: profile.planUsage,
  }));
  // Registrations another host made that this computer has no account for.
  const shared = (engines?.chatGptRegistrations ?? []).filter(
    (registration) =>
      (registration.email || registration.name) &&
      !chatgpt.profiles.some(
        (profile) =>
          profile.clientId === registration.clientId ||
          sameEmail(profile.email, registration.email),
      ),
  );

  const revokeNote = (result: { revoked: boolean } | undefined) => {
    if (result && !result.revoked) {
      showToast({
        title: t(`${K}.revokeTitleComputer`),
        description: t(`${K}.revokeUnconfirmed`),
      });
    }
  };

  return (
    <div className="settings-card">
      <h3 className="settings-card-title">{t(`${K}.chatgptComputerCardTitle`)}</h3>
      <EngineAccountList
        title="ChatGPT"
        description={t(`${K}.chatgptComputerDescription`)}
        accounts={accounts}
        busy={busy || !chatgpt.loaded}
        adding={chatgpt.signingIn}
        onAdd={() => void handleSignIn()}
        addButton={
          <ContinueWithChatGptButton
            onClick={() => void handleSignIn()}
            disabled={busy}
            loading={chatgpt.signingIn}
            {...(accounts.length + shared.length > 0
              ? { label: t(`${K}.addAnotherChatgpt`) }
              : {})}
          />
        }
        onUse={(profileId) => void run(() => chatgpt.setActive(profileId))}
        onSignOut={(profileId) =>
          void run(async () => revokeNote(await chatgpt.signOut(profileId)), t(`${K}.signedOut`))
        }
        onSignInAgain={(profileId) => void handleSignIn({ profileId })}
        onEnablePlanUsage={(profileId) => void handleSignIn({ profileId, enablePlanUsage: true })}
        onRemove={(profileId) =>
          void run(async () => revokeNote(await chatgpt.remove(profileId)), t(`${K}.removed`))
        }
        addFlow={
          <>
            <ChatGptSharedRegistrations
              registrations={shared}
              disabled={busy || chatgpt.signingIn}
              onContinue={(sharedClientId) => void handleSignIn({ sharedClientId })}
            />
            {chatgpt.signingIn ? (
              <div className="settings-row">
                <div className="settings-row-sublabel" aria-live="polite">
                  {t(`${K}.chatgptBrowserWaiting`)}
                </div>
                <div className="settings-row-control">
                  <button type="button" className="pill-btn" onClick={chatgpt.cancelSignIn}>
                    {t("common.cancel")}
                  </button>
                </div>
              </div>
            ) : null}
          </>
        }
        footer={
          accounts.length > 0 ? (
            <div className="settings-row">
              <div className="settings-row-sublabel">{t(`${K}.manageUsageHint`)}</div>
              <div className="settings-row-control">
                <ManageChatGptUsageLink />
              </div>
            </div>
          ) : null
        }
      />
    </div>
  );
}
