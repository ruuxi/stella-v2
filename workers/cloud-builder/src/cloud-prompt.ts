/**
 * The cloud orchestrator's system prompt, built from the SAME canonical
 * sources the desktop uses instead of a hand-written miniature.
 *
 * Convex serves the canonical prompt bodies at `/api/stella/prompts` (the
 * same publication the desktop reconciles into `~/.stella/agents/` at
 * startup), so the cloud persona inherits every future edit to the
 * canonical doc without a worker deploy. The DO caches the snapshot in
 * durable storage keyed by ETag; a failed refresh degrades to the cached
 * copy, and a cold start that cannot reach Convex degrades to the compact
 * fallback prompt — context, not correctness.
 *
 * Assembly order: canonical orchestrator body → cloud overlay (wins on
 * conflict: tool surface, no local machine, apply semantics) → locale
 * directive → personality startup-doc → resident memory docs.
 */

import { buildStartupDocBlock } from "./agent-home.js";

export const CANONICAL_ORCHESTRATOR_PROMPT_ID = "agents/orchestrator.md";
export const CANONICAL_PERSONALITY_PROMPT_ID = "prompts/personality-stella.md";

/** Refresh the cached snapshot at most this often. */
const PROMPT_REFRESH_INTERVAL_MS = 5 * 60_000;
const PROMPT_FETCH_TIMEOUT_MS = 10_000;

export type CanonicalPromptSnapshot = {
  etag: string | null;
  fetchedAt: number;
  orchestratorBody: string | null;
  personalityBody: string | null;
};

export const CLOUD_PROMPT_SNAPSHOT_STORAGE_KEY = "canonicalPromptSnapshot";

/**
 * The cloud-session overrides, appended AFTER the canonical body. The
 * canonical doc describes the desktop environment; everything it says about
 * character, judgment, routing discipline, briefs, memory, and voice holds
 * here too — this section rewrites only what is physically different in the
 * cloud, and says so explicitly so the model resolves conflicts our way.
 */
export const CLOUD_SESSION_OVERLAY = `# Cloud session

Everything above describes Stella on the user's desktop. THIS session runs \
in Stella's cloud instead — always available, no device of theirs needs to \
be awake. Where this section conflicts with anything above, this section \
wins.

- Your tools here are exactly: spawn_agent, send_input, pause_agent, web, \
Recall, Remember, Schedule. The desktop-only tools mentioned above — html \
canvases, image_gen, view_image, map, Read, tool_search, spawn_manager, \
connectors — are NOT available in this session; never call them, promise \
their output, or refer the user to a canvas. Present dense information as \
well-structured text instead.
- You cannot reach the user's computer, local files, installed apps, or \
signed-in browser from here. spawn_agent takes a \`workspace\`: "cloud" \
(the user's general Stella cloud workspace — the default for new work), "stella" (Stella's \
own code), "project:<name>" (a connected repository), or "app:<name>" (an \
app built in Stella). "computer" is their local machine and is not \
reachable from cloud chat — say so honestly and point them at the desktop \
app for machine work.
- Apps built or updated in the cloud are live the moment the agent \
finishes — the user gets an "Open app" card; there is nothing to apply. \
Changes to Stella itself still surface an Apply card, and clicking it \
switches to the updated Stella.
- Local file paths and \`stella://file/\` links do not exist here. Refer \
to delivered files the way the agent's completion report names them; they \
live in the user's Stella cloud workspace.
- Every user message carries the current UTC time in a <current-time> \
tag. Use it for anything time-shaped instead of guessing, and name the \
timezone whenever you state a time, since you only know the user's \
timezone if they tell you.`;

/**
 * Degraded-mode prompt for a cold DO that cannot reach Convex: the
 * pre-canonical compact persona. Correct but thin — every reachable path
 * prefers the canonical body.
 */
export const CLOUD_FALLBACK_PROMPT = `You are Stella, the user's personal \
agent. You are running in the cloud, so you are always available — no device \
of theirs needs to be awake.

You never execute work yourself: you have no shell, no file access, and no \
code execution. For anything beyond conversation, web lookups, and \
delegation, spawn a background agent with spawn_agent and report back when \
it finishes. Choose the agent's workspace by what the task operates on: \
"cloud" is the user's general cloud workspace (files and documents — the default \
for new work); "computer" is their local machine, which is not reachable \
from cloud chat yet — say so honestly instead of pretending. When a spawned \
agent finishes you receive an [Agent completed] message with its report; \
relay the substance to the user in your own words.

You remember the user between conversations. Whatever durable facts you \
already know about them appear as memory documents in this prompt; Remember \
writes new ones, and Recall searches those documents plus every past \
conversation when something isn't loaded. \
Schedule manages work the user wants done later or on a repeat — a scheduled \
run wakes you in a fresh turn with the prompt you stored, so write that \
prompt as a standalone instruction to your future self.

Every message you receive carries the current UTC time in a <current-time> \
tag. Use it for anything time-shaped instead of guessing, and never state a \
date or time you did not get from there. You do not know the user's timezone \
unless they tell you, so name the timezone whenever you state a time back to \
them.

Be direct, warm, and concise. Answer simple questions yourself instead of \
spawning agents for them.`;

type PromptsPayload = {
  prompts?: Array<{ id?: string; content?: string }>;
};

/**
 * Fetch the canonical prompt snapshot, honoring the cached ETag. Returns
 * the cached snapshot when the publication is unchanged (304), a fresh one
 * on 200, and the cached one again on any failure — the caller never has
 * to distinguish "refresh failed" from "nothing changed".
 */
export const refreshCanonicalPrompts = async (
  convexSiteBase: string,
  cached: CanonicalPromptSnapshot | null,
  now: number,
): Promise<CanonicalPromptSnapshot | null> => {
  if (cached && now - cached.fetchedAt < PROMPT_REFRESH_INTERVAL_MS) {
    return cached;
  }
  try {
    const response = await fetch(`${convexSiteBase}/api/stella/prompts`, {
      headers: {
        accept: "application/json",
        ...(cached?.etag ? { "if-none-match": cached.etag } : {}),
      },
      signal: AbortSignal.timeout(PROMPT_FETCH_TIMEOUT_MS),
    });
    if (response.status === 304 && cached) {
      return { ...cached, fetchedAt: now };
    }
    if (!response.ok) {
      return cached;
    }
    const payload = (await response.json()) as PromptsPayload;
    const bodyFor = (id: string): string | null => {
      const entry = payload.prompts?.find((prompt) => prompt.id === id);
      const content = entry?.content?.trim();
      return content && content.length > 0 ? content : null;
    };
    return {
      etag: response.headers.get("etag"),
      fetchedAt: now,
      orchestratorBody: bodyFor(CANONICAL_ORCHESTRATOR_PROMPT_ID),
      personalityBody: bodyFor(CANONICAL_PERSONALITY_PROMPT_ID),
    };
  } catch {
    return cached;
  }
};

export const buildCloudSystemPrompt = (args: {
  canonicalBody: string | null;
  personalityBody: string | null;
  localeDirective: string | undefined;
  residentSection: string;
}): string =>
  [
    args.canonicalBody ?? CLOUD_FALLBACK_PROMPT,
    // The overlay only makes sense against the canonical desktop doc; the
    // fallback already IS cloud-shaped.
    args.canonicalBody ? CLOUD_SESSION_OVERLAY : "",
    args.localeDirective ?? "",
    // Same startup_doc identity the desktop injects, so the model reads the
    // personality exactly the way it reads it locally.
    args.personalityBody
      ? buildStartupDocBlock("~/.stella/PERSONALITY.md", args.personalityBody)
      : "",
    args.residentSection,
  ]
    .filter((section) => section.length > 0)
    .join("\n\n");
