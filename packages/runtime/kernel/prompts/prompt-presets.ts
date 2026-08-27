import { promises as fs } from "node:fs";
import path from "node:path";

import { extractFrontmatter } from "../frontmatter.js";
import { ensurePrivateDir } from "../shared/private-fs.js";

export const CUSTOMIZABLE_PROMPT_AGENT_IDS = [
  "orchestrator",
  "general",
] as const;
export type CustomizablePromptAgentId =
  (typeof CUSTOMIZABLE_PROMPT_AGENT_IDS)[number];

export const DEFAULT_PROMPT_PRESET_ID = "default";
export const MAX_PROMPT_PRESET_BYTES = 256 * 1024;
const PRESETS_DIR_NAME = "prompts";

export type PromptPreset = {
  id: string;
  name: string;
  agentId: CustomizablePromptAgentId;
  content: string;
};

export type PromptPresetSummary = Omit<PromptPreset, "content">;

export const isCustomizablePromptAgentId = (
  value: unknown,
): value is CustomizablePromptAgentId =>
  typeof value === "string" &&
  (CUSTOMIZABLE_PROMPT_AGENT_IDS as readonly string[]).includes(value);

export const promptSelectionAgentId = (
  agentType: string,
): CustomizablePromptAgentId | null => {
  if (agentType.startsWith("orchestrator")) return "orchestrator";
  return isCustomizablePromptAgentId(agentType) ? agentType : null;
};

export const slugifyPresetName = (name: string): string => {
  const slug = name
    .normalize("NFKD")

    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "preset";
};

const presetsDir = (
  stellaDataDir: string,
  agentId: CustomizablePromptAgentId,
): string => path.join(stellaDataDir, PRESETS_DIR_NAME, agentId);

const presetPath = (
  stellaDataDir: string,
  agentId: CustomizablePromptAgentId,
  id: string,
): string => path.join(presetsDir(stellaDataDir, agentId), `${id}.md`);

const isSafePresetId = (id: string): boolean =>
  /^[a-z0-9][a-z0-9-]{0,63}$/.test(id) && id !== DEFAULT_PROMPT_PRESET_ID;

const parsePreset = (
  agentId: CustomizablePromptAgentId,
  id: string,
  raw: string,
): PromptPreset => {
  const parsed = extractFrontmatter(raw);
  const name =
    typeof parsed.metadata.name === "string" && parsed.metadata.name.trim()
      ? parsed.metadata.name.trim()
      : id;
  return { id, name, agentId, content: parsed.body.trim() };
};

export const readPromptPreset = async (
  stellaDataDir: string,
  agentId: CustomizablePromptAgentId,
  id: string,
): Promise<PromptPreset | null> => {
  if (!isSafePresetId(id)) return null;
  try {
    const raw = await fs.readFile(
      presetPath(stellaDataDir, agentId, id),
      "utf-8",
    );
    const preset = parsePreset(agentId, id, raw);
    return preset.content ? preset : null;
  } catch {
    return null;
  }
};

export const listPromptPresets = async (
  stellaDataDir: string,
  agentId: CustomizablePromptAgentId,
): Promise<PromptPresetSummary[]> => {
  let entries;
  try {
    entries = await fs.readdir(presetsDir(stellaDataDir, agentId), {
      withFileTypes: true,
    });
  } catch {
    return [];
  }
  const ids = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name.slice(0, -3))
    .filter(isSafePresetId)
    .sort((a, b) => a.localeCompare(b));
  const presets: PromptPresetSummary[] = [];
  for (const id of ids) {
    const preset = await readPromptPreset(stellaDataDir, agentId, id);
    if (preset) {
      presets.push({ id: preset.id, name: preset.name, agentId });
    }
  }
  return presets;
};

export type SavePromptPresetResult =
  | { ok: true; preset: PromptPresetSummary }
  | { ok: false; error: string };

export const savePromptPreset = async (
  stellaDataDir: string,
  args: {
    agentId: CustomizablePromptAgentId;
    id?: string;
    name: string;
    content: string;
  },
): Promise<SavePromptPresetResult> => {
  const name = args.name.trim();
  const content = args.content.trim();
  if (!name) return { ok: false, error: "A prompt name is required." };
  if (!content) return { ok: false, error: "The prompt cannot be empty." };
  if (Buffer.byteLength(content, "utf-8") > MAX_PROMPT_PRESET_BYTES) {
    return { ok: false, error: "The prompt is too large." };
  }

  let id = args.id;
  if (id !== undefined) {
    if (!isSafePresetId(id)) return { ok: false, error: "Unknown prompt." };
  } else {
    const base = slugifyPresetName(name);
    let candidate = base;
    let suffix = 2;
    while (
      (await readPromptPreset(stellaDataDir, args.agentId, candidate)) !== null
    ) {
      candidate = `${base}-${suffix++}`.slice(0, 64);
    }
    id = candidate;
    if (!isSafePresetId(id)) return { ok: false, error: "Invalid prompt name." };
  }

  const dir = presetsDir(stellaDataDir, args.agentId);
  await ensurePrivateDir(dir);
  const target = presetPath(stellaDataDir, args.agentId, id);
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  const serialized = `---\nname: ${JSON.stringify(name)}\n---\n\n${content}\n`;
  try {
    await fs.writeFile(temp, serialized, { encoding: "utf-8", mode: 0o600 });
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  return { ok: true, preset: { id, name, agentId: args.agentId } };
};

export const deletePromptPreset = async (
  stellaDataDir: string,
  agentId: CustomizablePromptAgentId,
  id: string,
): Promise<boolean> => {
  if (!isSafePresetId(id)) return false;
  try {
    await fs.rm(presetPath(stellaDataDir, agentId, id), { force: true });
    return true;
  } catch {
    return false;
  }
};
