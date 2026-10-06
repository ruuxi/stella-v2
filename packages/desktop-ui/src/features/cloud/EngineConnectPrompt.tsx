import { useState } from "react";
import { Button } from "@/ui/button";
import { useT } from "@/shared/i18n";
import type { EngineConnect } from "./use-engine-connect";
import "./EngineConnectPrompt.css";

/**
 * The step of signing the cloud in to ChatGPT that needs the user: waiting
 * while the browser sign-in finishes (desktop), or pasting back the address
 * ChatGPT redirected to (a browser, where nothing listens on 127.0.0.1).
 * Shared by Settings and onboarding.
 */
export function EngineConnectPrompt({ connect }: { connect: EngineConnect }) {
  const t = useT();
  const { flow, error, busy } = connect;
  const [pasted, setPasted] = useState("");
  if (!flow) return null;

  if (flow.kind === "paste") {
    return (
      <div className="engine-connect-prompt" role="group">
        <p className="engine-connect-prompt__hint">
          {t("settings.engineAccounts.pasteHintChatgpt")}
        </p>
        <input
          className="engine-connect-prompt__input"
          type="url"
          value={pasted}
          onChange={(event) => setPasted(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void connect.finish(pasted);
          }}
          placeholder={t("settings.engineAccounts.pastePlaceholderUrl")}
          aria-label={t("settings.engineAccounts.pastePlaceholderUrl")}
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
        />
        {error ? (
          <p className="engine-connect-prompt__error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="engine-connect-prompt__actions">
          <Button type="button" variant="ghost" onClick={connect.cancel}>
            {t("common.cancel")}
          </Button>
          <Button type="button" variant="ghost" onClick={connect.openAuthorizePage}>
            {t("settings.engineAccounts.openChatgptAgain")}
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={() => void connect.finish(pasted)}
            disabled={busy || !pasted.trim()}
          >
            {busy ? t("settings.engineAccounts.connecting") : t("settings.engineAccounts.finish")}
          </Button>
        </div>
      </div>
    );
  }

  // The browser is open and this computer is waiting for its callback.
  return (
    <div className="engine-connect-prompt" role="group">
      <p className="engine-connect-prompt__hint" aria-live="polite">
        {t("settings.engineAccounts.chatgptBrowserWaiting")}
      </p>
      <div className="engine-connect-prompt__actions">
        <Button type="button" variant="ghost" onClick={connect.cancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  );
}
