import { Button } from "@/ui/button";
import { useT } from "@/shared/i18n";
import type { EngineConnect } from "./use-engine-connect";
import "./EngineConnectPrompt.css";

/**
 * The step of adding a Claude or ChatGPT account that needs the user: the
 * one-time ChatGPT code to approve, or waiting while Claude sign-in finishes
 * in the browser. Shared by Settings, onboarding and the model picker.
 */
export function EngineConnectPrompt({ connect }: { connect: EngineConnect }) {
  const t = useT();
  const { flow, error } = connect;
  if (!flow) return null;

  if (flow.kind === "device") {
    return (
      <div className="engine-connect-prompt" role="group">
        <div className="engine-connect-prompt__code" aria-live="polite">
          {flow.userCode}
        </div>
        <p className="engine-connect-prompt__hint">
          {t("mobile.engineAccounts.deviceHint")}
        </p>
        {error ? (
          <p className="engine-connect-prompt__error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="engine-connect-prompt__actions">
          <Button type="button" variant="ghost" onClick={connect.cancel}>
            {t("common.cancel")}
          </Button>
          <Button type="button" variant="primary" onClick={connect.openDevicePage}>
            {t("mobile.engineAccounts.deviceOpen")}
          </Button>
        </div>
      </div>
    );
  }

  // Claude: the browser is open and this computer is waiting for its callback.
  return (
    <div className="engine-connect-prompt" role="group">
      <p className="engine-connect-prompt__hint" aria-live="polite">
        {t("mobile.engineAccounts.connecting")}
      </p>
      <div className="engine-connect-prompt__actions">
        <Button type="button" variant="ghost" onClick={connect.cancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  );
}
