import type { ChatGptSharedRegistration } from "@stella/contracts/backend/engines";
import { useT } from "@/shared/i18n";
import { ContinueWithChatGptButton } from "./ChatGptBrand";

/**
 * One-click sign-ins with a ChatGPT registration another of the owner's
 * hosts already made: "Continue with ChatGPT as <email>". The sign-in runs
 * with that issued client id and this host's own host id; tokens stay here.
 */
export function ChatGptSharedRegistrations({
  registrations,
  disabled,
  onContinue,
}: {
  registrations: readonly ChatGptSharedRegistration[];
  disabled: boolean;
  onContinue: (clientId: string) => void;
}) {
  const t = useT();
  if (registrations.length === 0) return null;
  return (
    <>
      {registrations.map((registration) => (
        <div className="settings-row" key={registration.clientId}>
          <div className="settings-row-sublabel">
            {t("settings.engineAccounts.sharedRegistrationHint")}
          </div>
          <div className="settings-row-control">
            <ContinueWithChatGptButton
              onClick={() => onContinue(registration.clientId)}
              disabled={disabled}
              label={t("settings.engineAccounts.continueAs", {
                name: registration.email ?? registration.name ?? "",
              })}
            />
          </div>
        </div>
      ))}
    </>
  );
}
