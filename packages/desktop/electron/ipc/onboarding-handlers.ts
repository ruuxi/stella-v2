import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import type {
  OnboardingStarter,
  OnboardingSynthesisRequest,
  OnboardingSynthesisResponse,
} from "@stella/contracts/desktop/onboarding";
import type {
  RuntimeOneShotCompletionRequest,
  RuntimeOneShotCompletionResult,
} from "@stella/contracts/protocol";
import { STELLA_DEFAULT_MODEL } from "@stella/contracts/stella-api";
import { readRuntimePrompt } from "@stella/runtime/kernel/prompts/home-prompts";

type OneShotRunner = {
  runOneShotCompletion(
    request: RuntimeOneShotCompletionRequest,
  ): Promise<RuntimeOneShotCompletionResult>;
};

type OnboardingHandlersOptions = {
  getStellaHostRunner: () => OneShotRunner | null;
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
};

const CATEGORY_LABELS: Record<string, string> = {
  browsing_bookmarks: "Browsing & Bookmarks",
  dev_environment: "Development Environment",
  apps_system: "Apps & System",
  messages_notes: "Messages & Notes",
};

const DEFAULT_WELCOME_MESSAGE =
  "Hey! I'm Stella, your AI assistant. What can I help you with today?";
const CATEGORY_ANALYSIS_MAX_OUTPUT_TOKENS = 30_000;
const MAX_PROFILE_HIGHLIGHTS = 5;
const MAX_STARTERS = 4;

const trimToLength = (value: unknown, max: number): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max).trim() : trimmed;
};

/**
 * The starters prompt asks for JSON only, but a code fence or a sentence of
 * preamble still slips through now and then; tolerate both and never throw.
 * A bad output means the finale falls back to its generic starters.
 */
const parseStarters = (
  raw: string,
): { profileHighlights: string[]; starters: OnboardingStarter[] } | null => {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const profileHighlights = Array.isArray(record.highlights)
    ? record.highlights
        .map((entry) => trimToLength(entry, 48))
        .filter((entry): entry is string => Boolean(entry))
        .slice(0, MAX_PROFILE_HIGHLIGHTS)
    : [];
  const starters = Array.isArray(record.starters)
    ? record.starters
        .map((entry) => {
          if (!entry || typeof entry !== "object") return null;
          const item = entry as Record<string, unknown>;
          const title = trimToLength(item.title, 60);
          const prompt = trimToLength(item.prompt, 280);
          return title && prompt ? { title, prompt } : null;
        })
        .filter((entry): entry is OnboardingStarter => Boolean(entry))
        .slice(0, MAX_STARTERS)
    : [];
  if (profileHighlights.length === 0 && starters.length === 0) return null;
  return { profileHighlights, starters };
};

/**
 * Discovery synthesis on this device: per-category analyses, then core
 * memory, then the welcome line and the finale's highlights and starters,
 * each a one-shot completion through the runtime's model routing.
 */
const synthesize = async (
  runner: OneShotRunner,
  payload: OnboardingSynthesisRequest,
): Promise<OnboardingSynthesisResponse> => {
  const config = payload.promptConfig;
  const coreSystemPrompt = config?.coreMemorySystemPrompt?.trim();
  const coreUserTemplate = config?.coreMemoryUserPromptTemplate?.trim();
  const welcomeTemplate = config?.welcomeMessagePromptTemplate?.trim();
  if (!coreSystemPrompt || !coreUserTemplate || !welcomeTemplate) {
    throw new Error("Missing synthesis prompt payload.");
  }
  const sections = Object.entries(payload.formattedSections ?? {}).filter(
    ([, data]) => typeof data === "string" && data.trim().length > 0,
  );
  if (sections.length === 0) {
    throw new Error("formattedSections is required.");
  }

  const complete = async (
    agentType: string,
    userText: string,
    options: { systemPrompt?: string; maxOutputTokens?: number } = {},
  ): Promise<string> =>
    (
      // Pinned to Stella's default so a per-agent model override can't
      // send the user's raw browsing data somewhere unexpected.
      await runner.runOneShotCompletion({
        agentType,
        userText,
        model: STELLA_DEFAULT_MODEL,
        ...options,
      })
    ).text.trim();

  const analysisTemplate = config.categoryAnalysisUserPromptTemplate?.trim();
  const analyses = await Promise.all(
    sections.map(async ([category, data]) => {
      const systemPrompt = config.categoryAnalysisSystemPrompts?.[category];
      if (!systemPrompt || !analysisTemplate) return { category, analysis: data };
      const userText = analysisTemplate
        .replace("{{categoryLabel}}", CATEGORY_LABELS[category] ?? category)
        .replace("{{data}}", data);
      return {
        category,
        analysis: await complete("synthesis", userText, {
          systemPrompt,
          maxOutputTokens: CATEGORY_ANALYSIS_MAX_OUTPUT_TOKENS,
        }),
      };
    }),
  );
  const usable = analyses.filter((entry) => entry.analysis.length > 0);
  const categoryAnalyses = Object.fromEntries(
    usable.map((entry) => [entry.category, entry.analysis]),
  );

  const coreMemory = await complete(
    "synthesis",
    `${coreUserTemplate}\n\n${usable.map((entry) => entry.analysis).join("\n\n")}`,
    { systemPrompt: coreSystemPrompt },
  );
  if (!coreMemory) throw new Error("Failed to synthesize core memory.");

  const startersPrompt = readRuntimePrompt("synthesis");
  const [welcomeMessage, finale] = await Promise.all([
    complete("welcome", welcomeTemplate.replace("{{coreMemory}}", coreMemory)),
    // Best effort: core memory and the greeting are what the app depends on.
    startersPrompt
      ? complete(
          "welcome",
          startersPrompt.replace("{{coreMemory}}", coreMemory),
        )
          .then(parseStarters)
          .catch((error: unknown) => {
            console.error("[onboarding] Synthesis starters failed.", error);
            return null;
          })
      : Promise.resolve(null),
  ]);

  return {
    coreMemory,
    welcomeMessage: welcomeMessage || DEFAULT_WELCOME_MESSAGE,
    ...(Object.keys(categoryAnalyses).length > 0 ? { categoryAnalyses } : {}),
    ...(finale ?? {}),
  };
};

export const registerOnboardingHandlers = (
  options: OnboardingHandlersOptions,
) => {
  ipcMain.handle(
    "onboarding:synthesizeCoreMemory",
    async (event, payload: OnboardingSynthesisRequest) => {
      if (
        !options.assertPrivilegedSender(event, "onboarding:synthesizeCoreMemory")
      ) {
        throw new Error(
          "Blocked untrusted onboarding:synthesizeCoreMemory request.",
        );
      }
      const runner = options.getStellaHostRunner();
      if (!runner) throw new Error("Stella runtime is not ready.");
      return await synthesize(runner, payload);
    },
  );
};
