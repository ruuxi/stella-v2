import type { CloudSkillHead } from "@stella/contracts/cloud-home-sync";

const SAFE_TOOL_NAME = /^[A-Za-z0-9_.:-]+$/u;
const MAX_TOOL_NAMES = 64;

export type CloudSkillAuthorizationDraft = {
  allowedAgentTypes: Array<"orchestrator" | "general">;
  toolNamesText: string;
};

export const availableCloudSkillAgentTypes = (
  skill: CloudSkillHead,
): Array<"orchestrator" | "general"> =>
  skill.availability === "both"
    ? ["orchestrator", "general"]
    : [skill.availability];

export const createCloudSkillAuthorizationDraft = (
  skill: CloudSkillHead,
): CloudSkillAuthorizationDraft => {
  const available = availableCloudSkillAgentTypes(skill);
  const authorized = (skill.allowedAgentTypes ?? []).filter((agentType) =>
    available.includes(agentType),
  );
  return {
    // A new package starts with the narrow orchestrator scope. Nothing is
    // authorized until the user presses the explicit version-bound control.
    allowedAgentTypes:
      authorized.length > 0 ? authorized : [available[0] ?? "orchestrator"],
    toolNamesText: (skill.allowedToolNames ?? []).join(", "),
  };
};

export const normalizeCloudSkillToolNames = (
  value: string,
): string[] | null => {
  const names = [
    ...new Set(
      value
        .split(/[\n,]/u)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ].sort();
  if (
    names.length > MAX_TOOL_NAMES ||
    names.some((name) => name.length > 80 || !SAFE_TOOL_NAME.test(name))
  ) {
    return null;
  }
  return names;
};

export const buildCloudSkillAuthorizationArgs = (
  skill: CloudSkillHead,
  draft: CloudSkillAuthorizationDraft,
) => {
  const versionId = skill.versionId?.trim();
  const tools = normalizeCloudSkillToolNames(draft.toolNamesText);
  const available = availableCloudSkillAgentTypes(skill);
  const agents = [...new Set(draft.allowedAgentTypes)].filter((agentType) =>
    available.includes(agentType),
  );
  if (
    !versionId ||
    !skill.ownerGeneration ||
    tools === null ||
    agents.length === 0 ||
    agents.length !== draft.allowedAgentTypes.length
  ) {
    return null;
  }
  return {
    skillId: skill.skillId,
    versionId,
    expectedOwnerGeneration: skill.ownerGeneration,
    expectedAuthorizationRevision: skill.authorizationRevision ?? 0,
    allowedAgentTypes: agents,
    allowedToolNames: tools,
  };
};

export const buildCloudSkillRevocationArgs = (skill: CloudSkillHead) =>
  skill.versionId &&
  skill.authorizationState === "active" &&
  skill.authorizationVersionId === skill.versionId &&
  Number.isSafeInteger(skill.authorizationRevision) &&
  (skill.authorizationRevision ?? -1) >= 0
    ? {
        skillId: skill.skillId,
        expectedOwnerGeneration: skill.ownerGeneration,
        expectedAuthorizationRevision: skill.authorizationRevision!,
      }
    : null;
