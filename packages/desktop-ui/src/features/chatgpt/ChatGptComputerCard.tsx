import { useCallback, useState } from "react";
import { showToast } from "@/ui/toast";
import { EngineAccountList, type EngineAccountRow } from "@/features/cloud/EngineAccountList";
import {
  announceChatGptPlanUse,
  ContinueWithChatGptButton,
  ManageChatGptUsageLink,
} from "./ChatGptBrand";
import { useChatGptProfiles } from "./use-chatgpt-profiles";

/**
 * "ChatGPT on this computer": this install's own Sign in with ChatGPT
 * accounts. Desktop only. The computer signs in through the browser,
 * keeps the credentials in its keychain-protected store, refreshes them
 * itself, and calls OpenAI directly; Stella's server never sees them.
 */

const friendlyError = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : "That didn't work. Try again.";

export function ChatGptComputerCard() {
  const chatgpt = useChatGptProfiles();
  const [busy, setBusy] = useState(false);
  const { signIn } = chatgpt;

  const run = useCallback(async (action: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await action();
      if (done) showToast({ title: done });
    } catch (error) {
      showToast({ title: friendlyError(error), variant: "error" });
    } finally {
      setBusy(false);
    }
  }, []);

  const handleSignIn = useCallback(
    async (options?: { profileId?: string; enablePlanUsage?: boolean }) => {
      try {
        const profile = await signIn(options);
        if (!profile) return;
        if (profile.planUsage) {
          showToast({ title: "This computer is signed in to ChatGPT." });
          announceChatGptPlanUse();
        } else {
          showToast({
            title: "Signed in, but ChatGPT plan use isn't enabled",
            description:
              "Stella can't use your ChatGPT plan until you allow it. Choose “Enable ChatGPT plan use” on the account, or use another model.",
          });
        }
      } catch (error) {
        showToast({ title: friendlyError(error), variant: "error" });
      }
    },
    [signIn],
  );

  if (!chatgpt.available) return null;

  const accounts: EngineAccountRow[] = chatgpt.profiles.map((profile) => ({
    id: profile.id,
    label: profile.name ?? profile.label,
    ...(profile.email ? { email: profile.email } : {}),
    active: profile.active,
    ...(profile.limitedUntil ? { limitedUntil: profile.limitedUntil } : {}),
    ...(profile.status !== "signed_in" ? { status: profile.status } : {}),
    planUsage: profile.planUsage,
    limitText: "Usage limit reached",
  }));

  const revokeNote = (result: { revoked: boolean } | undefined) => {
    if (result && !result.revoked) {
      showToast({
        title: "Signed out on this computer",
        description:
          "ChatGPT didn't confirm the sign-out. You can disconnect Stella in ChatGPT Settings.",
      });
    }
  };

  return (
    <div className="settings-card">
      <h3 className="settings-card-title">ChatGPT on this computer</h3>
      <EngineAccountList
        title="ChatGPT"
        description="Stella on this computer uses your ChatGPT plan when you pick a ChatGPT model, and that usage counts against your plan. This computer keeps its own sign-in in its keychain and talks to OpenAI directly."
        accounts={accounts}
        autoSwitch={chatgpt.autoSwitch}
        autoSwitchDescription="When the checked account reaches a ChatGPT usage limit, move to the next signed-in account on this computer."
        busy={busy || !chatgpt.loaded}
        adding={chatgpt.signingIn}
        addLabel="Add account"
        onAdd={() => void handleSignIn()}
        addButton={
          <ContinueWithChatGptButton
            onClick={() => void handleSignIn()}
            disabled={busy}
            loading={chatgpt.signingIn}
          />
        }
        onUse={(profileId) => void run(() => chatgpt.setActive(profileId))}
        onSignOut={(profileId) =>
          void run(async () => revokeNote(await chatgpt.signOut(profileId)), "Signed out.")
        }
        onSignInAgain={(profileId) => void handleSignIn({ profileId })}
        onEnablePlanUsage={(profileId) => void handleSignIn({ profileId, enablePlanUsage: true })}
        onRemove={(profileId) =>
          void run(async () => revokeNote(await chatgpt.remove(profileId)), "Removed.")
        }
        onToggleAutoSwitch={(enabled) => void run(() => chatgpt.setAutoSwitch(enabled))}
        addFlow={
          chatgpt.signingIn ? (
            <div className="settings-row">
              <div className="settings-row-sublabel" aria-live="polite">
                Finish signing in to ChatGPT in your browser.
              </div>
              <div className="settings-row-control">
                <button type="button" className="pill-btn" onClick={chatgpt.cancelSignIn}>
                  Cancel
                </button>
              </div>
            </div>
          ) : null
        }
        footer={
          accounts.length > 0 ? (
            <div className="settings-row">
              <div className="settings-row-sublabel">
                Review your ChatGPT usage, or set how much of your plan Stella may use, in
                ChatGPT Settings.
              </div>
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
