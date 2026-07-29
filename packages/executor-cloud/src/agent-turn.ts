/**
 * The real cloud agent turn: Stella's own runtime (agent-core loop + tool
 * host) running headless in the sandbox as the spawned general agent.
 *
 * The BuildSession DO restores the workspace before invoking this and
 * checkpoints it after; this module only runs the loop. Model calls go
 * through the managed relay authenticated by the per-turn token; events and
 * the thread transcript stream to Convex with the same token. The final line
 * on stdout is the structured report the DO parses.
 */

import { existsSync } from "node:fs";
import { readFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { Agent } from "@stella/runtime/kernel/agent-core/agent.js";
import type {
  AgentMessage,
  AgentTool,
} from "@stella/runtime/kernel/agent-core/types.js";
import type { TSchema } from "@sinclair/typebox";
import type { FileChangeRecord } from "@stella/contracts/file-changes";
import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import { createToolHost } from "@stella/runtime/kernel/tools/host.js";
import type { ToolContext } from "@stella/runtime/kernel/tools/host.js";
import {
  AGENT_RUN_MAX_ATTEMPTS,
  executeAgentRunWithRetry,
  prepareTransientResumeTail,
} from "@stella/runtime/kernel/agent-runtime/run-retry.js";
import {
  buildDefaultTransformContext,
  extractAssistantText,
  getAgentCompletion,
} from "@stella/runtime/kernel/agent-runtime/run-shared.js";
import { turnToken } from "./env-secrets.js";
import {
  CLOUD_TURN_TOKEN_HEADER,
  createCloudRelayModel,
  resolveCloudThinkingLevel,
} from "./relay-model.js";
import { chunkForAppend, pruneAgentHistory } from "./prune-history.js";
import {
  emptyDriveSync,
  materializeDriveFiles,
  type DriveSyncResult,
} from "./drive-sync.js";
import {
  collectProducedFiles,
  reportProducedFiles,
  toDriveFile,
  type ProducedFileReport,
} from "./produced-files.js";
import {
  prepareProjectWorkspace,
  scrubRemoteUrl,
  takeProjectCredentials,
  type ProjectTurnInput,
  type ProjectWorkspaceResult,
} from "./project-workspace.js";
import {
  drivePrefixFor,
  resolveWorkspace,
  toolStateDirFor,
  type WorkspaceIdentity,
} from "./workspace-paths.js";
import { runNativeAgentTurn } from "./native-agent-turn.js";

/**
 * The turn input file sits above the workspace root and is readable by every
 * shell the agent runs, so the executor consumes it and immediately unlinks
 * it: the thread history and the callback base it carries are the executor's
 * inputs, not the agent's context.
 */
const TURN_INPUT_PATH = "/workspace/turn-input.json";

export type AgentTurnInput = {
  kind: "agent";
  ownerId: string;
  conversationId: string;
  threadId: string;
  turnId: string;
  prompt: string;
  workspace: string;
  convexCallbackBase: string;
  /** Prior thread transcript rows, oldest first (send_input continuations). */
  history?: Array<{ role: string; payloadJson: string }>;
  /** Canonical model route authorized for this turn at dispatch. */
  execution: CloudExecutionSelection;
  /** Clone/checkout inputs for a `project:<slug>` workspace. */
  project?: ProjectTurnInput;
};

export type AgentTurnResult = {
  ok: boolean;
  finalText: string;
  error?: string;
  usage: { inputTokens: number; outputTokens: number; llmCalls: number };
  /**
   * Resolved project workspace facts. `setupCommand` is the command this turn
   * inferred when the project had none recorded; the dispatcher persists it so
   * later turns stop re-deriving it.
   */
  project?: {
    mode: ProjectWorkspaceResult["mode"];
    branch: string;
    setupCommand?: string;
    setupSource?: "provided" | "inferred";
  };
};

/**
 * Pinned in code, not read from agent-metadata: the sandbox image's home-seed
 * copy is agent-writable in principle, and the cloud contract is that
 * allowlists governing execution surfaces are never data-driven.
 *
 * The document and media stack adds no tool names — the host exposes
 * `stella-office`, poppler and `mediainfo` as shell commands, so they arrive
 * through `exec_command`. `Read` is the one catalog addition they need: a
 * plain-text read of extracted document text that does not cost a PTY turn.
 * `Grep` stays out deliberately; its handler downloads ripgrep into
 * `stellaDataDir/bin` on first use, which lands inside the checkpointed
 * workspace forever.
 */
const CLOUD_GENERAL_TOOLS = [
  "exec_command",
  "write_stdin",
  "node_repl",
  "apply_patch",
  "web",
  "view_image",
  "Read",
] as const;

/**
 * The office CLI ships inside the image next to the runtime. The tool host
 * turns this into a `stella-office` shell function plus `STELLA_OFFICE_BIN`,
 * so document work runs through `exec_command` rather than a dedicated tool.
 */
const resolveOfficeBinPath = (): string | undefined => {
  const candidate =
    process.env.STELLA_OFFICE_BIN?.trim() ||
    fileURLToPath(
      new URL("../../stella-office/bin/stella-office.js", import.meta.url),
    );
  return existsSync(candidate) ? candidate : undefined;
};

/**
 * Exported for one reason: everything it says about the drive is a claim about
 * a `DriveSyncResult`, and the only other way to read the sentences a given
 * sync produces is to run a whole turn in a sandbox. Round 6 shipped three of
 * them that had never been rendered.
 */
export const CLOUD_GENERAL_PROMPT = (options: {
  workspace: WorkspaceIdentity;
  office: boolean;
  project?: { result: ProjectWorkspaceResult; remoteUrl: string };
  drive?: DriveSyncResult;
}) => {
  const { workspace, project } = options;
  // The workspace IS the drive, so the agent has to know that the files in it
  // are the user's own — a file it does not recognize is not scratch, and a
  // name already taken is a file to open rather than recreate.
  const driveSentences: string[] = [];
  if (options.drive) {
    const loaded = options.drive.materialized.length;
    driveSentences.push("This workspace is the user's drive.");
    if (loaded > 0) {
      driveSentences.push(
        `The ${loaded} ${loaded === 1 ? "file" : "files"} in it — everything the user uploaded and everything earlier turns produced — ${loaded === 1 ? "is" : "are"} already on disk at the drive ${loaded === 1 ? "path" : "paths"} the user knows ${loaded === 1 ? "it" : "them"} by.`,
        "Read a file before you rewrite it: writing over a name one of the user's own uploads already holds is refused, and your version is saved beside it instead.",
      );
    }
    const held = options.drive.skipped.map((entry) => entry.path);
    if (held.length > 0) {
      driveSentences.push(
        `These files are in the drive but were not loaded into this turn: ${held.slice(0, 10).join(", ")}${held.length > 10 ? ", …" : ""}.`,
        "Tell the user if you need one rather than working around it.",
      );
    }
    // A hydrated copy an earlier turn changed is not deleted when its drive
    // row is: it holds work that exists nowhere else. So the agent is told
    // instead — otherwise it reads a file that is no longer the user's and
    // treats it as one.
    const stale = options.drive.stale;
    if (stale.length > 0) {
      driveSentences.push(
        `The user deleted these from their drive, but a changed copy is still on disk here: ${stale.slice(0, 10).join(", ")}${stale.length > 10 ? ", …" : ""}.`,
        "They are not the user's files any more — say so before you use one, and do not save one back to the drive unless the user asks for it.",
      );
    }
    // Same reason, the other direction: hydration does not download over a
    // copy it cannot prove it wrote, so these files are on disk in a version
    // the drive does not have. Unsaved work is invisible without this — the
    // agent would read the file, see its own earlier output, and have no way
    // to know the user has never received it.
    const unsaved = options.drive.conflicts
      .filter((entry) => !entry.driveMoved)
      .map((entry) => entry.path);
    if (unsaved.length > 0) {
      driveSentences.push(
        `These are on disk in a version the drive does not have — an earlier turn changed them and the change never reached the user: ${unsaved.slice(0, 10).join(", ")}${unsaved.length > 10 ? ", …" : ""}.`,
        "What is on disk is the only copy of that work, so do not rebuild one from scratch, and save it to the drive when the task calls for it.",
      );
    }
    const diverged = options.drive.conflicts
      .filter((entry) => entry.driveMoved)
      .map((entry) => entry.path);
    if (diverged.length > 0) {
      driveSentences.push(
        `These changed in the drive and in this workspace since the workspace last read them, so the copy on disk is neither the user's current version nor saved anywhere: ${diverged.slice(0, 10).join(", ")}${diverged.length > 10 ? ", …" : ""}.`,
        "Tell the user which one you used before you use it, and expect a version you save to be filed beside the drive's copy rather than over it.",
      );
    }
  }
  const driveLines =
    driveSentences.length > 0 ? `\n\n${driveSentences.join(" ")}` : "";
  const documents = options.office
    ? `Documents: \`stella-office\` creates and edits .docx/.xlsx/.pptx \
(run \`stella-office\` with no arguments for its command reference). PDFs: \
\`pdftotext\`, \`pdfinfo\`, \`pdftoppm\` (render pages to PNG), \`pdfimages\`, \
\`pdfseparate\` and \`pdfunite\`. Audio and video: \`mediainfo\` reports codec, \
duration and dimensions. There is no LibreOffice, ffmpeg or Python in this \
sandbox — do not plan around them.`
    : `PDFs: \`pdftotext\`, \`pdfinfo\`, \`pdftoppm\`, \`pdfimages\`. Audio and \
video: \`mediainfo\`. There is no LibreOffice, ffmpeg or Python in this \
sandbox — do not plan around them.`;
  const projectLines = project
    ? `\n\nThis workspace is the repository ${project.remoteUrl}, \
${project.result.mode === "cloned" ? "freshly cloned" : "restored from its last checkpoint"} \
on branch ${project.result.branch}. git is authenticated for this repository: \
fetch, pull, commit, and push work like they would for a person at a clone. \
Commit and push the work the user asked for; if a push is rejected because the \
remote moved, fetch and rebase, resolve, and push again.${
        project.result.notes.length > 0
          ? `\n${project.result.notes.map((note) => `- ${note}`).join("\n")}`
          : ""
      }`
    : "";
  const stellaLines =
    workspace.kind === "stella"
      ? `\n\nThis workspace is the editable source tree for the user's Stella web interior. \
Change the existing renderer source in place; do not replace it with a new app, \
do not edit generated build output, and do not attempt to deploy it yourself. \
After you finish, Stella automatically runs the immutable production builder \
and records a candidate for review. A build failure prevents a candidate but \
does not discard the source changes.`
      : "";
  return `You are a Stella background agent running in a cloud sandbox. \
Complete the task you were given, then stop — your final message is delivered \
to the orchestrator as your report, so make it a concise, self-contained \
summary of what you did and found, including exact file paths for anything \
you created or changed.

Your workspace is "${workspace.workspace}" mounted at ${workspace.root}, which \
is the current working directory. Everything you write inside it is \
checkpointed and persists across turns; anything outside it is discarded when \
the sandbox stops. Files you create or change there are delivered to the user \
automatically, so save deliverables in the workspace under the name the user \
should see — up to 25 of them per turn, so bundle a larger set into one \
archive. You have bun, node, and git available via exec_command.

${documents}

You cannot spawn other agents and you cannot reach the user directly.${driveLines}${projectLines}${stellaLines}`;
};

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

export const runAgentTurn = (
  fallbackWorkspaceRoot = "/workspace/drive",
): Effect.Effect<AgentTurnResult, Error> =>
  Effect.scoped(
    Effect.gen(function* () {
      const input = yield* Effect.tryPromise({
        try: async () => {
          const raw = await readFile(TURN_INPUT_PATH, "utf8");
          await rm(TURN_INPUT_PATH, { force: true });
          return JSON.parse(raw) as AgentTurnInput;
        },
        catch: asError,
      });
      // The one credential the turn input only points at. Taken here, at the
      // top of the turn, so it is off the filesystem long before the tool host
      // — and therefore any shell the agent can run — exists.
      const projectHandoff = input.project;
      const projectToken = projectHandoff
        ? yield* Effect.promise(() => takeProjectCredentials(projectHandoff))
        : undefined;
      const workspace = yield* Effect.try({
        try: () => resolveWorkspace(input.workspace, fallbackWorkspaceRoot),
        catch: asError,
      });
      const workspaceRoot = workspace.root;
      if (!turnToken) {
        return yield* Effect.fail(new Error("STELLA_TURN_TOKEN is not set."));
      }
      const token = turnToken;
      const base = input.convexCallbackBase.replace(/\/+$/, "");
      const postJson = async (
        route: string,
        body: unknown,
      ): Promise<Response> =>
        fetch(`${base}${route}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [CLOUD_TURN_TOKEN_HEADER]: token,
          },
          body: JSON.stringify(body),
        });

      // Ordered, best-effort progress events; a lost event never fails the
      // turn (the DO writes the terminal event either way).
      let eventChain: Promise<unknown> = Promise.resolve();
      const emitEvent = (kind: string, payload: unknown): void => {
        eventChain = eventChain
          .then(() =>
            postJson("/api/cloud/events", {
              turnId: input.turnId,
              sessionId: input.threadId,
              seq: "auto",
              kind,
              payload,
            }),
          )
          .catch((error) => {
            console.error(`event ${kind} failed: ${asError(error).message}`);
          });
      };

      // A project clone needs an empty directory, so it runs before anything
      // else seeds the workspace.
      let project: ProjectWorkspaceResult | undefined;
      if (workspace.kind === "project" && projectHandoff) {
        project = yield* Effect.tryPromise({
          try: () =>
            prepareProjectWorkspace(
              workspaceRoot,
              projectHandoff,
              (message) => emitEvent("progress", { message }),
              projectToken,
            ),
          catch: asError,
        });
        // Give the agent's shells the same git credentials workspace prep
        // used: every `exec_command` inherits this process's env, so from here
        // on plain `git fetch/pull/push` in the workspace just works. The
        // askpass helper holds the repo-scoped, ~1h token in its body — this
        // env carries only its path (see createGitCredentialEnv).
        if (project.gitEnv) {
          Object.assign(process.env, project.gitEnv);
        }
      }

      // Created before hydration, not after: the hydration ledger lives here,
      // and it is what lets a turn skip re-downloading a drive it already has.
      const stateDir = toolStateDirFor(workspace);
      yield* Effect.tryPromise({
        try: () => mkdir(stateDir, { recursive: true }),
        catch: asError,
      });

      // Bring the drive into the workspace before any agent tool exists. Only
      // the `drive` kind: its root IS the drive namespace, whereas a project
      // or app root is a checkout whose drive folder is an output mirror —
      // writing that mirror back into the tree would resurrect files the agent
      // deleted and dirty a branch the user is about to review.
      let driveSync = emptyDriveSync();
      if (workspace.kind === "drive") {
        driveSync = yield* Effect.promise(() =>
          materializeDriveFiles({
            turnId: input.turnId,
            prompt: input.prompt,
            workspaceRoot,
            stateDir,
            post: postJson,
            onProgress: (message) => emitEvent("progress", { message }),
          }).catch((error) => {
            // A drive the turn could not read is a turn that vouches for
            // nothing, which is exactly what stops it overwriting an upload it
            // never saw. Degraded, not failed.
            console.error(`drive sync failed: ${asError(error).message}`);
            return emptyDriveSync();
          }),
        );
      }

      const officeBinPath = resolveOfficeBinPath();
      const cloudSystemPrompt = CLOUD_GENERAL_PROMPT({
        workspace,
        office: Boolean(officeBinPath),
        ...(workspace.kind === "drive" ? { drive: driveSync } : {}),
        ...(project && projectHandoff
          ? {
              project: {
                result: project,
                remoteUrl: scrubRemoteUrl(projectHandoff.remoteUrl),
              },
            }
          : {}),
      });
      const toolHost = yield* Effect.acquireRelease(
        Effect.sync(() =>
          createToolHost({
            stellaAppDir: workspaceRoot,
            stellaDataDir: stateDir,
            ...(officeBinPath ? { stellaOfficeBinPath: officeBinPath } : {}),
            webSearch: async (query, options) => {
              const response = await postJson("/api/cloud/web-search", {
                query,
                category: options?.category,
              });
              if (!response.ok) {
                return { text: `WebSearch failed (${response.status}).` };
              }
              return (await response.json()) as {
                text: string;
                results?: Array<{
                  title: string;
                  url: string;
                  snippet: string;
                }>;
              };
            },
          }),
        ),
        (host) =>
          Effect.tryPromise({
            try: () => host.shutdown(),
            catch: asError,
          }).pipe(Effect.orDie),
      );

      const context: ToolContext = {
        conversationId: input.threadId,
        deviceId: "cloud",
        requestId: crypto.randomUUID(),
        agentType: "general",
        workingDirectory: workspaceRoot,
        stellaAppDir: workspaceRoot,
        stellaDataDir: stateDir,
        toolWorkspaceRoot: workspaceRoot,
        storageMode: "cloud",
        agentId: input.threadId,
        agentDepth: 1,
        maxAgentDepth: 1,
        // The desktop default (12) assumes an over-cap batch reaches the user
        // unfiltered. Here it does not: `collectProducedFiles` re-applies noise
        // filtering, build/state exclusion, gitignore awareness and workspace
        // containment before anything is counted, so a runtime cap below that
        // drops batches that are mostly install churn around a real
        // deliverable. Raising it moves the same threshold downstream of those
        // filters rather than removing it — `collectProducedFiles` still
        // withholds a whole snapshot batch that is over the cap once filtered,
        // which is what keeps churn out of the user's drive, and this ceiling
        // is what still cuts a genuine `git checkout` flood before it is even
        // walked.
        maxProducedFilesPerCommand: 200,
      };

      // What the turn touched, straight from the tools that touched it: a
      // filesystem diff cannot separate deliverables from install churn. The
      // two kinds stay apart because they earn different trust — an edit tool
      // wrote what the agent meant to write, a shell snapshot guessed.
      const editedFiles: FileChangeRecord[] = [];
      // One array per command, not one flat list: how many files a single
      // command produced is what tells the deliverable apart from the churn
      // around it, and flattening throws that away before the report is
      // ranked.
      const detectedFiles: FileChangeRecord[][] = [];
      // A command whose produced files the runtime withheld delivers nothing
      // and, without this, says nothing either — indistinguishable from a
      // command that produced nothing. The agent is the only party that can
      // tell the user its files are sitting in the workspace.
      let runtimeWithheldFiles = 0;

      const catalog = toolHost.getToolCatalog("general", {});
      const byName = new Map(catalog.map((tool) => [tool.name, tool]));
      const tools: AgentTool[] = [];
      for (const name of CLOUD_GENERAL_TOOLS) {
        const meta = byName.get(name);
        if (!meta) continue;
        tools.push({
          name,
          label: meta.label ?? name,
          ...(meta.workingText ? { workingText: meta.workingText } : {}),
          description: meta.description,
          parameters: meta.parameters as unknown as TSchema,
          execute: async (_toolCallId, params, signal) => {
            const result = await toolHost.executeTool(
              name,
              (params ?? {}) as Record<string, unknown>,
              context,
              signal,
            );
            if (result.fileChanges) editedFiles.push(...result.fileChanges);
            if (result.producedFiles?.length) {
              detectedFiles.push(result.producedFiles);
            }
            if (result.producedFilesOmitted) {
              runtimeWithheldFiles += result.producedFilesOmitted.count;
            }
            if (result.error) throw new Error(result.error);
            const text =
              typeof result.result === "string"
                ? result.result
                : result.result === undefined
                  ? ""
                  : JSON.stringify(result.result, null, 2);
            return {
              content: [
                {
                  type: "text",
                  text:
                    text.length > 30_000
                      ? `${text.slice(0, 15_000)}\n…[truncated]…\n${text.slice(-15_000)}`
                      : text || "(no output)",
                },
              ],
              details: result.details ?? null,
            };
          },
        });
      }

      const parsedHistory: AgentMessage[] = [];
      for (const row of input.history ?? []) {
        try {
          parsedHistory.push(JSON.parse(row.payloadJson) as AgentMessage);
        } catch {
          // A malformed historical row degrades context, never the turn.
        }
      }
      // Long-running threads accumulate transcript across send_input
      // continuations; keep the newest window that fits the model.
      const history = pruneAgentHistory(parsedHistory);

      let llmCalls = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      let execution: { finalText: string; errorMessage?: string };
      let produced: AgentMessage[];
      if (input.execution.engine !== "stella") {
        const nativeExecution = input.execution;
        const native = yield* Effect.tryPromise({
          try: () =>
            runNativeAgentTurn({
              prompt: input.prompt,
              systemPrompt: cloudSystemPrompt,
              execution: nativeExecution,
              callbackBase: base,
              turnToken: token,
              workspace,
              threadId: input.threadId,
              emitEvent,
            }),
          catch: asError,
        });
        editedFiles.push(...native.editedFiles);
        llmCalls = native.usage.llmCalls;
        inputTokens = native.usage.inputTokens;
        outputTokens = native.usage.outputTokens;
        execution = {
          finalText: native.finalText.trim(),
          ...(native.error ? { errorMessage: native.error } : {}),
        };
        produced = native.messages;
      } else {
        const model = yield* Effect.tryPromise({
          try: () =>
            createCloudRelayModel({
              siteUrl: base,
              turnToken: token,
              agentType: "general",
              execution: input.execution,
            }),
          catch: asError,
        });
        const agent = new Agent({
          initialState: {
            systemPrompt: cloudSystemPrompt,
            model,
            thinkingLevel: resolveCloudThinkingLevel(
              model,
              input.execution.reasoningEffort,
            ),
            tools,
            messages: history,
          },
          sessionId: input.threadId,
          getApiKey: () => token,
          toolExecution: "sequential",
          toolInactivityTimeoutMs: 5 * 60_000,
          // Same division of labor as the desktop runtime and the orchestrator
          // DO: re-prune before every provider call, and let the outer ladder
          // own empty completions and the physical-request ceiling.
          transformContext: buildDefaultTransformContext({ model }),
          degenerateResponseRetries: 0,
          providerRequestLimit: AGENT_RUN_MAX_ATTEMPTS,
        });
        const unsubscribe = agent.subscribe((event) => {
          if (
            event.type === "message_end" &&
            event.message.role === "assistant"
          ) {
            llmCalls += 1;
            const usage = (
              event.message as {
                usage?: {
                  input?: number;
                  output?: number;
                  inputTokens?: number;
                  outputTokens?: number;
                };
              }
            ).usage;
            inputTokens += usage?.inputTokens ?? usage?.input ?? 0;
            outputTokens += usage?.outputTokens ?? usage?.output ?? 0;
            const text = extractAssistantText(event.message).trim();
            if (text)
              emitEvent("assistant_message", { text: text.slice(0, 8_000) });
          }
          if (event.type === "tool_execution_start") {
            emitEvent("tool_call", {
              name: event.toolName,
              args: JSON.stringify(event.args ?? {}).slice(0, 1_000),
            });
          }
        });

        const before = agent.state.messages.length;
        // The desktop runtime's transient ladder: a retryable provider or
        // transport failure resumes the same in-memory context instead of
        // failing the whole turn. The DO's watchdog still bounds the turn; a
        // full ladder adds at most ~10s of backoff.
        execution = yield* Effect.tryPromise({
          try: () =>
            executeAgentRunWithRetry({
              state: { attemptsUsed: 0, retriesUsed: 0 },
              execute: async (resume) => {
                if (resume) {
                  await agent.continue();
                } else {
                  await agent.prompt(input.prompt);
                }
                const completion = getAgentCompletion(agent);
                return {
                  ...completion,
                  finalText: completion.finalText.trim(),
                };
              },
              prepareResume: (reason, classification) => {
                const prepared = prepareTransientResumeTail(
                  agent.state.messages,
                  classification,
                );
                if (prepared) {
                  console.error(
                    `transient run retry (${classification.category}): ${reason}`,
                  );
                }
                return prepared;
              },
            }),
          catch: asError,
        });
        unsubscribe();
        // Errored assistant messages have empty content; one empty assistant
        // row poisons every future Anthropic request for this thread.
        produced = agent.state.messages.slice(before).filter((message) => {
          const record = message as { role?: string; content?: unknown };
          return !(
            record.role === "assistant" &&
            Array.isArray(record.content) &&
            record.content.length === 0
          );
        });
      }
      yield* Effect.promise(() => eventChain.then(() => undefined));

      // Persist the thread transcript (conversationId = threadId) so
      // send_input continuations restore full conversational context, not
      // just the workspace.
      if (produced.length > 0) {
        // The append route caps one request at 50 rows; a busy turn (each
        // tool call is an assistant + toolResult pair) easily exceeds that,
        // so persist in ordered batches.
        yield* Effect.tryPromise({
          try: async () => {
            const rows = produced.map((message) => ({
              role: (message as { role: string }).role,
              payloadJson: JSON.stringify(message),
            }));
            // Multi-batch persist is not atomic; retry each batch once so a
            // transient failure can't strand a committed prefix while the
            // turn reports failed.
            for (const batch of chunkForAppend(rows)) {
              let response = await postJson("/api/cloud/messages", {
                conversationId: input.threadId,
                turnId: input.turnId,
                messages: batch,
              });
              if (!response.ok) {
                response = await postJson("/api/cloud/messages", {
                  conversationId: input.threadId,
                  turnId: input.turnId,
                  messages: batch,
                });
              }
              if (!response.ok) {
                throw new Error(
                  `Thread transcript persist failed (${response.status}).`,
                );
              }
            }
          },
          catch: asError,
        });
      }

      // Background commands that finished after their last poll still hold
      // their deliverables; pull those in before reporting.
      const drained = yield* Effect.tryPromise({
        try: () => toolHost.drainCompletedShellProducedFiles(),
        catch: asError,
      });
      // Already merged across however many background commands finished late,
      // so it ranks as one batch — the grouping it arrives with.
      if (drained.files.length > 0) detectedFiles.push(drained.files);
      if (drained.omitted) runtimeWithheldFiles += drained.omitted.count;

      // Delivery is best-effort: the bytes are already in the checkpointed
      // workspace, so a failed registration costs visibility, not work — but
      // it has to be visible in the report rather than silently dropped.
      const outputs = yield* Effect.promise(
        async (): Promise<{
          files: ProducedFileReport[];
          stored: Set<string>;
          notice: string;
        }> => {
          const collected = await collectProducedFiles({
            workspaceRoot,
            edited: editedFiles,
            detected: detectedFiles,
            gitAware: workspace.kind === "project",
            drivePrefix: drivePrefixFor(workspace),
          }).catch(() => null);
          const files = collected?.files ?? [];
          const omitted = collected?.omitted ?? [];
          // The system prompt promises the user that workspace files are
          // delivered, so a cap that holds some back has to say so rather than
          // let the agent report success over a shorter list.
          // Two different caps can hold files back — the report's own size,
          // which names the paths it left behind, and the per-command ceiling
          // (the runtime's, and collection's own post-filter one), which
          // withholds a whole batch and only counts it.
          const withheld = runtimeWithheldFiles + (collected?.withheld ?? 0);
          const truncated =
            (omitted.length > 0
              ? `\n\nHeads up: only ${files.length} of the files from this turn were delivered. ${omitted.length} more (${omitted.slice(0, 5).join(", ")}${omitted.length > 5 ? ", …" : ""}) are in the workspace but were not.`
              : "") +
            (withheld > 0
              ? `\n\nHeads up: ${withheld} files produced by a single command were above the per-command limit, so they were not collected for delivery. They are in the workspace.`
              : "");
          if (files.length === 0) {
            return { files, stored: new Set<string>(), notice: truncated };
          }
          try {
            const delivery = await reportProducedFiles({
              turnId: input.turnId,
              files,
              known: driveSync.known,
              uploads: driveSync.uploads,
              post: postJson,
            });
            // The drive's answer is part of the turn's report: a file saved
            // under a different name to spare the user's own upload, or one
            // the quota turned away, is something the agent's summary would
            // otherwise claim it delivered.
            const renamedBy = new Map(
              delivery.renamed.map((entry) => [entry.from, entry.to]),
            );
            const refused = new Set(
              delivery.skipped.map((entry) => entry.path),
            );
            const notes = [
              ...delivery.renamed.map((entry) => entry.reason),
              ...delivery.skipped.map((entry) => entry.reason),
              ...delivery.replaced.map((entry) => entry.reason),
            ];
            return {
              files: files
                .filter((file) => !refused.has(file.path))
                .map((file) => {
                  const to = renamedBy.get(file.path);
                  return to
                    ? {
                        ...file,
                        path: to,
                        name: to.slice(to.lastIndexOf("/") + 1),
                      }
                    : file;
                }),
              stored: delivery.stored,
              notice:
                notes.length > 0
                  ? `${truncated}\n\n${notes.join(" ")}`
                  : truncated,
            };
          } catch (failure) {
            console.error(
              `drive file report failed: ${asError(failure).message}`,
            );
            return {
              files: [],
              stored: new Set<string>(),
              notice: `${truncated}\n\nHeads up: delivering the files from this turn (${files
                .map((file) => file.path)
                .join(", ")}) failed. They are still in the workspace.`,
            };
          }
        },
      );
      if (outputs.files.length > 0) {
        emitEvent("output_files", {
          // `stored` is the route's answer, not ours: a file too large to send
          // inline is registered but its bytes stay in the workspace, so the
          // chat surface must not offer it as a download.
          files: outputs.files.map((file) => ({
            ...toDriveFile(file),
            stored: outputs.stored.has(file.path),
          })),
        });
        yield* Effect.promise(() => eventChain.then(() => undefined));
      }

      const finalText = execution.finalText;
      const error = execution.errorMessage;
      return {
        ok: !error,
        finalText:
          `${finalText || (error ? "" : "The agent finished without a report.")}${outputs.notice}`.trim(),
        ...(error ? { error } : {}),
        usage: { inputTokens, outputTokens, llmCalls },
        ...(project
          ? {
              project: {
                mode: project.mode,
                branch: project.branch,
                ...(project.setupCommand
                  ? { setupCommand: project.setupCommand }
                  : {}),
                ...(project.setupSource
                  ? { setupSource: project.setupSource }
                  : {}),
              },
            }
          : {}),
      } satisfies AgentTurnResult;
    }),
  );
