import { useEffect, useState } from "react";
import { Button } from "@/ui/button";
import { useT } from "@/shared/i18n";
import type { ClaudeLogin } from "./use-claude-login";
import "@/features/cloud/EngineConnectPrompt.css";

const K = "settings.engineAccounts.claudeLogin";

/**
 * The one Claude sign-in step, shared by Settings and onboarding. On this
 * computer it waits while the user approves on Anthropic's page, which
 * finishes by itself; in the cloud (or with "Use a code instead") the user
 * pastes the code that page shows.
 */
export function ClaudeLoginPrompt({ login }: { login: ClaudeLogin }) {
  const t = useT();
  const [code, setCode] = useState("");
  const { flow, starting, submitting, error, failed } = login;
  const loginId = flow?.loginId ?? null;
  /** Approving in the browser finishes it: nothing to paste. */
  const approving = flow !== null && !flow.pasting;

  // A new attempt starts with an empty field: the old code belongs to the
  // ended CLI.
  useEffect(() => {
    if (loginId) setCode("");
  }, [loginId]);

  if (!login.open) return null;
  const target = flow?.target ?? starting ?? failed;
  const where =
    target?.place === "cloud" ? t(`${K}.whereCloud`) : t(`${K}.whereComputer`);

  return (
    <div className="engine-connect-prompt" role="group" aria-label={where}>
      <p className="engine-connect-prompt__hint" aria-live="polite">
        {starting ? (
          t(`${K}.starting`)
        ) : approving ? (
          <>
            {where} {t(`${K}.approve`)}{" "}
            <button type="button" className="engine-connect-prompt__link" onClick={login.reopen}>
              {t(`${K}.useCode`)}
            </button>
          </>
        ) : (
          <>
            {where} {t(`${K}.opened`)}{" "}
            {flow ? (
              <button type="button" className="engine-connect-prompt__link" onClick={login.reopen}>
                {t(`${K}.reopen`)}
              </button>
            ) : null}
          </>
        )}
      </p>
      {approving ? null : (
        <input
          className="engine-connect-prompt__input"
          type="text"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && flow) void login.submit(code);
          }}
          placeholder={t(`${K}.codeLabel`)}
          aria-label={t(`${K}.codeLabel`)}
          autoComplete="off"
          spellCheck={false}
          disabled={!flow || submitting}
        />
      )}
      {failed ? (
        <p className="engine-connect-prompt__error" role="alert">
          {error ?? t(`${K}.failed`)}
        </p>
      ) : null}
      <div className="engine-connect-prompt__actions">
        <Button type="button" variant="ghost" onClick={login.cancel}>
          {t("common.cancel")}
        </Button>
        {failed ? (
          <Button type="button" variant="primary" onClick={login.restart}>
            {t(`${K}.startAgain`)}
          </Button>
        ) : approving ? null : (
          <Button
            type="button"
            variant="primary"
            onClick={() => void login.submit(code)}
            disabled={!flow || submitting || !code.trim()}
          >
            {submitting ? t(`${K}.submitting`) : t(`${K}.submit`)}
          </Button>
        )}
      </div>
    </div>
  );
}
