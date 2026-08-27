import { useMemo, useState } from "react";
import { useMutation, useQueries, type RequestForQueries } from "convex/react";
import type { CloudSkillHead } from "@stella/contracts/cloud-home-sync";
import { Button } from "@/ui/button";
import { useT } from "@/shared/i18n";
import { cloudHomeApi } from "./cloud-home-api";
import {
  availableCloudSkillAgentTypes,
  buildCloudSkillAuthorizationArgs,
  buildCloudSkillRevocationArgs,
  createCloudSkillAuthorizationDraft,
  normalizeCloudSkillToolNames,
} from "./cloud-home-skills-settings-policy";

function CloudSkillAuthorizationRow({ skill }: { skill: CloudSkillHead }) {
  const t = useT();
  const authorize = useMutation(cloudHomeApi.authorizeMySkill);
  const revoke = useMutation(cloudHomeApi.revokeMySkill);
  const setEnabled = useMutation(cloudHomeApi.setMySkillEnabled);
  const [draft, setDraft] = useState(() =>
    createCloudSkillAuthorizationDraft(skill),
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const currentAuthorization =
    skill.authorizationState === "active" &&
    skill.authorizationVersionId === skill.versionId;
  const toolNames = normalizeCloudSkillToolNames(draft.toolNamesText);

  const toggleAgent = (agentType: "orchestrator" | "general") => {
    if (!availableCloudSkillAgentTypes(skill).includes(agentType)) return;
    setDraft((current) => ({
      ...current,
      allowedAgentTypes: current.allowedAgentTypes.includes(agentType)
        ? current.allowedAgentTypes.filter((entry) => entry !== agentType)
        : [...current.allowedAgentTypes, agentType],
    }));
  };

  const run = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setMessage(null);
    try {
      await operation();
      setMessage(t("settings.account.cloudSkills.saved"));
    } catch {
      setMessage(t("settings.account.cloudSkills.saveError"));
    } finally {
      setBusy(false);
    }
  };

  const authorizationArgs = buildCloudSkillAuthorizationArgs(skill, draft);
  const revocationArgs = buildCloudSkillRevocationArgs(skill);
  const versionLabel = skill.versionId
    ? `${skill.versionId.slice(0, 18)}${skill.versionId.length > 18 ? "…" : ""}`
    : t("settings.account.cloudSkills.notPublished");
  const statusLabel = !skill.enabled
    ? t("settings.account.cloudSkills.status.disabled")
    : currentAuthorization
      ? t("settings.account.cloudSkills.status.authorized")
      : t("settings.account.cloudSkills.status.notAuthorized");

  return (
    <div className="settings-row" data-cloud-skill={skill.slug}>
      <div className="settings-row-info">
        <div className="settings-row-label">{skill.name}</div>
        <div className="settings-row-sublabel">
          {t("settings.account.cloudSkills.versionStatus", {
            description: skill.description,
            version: versionLabel,
            status: statusLabel,
          })}
        </div>
        <div className="settings-row-sublabel">
          {t("settings.account.cloudSkills.agentScope")}
          {(["orchestrator", "general"] as const).map((agentType) => {
            const available =
              availableCloudSkillAgentTypes(skill).includes(agentType);
            const selected = draft.allowedAgentTypes.includes(agentType);
            return (
              <Button
                key={agentType}
                type="button"
                variant="ghost"
                className="pill-btn"
                aria-pressed={selected}
                disabled={busy || !available}
                onClick={() => toggleAgent(agentType)}
              >
                {selected ? "✓ " : ""}
                {t(`settings.account.cloudSkills.agentType.${agentType}`)}
              </Button>
            );
          })}
        </div>
        <label className="settings-row-sublabel">
          {t("settings.account.cloudSkills.allowedTools")}
          <input
            type="text"
            value={draft.toolNamesText}
            maxLength={5_184}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                toolNamesText: event.currentTarget.value,
              }))
            }
          />
        </label>
        {toolNames === null ? (
          <div className="settings-row-sublabel" role="alert">
            {t("settings.account.cloudSkills.invalidTools")}
          </div>
        ) : null}
        {message ? (
          <div className="settings-row-sublabel" role="status">
            {message}
          </div>
        ) : null}
      </div>
      <div className="settings-row-control settings-row-control--stacked">
        {currentAuthorization ? (
          <Button
            type="button"
            variant="ghost"
            className="pill-btn"
            disabled={busy || !revocationArgs}
            onClick={() =>
              revocationArgs && void run(() => revoke(revocationArgs))
            }
          >
            {busy
              ? t("settings.account.cloudSkills.actions.saving")
              : t("settings.account.cloudSkills.actions.revoke")}
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            className="pill-btn"
            disabled={busy || !authorizationArgs}
            onClick={() =>
              authorizationArgs && void run(() => authorize(authorizationArgs))
            }
          >
            {busy
              ? t("settings.account.cloudSkills.actions.saving")
              : t("settings.account.cloudSkills.actions.authorize")}
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          className="pill-btn"
          disabled={busy}
          onClick={() =>
            void run(() =>
              setEnabled({
                skillId: skill.skillId,
                enabled: !skill.enabled,
                expectedOwnerGeneration: skill.ownerGeneration,
                expectedRevision: skill.revision,
              }),
            )
          }
        >
          {skill.enabled
            ? t("settings.account.cloudSkills.actions.disable")
            : t("settings.account.cloudSkills.actions.enable")}
        </Button>
      </div>
    </div>
  );
}

export function CloudHomeSkillsSettings({
  accountScope,
}: {
  accountScope: string;
}) {
  const t = useT();
  const requests = useMemo<RequestForQueries>(
    () => ({
      skills: {
        query: cloudHomeApi.listMySkills,
        args: { clientScope: accountScope },
      },
    }),
    [accountScope],
  );
  const result = useQueries(requests).skills;
  const skills = Array.isArray(result) ? (result as CloudSkillHead[]) : [];

  return (
    <div className="settings-card" key={accountScope}>
      <h3 className="settings-card-title">
        {t("settings.account.cloudSkills.title")}
      </h3>
      {result === undefined ? (
        <div className="settings-row-sublabel" role="status">
          {t("settings.account.cloudSkills.loading")}
        </div>
      ) : result instanceof Error ? (
        <div className="settings-row-sublabel" role="alert">
          {t("settings.account.cloudSkills.unavailable")}
        </div>
      ) : skills.length === 0 ? (
        <div className="settings-row-sublabel">
          {t("settings.account.cloudSkills.empty")}
        </div>
      ) : (
        skills.map((skill) => (
          <CloudSkillAuthorizationRow
            key={`${skill.skillId}:${skill.versionId ?? "none"}:${skill.authorizationRevision ?? 0}`}
            skill={skill}
          />
        ))
      )}
    </div>
  );
}
