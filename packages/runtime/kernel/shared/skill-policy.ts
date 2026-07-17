export const RETIRED_BUNDLED_SKILL_IDS = [
  "create-stella-app",
  "stella-desktop",
  "stella-llm",
  "stella-runtime-extension",
] as const;

const RETIRED_BUNDLED_SKILL_ID_SET = new Set<string>(RETIRED_BUNDLED_SKILL_IDS);

export const isRetiredBundledSkillId = (skillId: string): boolean =>
  RETIRED_BUNDLED_SKILL_ID_SET.has(skillId);
