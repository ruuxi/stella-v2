/**
 * Stella's prompt as pi-durable sections.
 *
 * What the desktop pinned as resident startup documents and the cloud froze
 * per turn (personality, memory, skills, execution context, media access)
 * are named sections here. pi-durable renders them before each request and
 * stores only the ones that changed, as positional `pi.system` entries, so
 * an unchanged prompt costs nothing and a changed memory file sends just
 * that file again. Only the preamble stays in the system prompt; the rest is
 * sent as resident context after it (`resident-context.ts`).
 */
import type { Context } from "@earendil-works/chord";
import { defineExtension, section, type PromptInput, type PromptSection } from "@earendil-works/pi-durable";
import {
  renderExecutionDestination,
  renderExecutionDevices,
  renderMediaAccess,
} from "@stella/contracts/execution-context";
import { renderStellaPrompt, stellaPromptTools } from "@stella/contracts/stella-prompts";
import {
  CORE_MEMORY_INJECTED_MAX_CHARS,
  MEMORY_INDEX_INJECTED_MAX_CHARS,
  USER_PROFILE_INJECTED_MAX_CHARS,
} from "@stella/runtime/kernel/memory/memory-layout";
import { shapeResidentMemoryDoc } from "@stella/runtime/kernel/memory/resident-doc-shape";
import { responseLanguageSection } from "@stella/runtime/kernel/runner/locale-prompt";
import { StellaAgentDoc, type StellaAgentRole } from "./agent-doc.ts";
import { messageIdsHook } from "./message-ids.ts";
import { processableImagesHook } from "./processable-images.ts";
import { residentContextHook } from "./resident-context.ts";
import type { StellaAgentPromptId, StellaContextSources } from "./context.ts";
import { renderCloudDestination, renderDeviceDestination, SWITCH_DESTINATION_TOOL_NAME } from "./execution.ts";
import { placementOf, StellaPlacementDoc } from "./placement.ts";

export const STELLA_PROMPT_EXTENSION = "stella-prompt";

/** The agent prompt's body: everything after its front matter. */
export const promptBody = (source: string): string => {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(source);
  return (match ? source.slice(match[0].length) : source).trim();
};

const startupDoc = (path: string, content: string | undefined): string | undefined =>
  content === undefined || content.trim() === ""
    ? undefined
    : `<startup_doc path="${path}">\n${content.trim()}\n</startup_doc>`;

/** A memory file as the model reads it on every host: comments stripped, secrets redacted, capped. */
const memoryDoc = (path: string, raw: string | undefined, maxChars: number): string | undefined =>
  startupDoc(path, raw === undefined ? undefined : shapeResidentMemoryDoc(raw, maxChars));

const role = async (input: PromptInput, context: Context): Promise<StellaAgentRole> =>
  (await input.read.snapshot(StellaAgentDoc, input.conversationId, context)) ?? { agentType: "orchestrator", depth: 0 };

const promptIdFor = (agent: StellaAgentRole): StellaAgentPromptId =>
  agent.agentType === "orchestrator" ? "agents/orchestrator.md" : "agents/general.md";

/** How much of a project's AGENTS.md an agent is shown. */
const AGENTS_MD_MAX_CHARS = 32_000;

/**
 * Where a spawned agent starts, and that directory's AGENTS.md when it has
 * one. Read from the environment on each request, so an edit to the file
 * reaches the agent on its next step.
 */
const workingDirectory: PromptSection["render"] = async (input, context) => {
  const cwd = input.agent.cwd;
  const env = input.env;
  if (!cwd || !env || (await role(input, context)).agentType === "orchestrator") return undefined;
  // Tools moved elsewhere start in that place's home, not here.
  const placement = placementOf(await input.read.snapshot(StellaPlacementDoc, input.conversationId, context));
  if (placement && placement.kind !== "local") return undefined;
  const lines = [
    `Your working directory is ${cwd}: shell commands and relative paths start there. You can still read and change files anywhere the work needs.`,
  ];
  const file = await env.joinPath([env.cwd, "AGENTS.md"], context);
  const text = file.ok ? await env.readTextFile(file.value, context) : undefined;
  if (file.ok && text?.ok && text.value.trim()) {
    const body = text.value.trim();
    const shown =
      body.length > AGENTS_MD_MAX_CHARS
        ? `${body.slice(0, AGENTS_MD_MAX_CHARS)}\n\n[Truncated: read ${file.value} for the rest.]`
        : body;
    lines.push(`The project's instructions for agents, from ${file.value}:`, startupDoc(file.value, shown)!);
  }
  return lines.join("\n\n");
};

/** Sections the orchestrator alone carries. */
const orchestratorOnly = (
  render: (input: PromptInput, context: Context) => Promise<string | undefined>,
): PromptSection["render"] =>
  async (input, context) => ((await role(input, context)).agentType === "orchestrator" ? render(input, context) : undefined);

export function stellaPromptExtension(sources: StellaContextSources) {
  const memory = (context: Context) => sources.memory(context);
  return defineExtension({
    name: STELLA_PROMPT_EXTENSION,
    // Every Stella conversation selects this extension, so its requests all pass here.
    hooks: [processableImagesHook, residentContextHook, messageIdsHook],
    sections: [
      section(
        "preamble",
        async (input, context) => {
          const agent = await role(input, context);
          const source = await sources.agentPrompt(promptIdFor(agent), context);
          if (source === undefined) return undefined;
          const memoryOn = agent.agentType === "orchestrator" && (await memory(context)).enabled;
          const hasCode = input.agent.tools.some((tool) => tool.name === "code");
          const tools = stellaPromptTools(
            input.agent.tools.map((tool) => tool.name),
            {
              history: hasCode && ((await sources.codeHistory?.(agent.agentType, context)) ?? false),
              memory: memoryOn && hasCode,
            },
          );
          return renderStellaPrompt(promptBody(source), { env: sources.env, tools });
        },
        { tag: false },
      ),
      section(
        "personality",
        orchestratorOnly(async (_input, context) => startupDoc("~/.stella/PERSONALITY.md", await sources.personality(context))),
        { tag: false },
      ),
      section(
        "core-memory",
        orchestratorOnly(async (_input, context) => {
          const docs = await memory(context);
          return docs.enabled ? memoryDoc("~/.stella/core-memory.md", docs.core, CORE_MEMORY_INJECTED_MAX_CHARS) : undefined;
        }),
        { tag: false },
      ),
      section(
        "memory-profile",
        orchestratorOnly(async (_input, context) => {
          const docs = await memory(context);
          return docs.enabled
            ? memoryDoc("~/.stella/memories/profile.md", docs.profile, USER_PROFILE_INJECTED_MAX_CHARS)
            : undefined;
        }),
        { tag: false },
      ),
      section(
        "memory-index",
        orchestratorOnly(async (_input, context) => {
          const docs = await memory(context);
          return docs.enabled
            ? memoryDoc("~/.stella/memories/index.md", docs.index, MEMORY_INDEX_INJECTED_MAX_CHARS)
            : undefined;
        }),
        { tag: false },
      ),
      section("skills", async (_input, context) => sources.skillsCatalog(context), { tag: false }),
      // Stella's, and an agent's that can move its own tools to one of them.
      section("execution-devices", async (input, context) => {
        const switchable = input.agent.tools.some((tool) => tool.name === SWITCH_DESTINATION_TOOL_NAME);
        if ((await role(input, context)).agentType !== "orchestrator" && !switchable) return undefined;
        const snapshot = await sources.executionContext(input.conversationId, context);
        return snapshot && renderExecutionDevices(snapshot, { switchable });
      }),
      section("execution-destination", async (input, context) => {
        // A conversation whose tools run on one of the user's computers says which.
        const placement = placementOf(await input.read.snapshot(StellaPlacementDoc, input.conversationId, context));
        if (placement?.kind === "device") {
          return renderDeviceDestination(placement, (await role(input, context)).agentType === "orchestrator");
        }
        const snapshot = await sources.executionContext(input.conversationId, context);
        // On a computer, a conversation whose tools moved to the cloud says so.
        if (placement?.kind === "cloud" && snapshot?.destination.kind === "device") {
          return renderCloudDestination((await role(input, context)).agentType === "orchestrator");
        }
        return snapshot && renderExecutionDestination(snapshot);
      }),
      section("working-directory", workingDirectory),
      section("media-access", async (input, context) => {
        const snapshot = await sources.executionContext(input.conversationId, context);
        return snapshot && renderMediaAccess(snapshot);
      }),
      section(
        "response-language",
        orchestratorOnly(async (_input, context) => responseLanguageSection(await sources.locale?.(context))?.text),
        { tag: false },
      ),
    ],
  });
}
