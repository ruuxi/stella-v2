import { useState } from "react";
import { Button } from "@/ui/button";
import { TextField } from "@/ui/text-field";
import { useT } from "@/shared/i18n";
import type { EngineConnect } from "./use-engine-connect";
import "./EngineConnectPrompt.css";

/**
 * The step of adding a Claude or ChatGPT account that needs the user: the
 * one-time ChatGPT code to approve, or the field for the code Claude shows.
 * Shared by Settings, onboarding and the model picker.
 */
export function EngineConnectPrompt({ connect }: { connect: EngineConnect }) {
  const t = useT();
  const [pasted, setPasted] = useState("");
  const { flow, busy, error } = connect;
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

  return (
    <form
      className="engine-connect-prompt"
      onSubmit={(event) => {
        event.preventDefault();
        void connect.finish(pasted);
      }}
    >
      <p className="engine-connect-prompt__hint">
        {t("mobile.engineAccounts.pasteHintClaude")}
      </p>
      <TextField
        label={t("mobile.engineAccounts.pastePlaceholder")}
        hideLabel
        placeholder={t("mobile.engineAccounts.pastePlaceholder")}
        value={pasted}
        onChange={(event) => setPasted(event.target.value)}
        autoComplete="off"
        spellCheck={false}
        autoFocus
      />
      {error ? (
        <p className="engine-connect-prompt__error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="engine-connect-prompt__actions">
        <Button type="button" variant="ghost" onClick={connect.cancel} disabled={busy}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" variant="primary" disabled={busy || !pasted.trim()}>
          {busy ? t("mobile.engineAccounts.connecting") : t("mobile.engineAccounts.finish")}
        </Button>
      </div>
    </form>
  );
}
