import type {
  AdmittedCloudChat,
  CloudChatPreparation,
} from "../cloud-chat-admission.js";
import { PLACEMENT_PROTOCOL } from "@stella/contracts/turn-plane/placement";
import {
  piBrainHandoffPrompt,
  type PiBrainHost,
  type PiBrainRecord,
} from "@stella/contracts/turn-plane/pi-brain";
import { guardedModelFetch } from "../guarded-model-fetch.js";
import {
  AGENT_MESSAGE_FRAMED_MAX_CHARS,
  type AgentMessagingCaller,
  readAgentDirectory,
  sendAgentMessage,
} from "../agent-messaging.js";
import {
  type LocalOwnerModelGrantExpectation,
  releaseOwnerModelGrantAfterBody,
} from "../local-owner-model-grants.js";
import type { AgentActivityEntry } from "@stella/contracts/conversation-agent-activity";
import {
  OWNER_EVENT_VERSION,
  type OwnerEvent,
} from "@stella/contracts/turn-plane/owner-events";
import {
  type CloudTurnStartRequest,
  TURN_OWNER_GENERATION_HEADER,
  TURN_PLANE_PROTOCOL,
} from "@stella/contracts/turn-plane/turn-start";
import { HEADER_TURN_AUTH_KIND } from "../turn-start-request.js";
import { CLOUD_HISTORY_TOKEN_BUDGET } from "@stella/executor-cloud/prune-history";
import {
  cancelDeviceAgent,
  continueDeviceAgent,
  type DeviceAgentCaller,
  readDeviceAgent,
  spawnDeviceAgent,
} from "../device-agent-tools.js";
import {
  agentCompletionPromptText,
  agentLifecycleReport,
  type CloudAgentControlReceipt,
  type PiThreadPause,
  type PiThreadPauseResult,
  type PiThreadStart,
  type PiThreadSteer,
  type PiThreadSteerResult,
} from "../cloud-agent-dispatch.js";
import {
  type CloudCodeSourceAgentTool,
  createCloudCodeAgentTool,
} from "../cloud-code-tool.js";
import type { CloudBrowserClient } from "../cloud-browser.js";
import { createCloudWebTool } from "../cloud-web-tool.js";
import { unwrapRpc } from "../owner-store/errors.js";
import {
  type CloudConnectorDeclines,
  CloudConnectorDirectory,
  createCloudConnectClient,
} from "../cloud-connect-client.js";
import {
  listIntegrationActions,
  listIntegrationCatalog,
} from "../integrations/catalog.js";
import { sleepWithAbort } from "@stella/runtime/kernel/tools/effect-runtime.js";
import { HEADER_OWNER } from "../conversation-types.js";
import type {
  OwnerFencedTurn,
  PiThreadOutcome,
  PiThreadRecord,
  BrainHandoff,
  AgentsView,
} from "./types.js";
import {
  BROWSER_HANDOFF_POLL_MS,
  BROWSER_HANDOFF_GRACE_MS,
  AGENT_RUNTIME_KEY,
  PI_DEVICE_AGENT_PREFIX,
  piThreadKey,
  PI_LIVE_KEY,
  PI_BRAIN_KEY,
  BRAIN_HANDOFF_KEY,
  AGENT_RECONCILE_INTERVAL_MS,
  AGENTS_VIEW_KEY,
  AGENTS_UNOWNED_SETTLED_KEY,
  AGENT_OWNER_RECORD_LAG_MS,
  PI_HEARTBEAT_MS,
} from "./constants.js";
import {
  OwnerPurgeFenceError,
  piReportOutcome,
  cloudExecutionContext,
  piModelSpec,
  errorMessage,
  log,
} from "./support.js";
import { OrchestratorCloudAgents } from "./cloud-agents.js";

/**
 * pi-durable: the conversation's pi runtime, pi agents and threads, the
 * brain's placement, and the running-agents view.
 */
export abstract class OrchestratorPi extends OrchestratorCloudAgents {
  /** A model grant from the owner, unless a freeze landed while it was issued. */
  protected async acquireOwnerModelGrant(
    expected: LocalOwnerModelGrantExpectation,
  ) {
    const freezeEpoch = this.localOwnerModelGrants.freezeEpoch(expected);
    const issued = await this.ownerGate(expected.ownerId).acquireModelGrant({
      ownerId: expected.ownerId,
      ownerGeneration: expected.ownerGeneration,
      conversationId: expected.conversationId,
      readerId: this.isolateId,
      turnId: expected.turnId,
      leaseId: expected.leaseId,
      fenceGeneration: expected.fenceGeneration,
      policy: expected.memoryPolicy,
    });
    const grant = this.localOwnerModelGrants.validAfter(
      issued,
      expected,
      freezeEpoch,
    );
    if (!grant) throw new OwnerPurgeFenceError();
    return { grant, expected };
  }

  /**
   * A pi agent's run held to the owner's purge fence as a chat turn is: an
   * owner-fence lease for the run (the same lease when a resumed run asks
   * again), and a model grant under the owner's current memory policy on
   * each request. A purge or a privacy change freezes the grant and aborts
   * the request in flight.
   */
  protected async piAgentGuard(
    authority: import("../pi-runtime.js").PiAuthority,
    turnId: string,
  ): Promise<import("../pi-runtime.js").PiAgentGuard> {
    const fenced: OwnerFencedTurn = {
      ownerId: authority.ownerId,
      ownerGeneration: authority.ownerGeneration,
      turnId,
    };
    const fenceGeneration = await this.registerOwnerTurn(fenced);
    const leaseId = fenced.ownerPurgeLeaseId;
    try {
      if (!leaseId) throw new OwnerPurgeFenceError();
      const { memory } = await this.ownerGate(authority.ownerId).homeContext(
        authority.ownerGeneration,
        fenceGeneration,
      );
      const expected: LocalOwnerModelGrantExpectation = {
        ownerId: authority.ownerId,
        ownerGeneration: authority.ownerGeneration,
        conversationId: authority.conversationId,
        turnId,
        leaseId,
        fenceGeneration,
        memoryPolicy: memory.preference,
      };
      let grantWork = this.acquireOwnerModelGrant(expected);
      void grantWork.catch(() => undefined);
      const currentGrant = async () => {
        const current = await grantWork;
        if (
          !this.localOwnerModelGrants.valid(current.grant, current.expected)
        ) {
          throw new OwnerPurgeFenceError();
        }
        if (current.grant.expiresAt - Date.now() > 60_000) return current;
        grantWork = this.acquireOwnerModelGrant(expected);
        void grantWork.catch(() => undefined);
        return await grantWork;
      };
      const gateway = this.env.MODEL_GATEWAY;
      if (!gateway) throw new Error("Model gateway is not configured.");
      return {
        fetch: async (request) => {
          const current = await currentGrant();
          const active = this.localOwnerModelGrants.begin(
            current.grant,
            current.expected,
            request.signal,
          );
          try {
            const response = await guardedModelFetch({
              request: new Request(request, { signal: active.requestSignal }),
              fetch: (value) => gateway.fetch(value),
              mode: "authorize-before-fetch",
              authorize: async () => {
                if (this.purged()) throw new OwnerPurgeFenceError();
                active.assertValid();
              },
            });
            return releaseOwnerModelGrantAfterBody(response, active.release);
          } catch (error) {
            active.release();
            throw error;
          }
        },
        release: async () => {
          await this.unregisterOwnerTurn(fenced);
        },
      };
    } catch (error) {
      await this.unregisterOwnerTurn(fenced).catch(() => undefined);
      throw error;
    }
  }

  protected piGatewayOrigin(): string {
    return this.env.MODEL_GATEWAY_URL?.trim() ?? "";
  }

  /** Attaching for one more socket re-sends the snapshot to every pi socket. */
  protected async attachPiClients(): Promise<{
    snapshot: unknown;
    hasOlder: boolean;
  }> {
    // This attach is the one the opening would otherwise start.
    const attaching = this.piClientsAttaching;
    this.piClientsAttaching = true;
    try {
      const runtime = await this.openPiRuntime(this.piGatewayOrigin());
      const { contextFor } = await import("../pi-runtime.js");
      return await runtime.watchForClients(
        (events) => this.hub.broadcastPi(events),
        contextFor(),
      );
    } finally {
      this.piClientsAttaching = attaching;
    }
  }

  /** This conversation's pi-durable harness, opened once per isolate. */
  protected async openPiRuntime(
    gatewayOrigin: string,
  ): Promise<import("../pi-runtime.js").PiConversationRuntime> {
    this.piRuntime ??= import("../pi-runtime.js").then(
      ({ PiConversationRuntime }) =>
        new PiConversationRuntime({
          storage: this.ctx.storage,
          env: this.env,
          gatewayOrigin,
          contextStartSeq: () =>
            this.journal.contextStartSeq("", CLOUD_HISTORY_TOKEN_BUDGET),
          waitUntil: (work) => this.ctx.waitUntil(work),
          report: (error) =>
            log("error", "pi_runtime_report", { message: errorMessage(error) }),
          log: (event, fields) => log("info", event, fields),
          deliverReport: (report, authority, agent) =>
            this.deliverPiAgentReport(report, authority, agent),
          deliverNote: (note, authority) =>
            this.deliverPiAgentNote(note, authority),
          // A computer's cloud agent reports to that computer: its journal
          // import takes the card and gives it to its orchestrator.
          deliverOriginReport: async (report, turnId, agent) => {
            // The computer reads the report from its card; the journal's
            // count of what runs learns it ended now, whether or not the
            // computer is awake to read it.
            if (!report.settled && !agent.running) {
              this.publishPiAgentTerminal(
                report.threadId,
                agent,
                piReportOutcome(report.text),
              );
            }
            const appended = this.journal.appendCard({
              turnId,
              createdAt: Date.now(),
              card: {
                type: "agent-report",
                reportFor: report.origin.deviceId,
                threadId: report.threadId,
                requestId: report.requestId,
                text: report.text,
                ...(report.settled ? { settled: true as const } : {}),
              },
              writer: "orchestrator",
              writerKey: `pi-report:${report.requestId}`,
            });
            if (appended.inserted) this.publish(appended.record);
            log("info", "pi_origin_report_journaled", {
              threadId: report.threadId,
              settled: report.settled === true,
              reportFor: report.origin.deviceId,
              seq: appended.seq,
            });
          },
          deliverThreadReport: (report) => this.deliverPiThreadReport(report),
          // Every client draws the agents' rows from these cards, as it does
          // the loop's; which of them run is pi's to say (`runningAgents`).
          agentStarted: (event) =>
            this.publishAgentLifecycleCard(event.turnId, Date.now(), {
              type: "agent-lifecycle",
              eventId: `pi-agent:${event.threadId}:${event.attempt}:started`,
              event: {
                type: "agent-started",
                payload: {
                  agentId: event.threadId,
                  attemptGeneration: event.attempt,
                  description: event.description,
                  agentType: "general",
                  ...(event.attempt > 1 ? { isFollowUp: true } : {}),
                },
              },
            }),
          // A pause reports nothing to the orchestrator, which is not woken
          // for it; the agent's cards still end, or its row would read as
          // running for good.
          agentPaused: (event) =>
            this.publishPiAgentTerminal(
              event.threadId,
              event,
              { kind: "canceled", body: "Paused." },
              event.turnId,
            ),
          agentsChanged: () => this.refreshAgentsSoon(),
          agentTools: (authority, browser) =>
            this.createPiAgentTools(authority, browser),
          browserHandoff: (handoff, signal) =>
            this.awaitPiBrowserHandoff(handoff, signal),
          agentGuard: (authority, turnId) =>
            this.piAgentGuard(authority, turnId),
          deviceAgents: this.piDeviceAgents(),
          // Her brief continues there once this turn ends (`runPiTurn`).
          moveBrain: async (authority, host, brief) => {
            const handoff: BrainHandoff = {
              turnId: this.activeTurnId ?? "",
              ownerId: authority.ownerId,
              ownerGeneration: authority.ownerGeneration,
              deviceId: host.deviceId,
              clientMsgId: `handoff-${crypto.randomUUID()}`,
              prompt: piBrainHandoffPrompt("the cloud", brief),
            };
            if (this.activeTurnId) {
              await this.putTurnState({ [BRAIN_HANDOFF_KEY]: handoff });
              await this.setPiBrain(host);
              return;
            }
            // No turn of this object's runs her: nothing to wait for.
            await this.setPiBrain(host);
            await this.placeOnPiBrain({ ...handoff, handoff: true });
          },
          // What the agents reach beyond this conversation's harness: the
          // owner's agent threads and other sessions, as the loop's do.
          agentDirectory: {
            list: async (authority) =>
              await readAgentDirectory(
                this.piOwnerCaller(authority),
                authority.conversationId,
              ),
            message: async (authority, args) =>
              await sendAgentMessage(this.piOwnerCaller(authority), args),
          },
          heartbeat: () => {
            void (async () => {
              await this.ctx.storage.put(PI_LIVE_KEY, true);
              await this.armAlarmNoLaterThan(Date.now() + PI_HEARTBEAT_MS);
            })().catch(() => undefined);
          },
        }),
    );
    const runtime = await this.piRuntime;
    await runtime.open();
    // From now on pi says which of its agents run here.
    if (!this.agentsView) {
      this.agentsView = { pi: [], owner: [] };
      this.refreshAgentsSoon();
    }
    // Sockets that watched the pi view through an eviction get a new stream
    // and a fresh snapshot.
    if (
      !runtime.watchingForClients &&
      !this.piClientsAttaching &&
      this.hub.piSocketCount() > 0
    ) {
      this.piClientsAttaching = true;
      void import("../pi-runtime.js")
        .then(async ({ contextFor }) => {
          const view = await runtime.watchForClients(
            (events) => this.hub.broadcastPi(events),
            contextFor(),
          );
          this.hub.broadcastPi([view.snapshot]);
        })
        .catch((error: unknown) => {
          log("error", "pi_clients_attach_failed", {
            message: errorMessage(error),
          });
        })
        .finally(() => {
          this.piClientsAttaching = false;
        });
    }
    return runtime;
  }

  /**
   * An agent's report reaches the orchestrator as a hidden wake turn, through
   * the same admission as any turn. Its request id is the turn's
   * `clientMsgId`, so a report sent again after an eviction is a replay.
   */
  /** The owner's object, as the pi agents' directory reads and messages it. */
  protected piOwnerCaller(
    authority: import("../pi-runtime.js").PiAuthority,
  ): AgentMessagingCaller {
    return {
      ownerGeneration: authority.ownerGeneration,
      ownerInternal: async (name, args) =>
        unwrapRpc(
          await this.ownerGate(authority.ownerId).ownerInternal({
            name,
            args,
            ownerGeneration: authority.ownerGeneration,
          }),
        ),
    };
  }

  /**
   * Agents a cloud pi conversation places on the owner's devices: started,
   * messaged and paused through the owner's agent threads, the loop's device
   * agents' plane. The device runs one as a whole; its report comes back as
   * the same wake turn. Control receipts are kept per thread.
   */
  protected piDeviceAgents(): import("../pi-runtime.js").PiDeviceAgents {
    type Authority = import("../pi-runtime.js").PiAuthority;
    const caller = (
      authority: Authority,
      parentTurnId: string,
    ): DeviceAgentCaller => ({
      ownerInternal: async (name, args) =>
        unwrapRpc(
          await this.ownerGate(authority.ownerId).ownerInternal({
            name,
            args,
            ownerGeneration: authority.ownerGeneration,
          }),
        ),
      ownerGeneration: authority.ownerGeneration,
      conversationId: authority.conversationId,
      parentTurnId,
    });
    const receiptKey = (threadId: string) =>
      `${PI_DEVICE_AGENT_PREFIX}${threadId}`;
    const receipt = async (
      threadId: string,
    ): Promise<CloudAgentControlReceipt> => {
      const prior = await this.ctx.storage.get<CloudAgentControlReceipt>(
        receiptKey(threadId),
      );
      if (!prior) throw new Error(`No agent ${threadId} here.`);
      return prior;
    };
    // The owner's agent threads replay by request id across conversations.
    const requestId = (authority: Authority, key: string) =>
      `pi:${authority.conversationId}:${key}`.slice(0, 128);
    return {
      start: async (args, authority, parentTurnId) => {
        const started = await spawnDeviceAgent(
          caller(authority, parentTurnId),
          {
            clientMsgId: requestId(authority, args.key),
            targetDeviceId: args.deviceId,
            description: args.description,
            prompt: args.prompt,
          },
        );
        await this.ctx.storage.put(receiptKey(started.threadId), started);
        return { threadId: started.threadId };
      },
      message: async (args, authority, parentTurnId) => {
        const next = await continueDeviceAgent(
          caller(authority, parentTurnId),
          await receipt(args.threadId),
          {
            controlRequestId: requestId(authority, args.key),
            message: args.message,
          },
        );
        await this.ctx.storage.put(receiptKey(args.threadId), next);
      },
      status: async (threadId, authority, parentTurnId) => {
        const current = await readDeviceAgent(
          caller(authority, parentTurnId),
          await receipt(threadId),
        );
        await this.ctx.storage.put(receiptKey(threadId), current);
        return `${current.status} on device ${current.executorDeviceId ?? "?"}`;
      },
      pause: async (args, authority, parentTurnId) => {
        const next = await cancelDeviceAgent(
          caller(authority, parentTurnId),
          await receipt(args.threadId),
          requestId(authority, args.key),
        );
        await this.ctx.storage.put(receiptKey(args.threadId), next);
      },
    };
  }

  /**
   * A hidden wake turn on this conversation for one of its pi agents, from
   * the turn plane's service side: what Stella reads is the prompt, and no
   * client shows it. Idempotent per `clientMsgId`.
   */
  protected async startPiAgentWake(
    authority: import("../pi-runtime.js").PiAuthority,
    wake: { clientMsgId: string; prompt: string },
  ): Promise<Response> {
    const start: CloudTurnStartRequest = {
      protocol: TURN_PLANE_PROTOCOL,
      clientMsgId: wake.clientMsgId,
      prompt: wake.prompt,
      lane: "wake",
      source: "agent-thread",
      hiddenMessage: true,
    };
    return await this.handleTurnStart(
      new Request("https://orchestrator-session/turn", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [HEADER_OWNER]: authority.ownerId,
          [HEADER_TURN_AUTH_KIND]: "service",
          [TURN_OWNER_GENERATION_HEADER]: authority.ownerGeneration,
        },
        body: JSON.stringify(start),
      }),
    );
  }

  /** A note one of this conversation's pi agents sent Stella: a hidden wake turn, as its report is. */
  protected async deliverPiAgentNote(
    note: import("@stella/agent/stella/agents").AgentNote,
    authority: import("../pi-runtime.js").PiAuthority,
  ): Promise<void> {
    const response = await this.startPiAgentWake(authority, {
      clientMsgId: note.requestId.slice(0, 64),
      prompt: note.text.slice(0, AGENT_MESSAGE_FRAMED_MAX_CHARS),
    });
    const body = await response.text().catch(() => "");
    if (response.status !== 202 && response.status !== 200) {
      throw new Error(
        `Stella did not take the agent's message (${response.status}): ${body.slice(0, 300)}`,
      );
    }
    log("info", "pi_agent_note_delivered", {
      conversationId: authority.conversationId,
      threadId: note.threadId,
      requestId: note.requestId,
      status: response.status,
    });
  }

  protected async deliverPiAgentReport(
    report: import("@stella/agent/stella/agents").AgentReport,
    authority: import("../pi-runtime.js").PiAuthority,
    agent: import("../pi-runtime.js").PiAgentInfo,
  ): Promise<void> {
    const limit = AGENT_MESSAGE_FRAMED_MAX_CHARS;
    const prompt =
      report.text.length <= limit
        ? report.text
        : `${report.text.slice(0, limit - 40)}\n[report truncated]`;
    const response = await this.startPiAgentWake(authority, {
      clientMsgId: report.requestId.slice(0, 64),
      prompt,
    });
    const body = await response.text().catch(() => "");
    if (response.status !== 202 && response.status !== 200) {
      throw new Error(
        `The agent's report was refused (${response.status}): ${body.slice(0, 300)}`,
      );
    }
    log("info", "pi_agent_report_delivered", {
      conversationId: authority.conversationId,
      threadId: report.threadId,
      requestId: report.requestId,
      status: response.status,
    });
    // The agent's attempt ends on the turn its report wakes.
    const wakeTurnId = (() => {
      try {
        return (JSON.parse(body) as { turnId?: unknown }).turnId;
      } catch {
        return undefined;
      }
    })();
    if (typeof wakeTurnId !== "string" || !wakeTurnId) return;
    // What the agent saved to the drive and linked, as the loop's agents' files card.
    if (agent.files?.length) {
      this.publishTurnFilesCard(
        wakeTurnId,
        `pi-files:${report.requestId}`,
        agent.files,
      );
    }
    // A message since has it working again: this report does not end it.
    if (agent.running) return;
    this.publishPiAgentTerminal(
      report.threadId,
      agent,
      piReportOutcome(report.text),
      wakeTurnId,
    );
  }

  /** The card that ends one of pi's agents' attempts, under `turnId` (its own, by default). */
  protected publishPiAgentTerminal(
    threadId: string,
    agent: import("../pi-runtime.js").PiAgentInfo,
    outcome: { kind: "completed" | "failed" | "canceled"; body: string },
    turnId = `pi-agent:${threadId}`,
  ): void {
    const identity = { agentId: threadId, attemptGeneration: agent.attempt };
    this.publishAgentLifecycleCard(turnId, Date.now(), {
      type: "agent-lifecycle",
      eventId: `pi-agent:${threadId}:${agent.attempt}:${outcome.kind}`,
      event:
        outcome.kind === "completed"
          ? {
              type: "agent-completed",
              payload: { ...identity, result: outcome.body },
            }
          : {
              type:
                outcome.kind === "failed" ? "agent-failed" : "agent-canceled",
              payload: {
                ...identity,
                ...(outcome.body ? { error: outcome.body } : {}),
              },
            },
    });
  }

  /**
   * Start one attempt of an agent thread as a pi agent here, right away: pi
   * runs it in the background whatever turn this conversation is running,
   * on the authority its dispatcher admitted. The attempt is recorded before
   * pi has it, so a pause that arrives first stops it, and a retried
   * dispatch hands it over once. The owner's agent threads learn it started
   * once pi has it.
   */
  async startPiThread(input: PiThreadStart): Promise<void> {
    const { attempt } = input;
    if (this.purged()) throw new Error("This conversation was deleted.");
    const owner = this.journal.meta().owner_id;
    if (owner && owner !== input.ownerId) {
      throw new Error("This conversation belongs to another account.");
    }
    let record =
      (await this.ctx.storage.get<PiThreadRecord>(
        piThreadKey(attempt.threadId),
      )) ??
      ({
        ownerId: input.ownerId,
        ownerGeneration: input.ownerGeneration,
        threadId: attempt.threadId,
        description: attempt.description,
        ...(attempt.originDeviceId
          ? { originDeviceId: attempt.originDeviceId }
          : {}),
        attempts: [],
        settledThrough: 0,
      } satisfies PiThreadRecord);
    if (attempt.attemptGeneration <= record.settledThrough) return;
    let open = record.attempts.find(
      (entry) => entry.attemptGeneration === attempt.attemptGeneration,
    );
    if (!open) {
      open = {
        turnId: attempt.turnId,
        attemptGeneration: attempt.attemptGeneration,
      };
      record = { ...record, attempts: [...record.attempts, open] };
      await this.ctx.storage.put(piThreadKey(attempt.threadId), record);
    }
    // Paused before it started: it never starts.
    if (open.pausing) {
      await this.settlePiThreadAttempts(record, attempt.attemptGeneration, {
        status: "canceled",
        errorMessage: "Paused by orchestrator.",
      });
      return;
    }
    if (open.handedOff) return;
    const [runtime, { contextFor }, destinations] = await Promise.all([
      this.openPiRuntime(this.piGatewayOrigin()),
      import("../pi-runtime.js"),
      this.ownerGate(input.ownerId)
        .devices()
        .catch(() => null),
    ]);
    await runtime.threadAttempt(
      {
        threadId: attempt.threadId,
        description: attempt.description,
        attemptGeneration: attempt.attemptGeneration,
        authority: {
          ownerId: input.ownerId,
          ownerGeneration: input.ownerGeneration,
          conversationId: input.conversationId,
          audience: input.audience,
          budgetMicroCents: input.budgetMicroCents,
          execution: input.execution,
        },
        // A ChatGPT plan agent runs on the plan's model, which the gateway does not resolve.
        ...(input.execution.engine === "stella"
          ? { model: piModelSpec("general", input.execution, input.audience) }
          : {}),
        executionContext: cloudExecutionContext(input, destinations),
      },
      input.prompt,
      contextFor(),
    );
    const now = Date.now();
    const handed = await this.updatePiThreadRecord(
      attempt.threadId,
      (current) => ({
        ...current,
        attempts: current.attempts.map((entry) =>
          entry.attemptGeneration === attempt.attemptGeneration
            ? { ...entry, handedOff: true }
            : entry,
        ),
      }),
    );
    await this.deferOwnerEvents([
      {
        v: OWNER_EVENT_VERSION,
        key: attempt.turnId,
        ownerId: input.ownerId,
        ownerGeneration: input.ownerGeneration,
        emittedAt: now,
        kind: "turn.started",
        turnId: attempt.turnId,
        turnKind: "agent",
        conversationId: input.conversationId,
        sessionId: attempt.threadId,
        lane: "agent",
        source: "agent-thread",
        threadId: attempt.threadId,
        attemptGeneration: attempt.attemptGeneration,
        agentType: "general",
        execution: input.execution,
        prompt: input.prompt,
        createdAt: now,
      },
    ]);
    // Paused while pi took it: it stops now, and settles as canceled.
    if (
      handed?.attempts.find(
        (entry) => entry.attemptGeneration === attempt.attemptGeneration,
      )?.pausing
    ) {
      await runtime.pauseThreadAgent(attempt.threadId, contextFor());
    }
    // Agents keep this object waking while they run.
    await this.piHeartbeat().catch(() => undefined);
    log("info", "pi_thread_attempt_started", {
      threadId: attempt.threadId,
      attemptTurnId: attempt.turnId,
      attemptGeneration: attempt.attemptGeneration,
    });
  }

  protected async updatePiThreadRecord(
    threadId: string,
    change: (record: PiThreadRecord) => PiThreadRecord,
  ): Promise<PiThreadRecord | undefined> {
    return await this.ctx.blockConcurrencyWhile(async () => {
      const current = await this.ctx.storage.get<PiThreadRecord>(
        piThreadKey(threadId),
      );
      if (!current) return undefined;
      const next = change(current);
      await this.ctx.storage.put(piThreadKey(threadId), next);
      return next;
    });
  }

  /**
   * A report of an agent thread's agent. It answers one attempt (the one
   * whose message its run took; older open attempts are answered with it).
   * A report without text settles an attempt only when it was paused.
   */
  protected async deliverPiThreadReport(
    report: import("../pi-runtime.js").PiThreadReport,
  ): Promise<void> {
    const record = await this.ctx.storage.get<PiThreadRecord>(
      piThreadKey(report.threadId),
    );
    const handedOff = record?.attempts.filter((entry) => entry.handedOff) ?? [];
    const answered =
      report.attemptGeneration ?? handedOff.at(-1)?.attemptGeneration;
    const attempt = record?.attempts.find(
      (entry) => entry.attemptGeneration === answered,
    );
    if (!record || !attempt) {
      log("info", "pi_thread_report_unmatched", {
        threadId: report.threadId,
        requestId: report.requestId,
        attemptGeneration: report.attemptGeneration ?? null,
      });
      return;
    }
    let outcome: PiThreadOutcome;
    if (report.settled) {
      if (!attempt.pausing) return;
      outcome = { status: "canceled", errorMessage: "Paused by orchestrator." };
    } else {
      const parsed = piReportOutcome(report.text);
      outcome =
        parsed.kind === "completed"
          ? {
              status: "completed",
              resultJson: JSON.stringify({ finalText: parsed.body }),
            }
          : {
              status: parsed.kind,
              errorMessage:
                parsed.body ||
                (parsed.kind === "canceled"
                  ? "The agent was stopped."
                  : "The agent hit a problem and stopped."),
            };
    }
    await this.settlePiThreadAttempts(record, attempt.attemptGeneration, {
      ...outcome,
      ...(report.files?.length ? { files: report.files } : {}),
    });
  }

  /**
   * Settle an agent thread's attempts through `attemptGeneration` with one
   * outcome, as a BuildSession settles its agent's: each attempt's terminal
   * event and the thread's completion go to the owner's agent threads, and
   * the conversation that started the thread is woken with the report
   * (a computer's dispatch is delivered to it by the agent threads). The
   * decision is kept before anything is sent, so a redelivered report
   * repeats the same terminal and the same wake.
   */
  protected async settlePiThreadAttempts(
    record: PiThreadRecord,
    attemptGeneration: number,
    outcome: PiThreadOutcome,
  ): Promise<void> {
    const decided = await this.ctx.blockConcurrencyWhile(async () => {
      const current =
        (await this.ctx.storage.get<PiThreadRecord>(
          piThreadKey(record.threadId),
        )) ?? record;
      const merged = current.attempts.some(
        (entry) => entry.attemptGeneration === attemptGeneration,
      )
        ? current
        : {
            ...current,
            attempts: [
              ...current.attempts,
              ...record.attempts.filter(
                (entry) => entry.attemptGeneration === attemptGeneration,
              ),
            ],
          };
      const settling = merged.attempts.filter(
        (entry) => entry.attemptGeneration <= attemptGeneration,
      );
      if (settling.length === 0) return undefined;
      const terminal = settling.find(
        (entry) => entry.attemptGeneration === attemptGeneration,
      )?.terminal ?? { ...outcome, completedAt: Date.now() };
      const next: PiThreadRecord = {
        ...merged,
        attempts: merged.attempts.map((entry) =>
          entry.attemptGeneration <= attemptGeneration
            ? { ...entry, terminal: entry.terminal ?? terminal }
            : entry,
        ),
      };
      await this.ctx.storage.put(piThreadKey(record.threadId), next);
      return { next, terminal };
    });
    if (!decided) return;
    const { next, terminal } = decided;
    const settling = next.attempts.filter(
      (entry) => entry.attemptGeneration <= attemptGeneration,
    );
    const latest = settling.find(
      (entry) => entry.attemptGeneration === attemptGeneration,
    )!;
    const base = (key: string) => ({
      v: OWNER_EVENT_VERSION,
      key,
      ownerId: next.ownerId,
      ownerGeneration: next.ownerGeneration,
      emittedAt: terminal.completedAt,
    });
    const events: OwnerEvent[] = [];
    if (terminal.files?.length) {
      events.push({
        ...base(`${latest.turnId}:${latest.attemptGeneration}:1`),
        kind: "turn.event",
        turnId: latest.turnId,
        attemptGeneration: latest.attemptGeneration,
        sessionId: next.threadId,
        eventSeq: 1,
        eventKind: "output_files",
        payload: { files: terminal.files },
        terminal: false,
        createdAt: terminal.completedAt,
      });
    }
    for (const entry of settling) {
      const settled = entry.terminal ?? terminal;
      events.push({
        ...base(`${entry.turnId}:${entry.attemptGeneration}:2`),
        kind: "turn.event",
        turnId: entry.turnId,
        attemptGeneration: entry.attemptGeneration,
        sessionId: next.threadId,
        eventSeq: 2,
        eventKind: settled.status,
        payload:
          settled.status === "completed"
            ? { finalText: agentLifecycleReport(settled) }
            : { message: settled.errorMessage ?? "The agent stopped." },
        terminal: true,
        terminalStatus: settled.status,
        ...(settled.resultJson ? { resultJson: settled.resultJson } : {}),
        ...(settled.errorMessage ? { errorMessage: settled.errorMessage } : {}),
        createdAt: settled.completedAt,
      });
    }
    events.push({
      ...base(`${next.threadId}:${latest.turnId}:${latest.attemptGeneration}`),
      kind: "thread.completed",
      threadId: next.threadId,
      turnId: latest.turnId,
      attemptGeneration: latest.attemptGeneration,
      status: terminal.status,
      ...(terminal.resultJson ? { resultJson: terminal.resultJson } : {}),
      ...(terminal.errorMessage ? { errorMessage: terminal.errorMessage } : {}),
      completedAt: terminal.completedAt,
    });
    await this.deferOwnerEvents(events);
    if (!next.originDeviceId) {
      const completion = {
        status: terminal.status,
        ...(terminal.resultJson ? { resultJson: terminal.resultJson } : {}),
        ...(terminal.errorMessage
          ? { errorMessage: terminal.errorMessage }
          : {}),
      };
      const wake: CloudTurnStartRequest = {
        protocol: TURN_PLANE_PROTOCOL,
        clientMsgId: `wake:${next.threadId}:${latest.attemptGeneration}`.slice(
          0,
          64,
        ),
        prompt: agentCompletionPromptText({
          threadId: next.threadId,
          description: next.description,
          ...completion,
        }),
        lane: "wake",
        source: "agent-thread",
        hiddenMessage: true,
        agentThreadControl: {
          lifecycleReport: agentLifecycleReport(completion),
          threadId: next.threadId,
          attemptGeneration: latest.attemptGeneration,
          threadUpdatedAt: terminal.completedAt,
          status: terminal.status,
        },
      };
      const response = await this.handleTurnStart(
        new Request("https://orchestrator-session/turn", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [HEADER_OWNER]: next.ownerId,
            [HEADER_TURN_AUTH_KIND]: "service",
            [TURN_OWNER_GENERATION_HEADER]: next.ownerGeneration,
          },
          body: JSON.stringify(wake),
        }),
      );
      const body = await response.text().catch(() => "");
      if (response.status !== 202 && response.status !== 200) {
        // pi delivers the report again; the kept decision repeats this wake.
        throw new Error(
          `The agent's report was refused (${response.status}): ${body.slice(0, 300)}`,
        );
      }
    }
    await this.updatePiThreadRecord(next.threadId, (current) => ({
      ...current,
      attempts: current.attempts.filter(
        (entry) => entry.attemptGeneration > attemptGeneration,
      ),
      settledThrough: Math.max(current.settledThrough, attemptGeneration),
    }));
    log("info", "pi_thread_attempt_settled", {
      threadId: next.threadId,
      attemptGeneration,
      status: terminal.status,
      woke: !next.originDeviceId,
    });
  }

  /**
   * New input for the running attempt of an agent thread whose agent runs
   * here; it reads it before its next step. `unknown` when none does.
   */
  async steerPiThread(input: PiThreadSteer): Promise<PiThreadSteerResult> {
    const record = await this.ctx.storage.get<PiThreadRecord>(
      piThreadKey(input.threadId),
    );
    if (
      !record ||
      record.ownerId !== input.ownerId ||
      record.ownerGeneration !== input.ownerGeneration
    ) {
      return { accepted: false, reason: "unknown" };
    }
    const running = record.attempts
      .filter((entry) => entry.handedOff && !entry.terminal && !entry.pausing)
      .at(-1);
    if (!running) return { accepted: false, reason: "not_running" };
    const runtime = await this.openPiRuntime(this.piGatewayOrigin());
    const { contextFor } = await import("../pi-runtime.js");
    await runtime.steerThreadAgent(
      {
        threadId: input.threadId,
        attemptGeneration: running.attemptGeneration,
        messageId: input.messageId,
        text: input.text,
      },
      contextFor(),
    );
    return {
      accepted: true,
      turnId: running.turnId,
      attemptGeneration: running.attemptGeneration,
    };
  }

  /**
   * Pause one exact attempt of an agent thread whose agent runs here. Its
   * attempt settles as canceled once its run stops, or as it is handed over
   * if pi does not have it yet.
   */
  async pausePiThread(input: PiThreadPause): Promise<PiThreadPauseResult> {
    const decided = await this.ctx.blockConcurrencyWhile(
      async (): Promise<PiThreadPauseResult | "pause"> => {
        const record = await this.ctx.storage.get<PiThreadRecord>(
          piThreadKey(input.threadId),
        );
        if (
          !record ||
          record.ownerId !== input.ownerId ||
          record.ownerGeneration !== input.ownerGeneration
        ) {
          return "unknown";
        }
        if (input.attemptGeneration <= record.settledThrough) return "terminal";
        const attempt = record.attempts.find(
          (entry) => entry.attemptGeneration === input.attemptGeneration,
        );
        if (attempt && attempt.turnId !== input.turnId) return "changed";
        if (
          record.attempts.some(
            (entry) => entry.attemptGeneration > input.attemptGeneration,
          )
        ) {
          return "changed";
        }
        if (attempt?.terminal) return "terminal";
        await this.ctx.storage.put(piThreadKey(input.threadId), {
          ...record,
          attempts: attempt
            ? record.attempts.map((entry) =>
                entry === attempt ? { ...entry, pausing: true } : entry,
              )
            : [
                ...record.attempts,
                {
                  turnId: input.turnId,
                  attemptGeneration: input.attemptGeneration,
                  pausing: true,
                },
              ],
        } satisfies PiThreadRecord);
        return attempt?.handedOff ? "pause" : "paused";
      },
    );
    if (decided !== "pause") return decided;
    const runtime = await this.openPiRuntime(this.piGatewayOrigin());
    const { contextFor } = await import("../pi-runtime.js");
    await runtime.pauseThreadAgent(input.threadId, contextFor());
    return "paused";
  }

  /**
   * While pi has work in flight here (agents running, their reports on the
   * way), wake this object every {@link PI_HEARTBEAT_MS}. A wake after an
   * eviction reopens the harness, which resumes that work.
   */
  protected async piHeartbeat(): Promise<void> {
    // Any conversation may hold pi work: its own, or a computer's cloud agent.
    const live = await this.ctx.storage.get<boolean>(PI_LIVE_KEY);
    if (!this.piRuntime && !live) return;
    const reopening = !this.piRuntime;
    const gatewayOrigin = this.env.MODEL_GATEWAY_URL?.trim() ?? "";
    const runtime = await this.openPiRuntime(gatewayOrigin);
    const { contextFor } = await import("../pi-runtime.js");
    const busy = await runtime.busy(contextFor());
    if (reopening) log("info", "pi_heartbeat_reopened", { busy });
    if (busy !== Boolean(live)) {
      if (busy) await this.ctx.storage.put(PI_LIVE_KEY, true);
      else await this.ctx.storage.delete(PI_LIVE_KEY);
    }
    if (busy) await this.armAlarmNoLaterThan(Date.now() + PI_HEARTBEAT_MS);
  }

  /**
   * Abort what pi is running for this conversation when no live turn here
   * holds the run: a watchdog firing in an isolate that never resumed it.
   */
  protected async abortPiConversation(): Promise<void> {
    if ((await this.ctx.storage.get<string>(AGENT_RUNTIME_KEY)) !== "pi")
      return;
    const gatewayOrigin = this.env.MODEL_GATEWAY_URL?.trim() ?? "";
    const runtime = await this.openPiRuntime(gatewayOrigin);
    const { root } = await runtime.open();
    const { contextFor } = await import("../pi-runtime.js");
    await root.abort(contextFor());
  }

  /**
   * Stella moved to one of the owner's computers during this turn, pi's or
   * Claude Code's (`switch_destination`): now that the turn has ended, her
   * brief continues there, as a computer's hand-off does. A turn the user
   * stopped leaves her there with nothing to carry on.
   */
  protected async placeBrainHandoff(
    turnId: string,
    stopped: boolean,
  ): Promise<void> {
    const handoff = await this.getTurnState<BrainHandoff>(BRAIN_HANDOFF_KEY);
    if (!handoff) return;
    if (this.ctx.storage.kv) this.ctx.storage.kv.delete(BRAIN_HANDOFF_KEY);
    else await this.ctx.storage.delete(BRAIN_HANDOFF_KEY);
    if (handoff.turnId !== turnId || stopped) return;
    try {
      const dispatchId = await this.placeOnPiBrain({
        ownerId: handoff.ownerId,
        ownerGeneration: handoff.ownerGeneration,
        deviceId: handoff.deviceId,
        clientMsgId: handoff.clientMsgId,
        prompt: handoff.prompt,
        handoff: true,
      });
      log("info", "pi_brain_handoff_placed", {
        turnId,
        deviceId: handoff.deviceId,
        dispatchId,
      });
    } catch (error) {
      log("error", "pi_brain_handoff_failed", {
        turnId,
        deviceId: handoff.deviceId,
        message: errorMessage(error),
      });
    }
  }

  /**
   * The agents still working whose reports would wake Stella here, by
   * description: the owner's agent threads running in this conversation,
   * and pi's own where pi ran here.
   */
  protected async workingAgentDescriptions(): Promise<string[]> {
    const owner = await this.ownerRunningAgents();
    const pi = this.agentsView?.pi ?? [];
    const listed = new Set(pi.map((agent) => agent.agentId));
    return [...pi, ...owner.filter((agent) => !listed.has(agent.agentId))].map(
      (agent) => agent.title,
    );
  }

  protected async setPiBrain(host: PiBrainHost): Promise<PiBrainRecord> {
    const prior = await this.ctx.storage.get<PiBrainRecord>(PI_BRAIN_KEY);
    const record: PiBrainRecord = {
      ...host,
      epoch: (prior?.epoch ?? 0) + 1,
      updatedAt: Date.now(),
    };
    await this.ctx.storage.put(PI_BRAIN_KEY, record);
    log("info", "pi_brain_moved", {
      host: record.host,
      ...(record.host === "device" ? { deviceId: record.deviceId } : {}),
      epoch: record.epoch,
    });
    return record;
  }

  /**
   * Why the computer this conversation's Stella runs on can't take a turn
   * now, as pi's `switch_destination` would refuse a move there; undefined
   * when it can.
   */
  protected async piBrainDeviceRefusal(
    ownerId: string,
    deviceId: string,
  ): Promise<string | undefined> {
    const listed = await this.ownerGate(ownerId)
      .devices()
      .catch(() => undefined);
    if (!listed) return "the devices list could not be read";
    const device = listed.devices.find((entry) => entry.deviceId === deviceId);
    if (!device) return "not connected";
    const { deviceRefusal } = await import("@stella/agent/stella/execution");
    return deviceRefusal(device, device.label?.trim() || deviceId);
  }

  /**
   * A chat for this conversation placed on the computer its Stella runs on,
   * which answers it from the shared journal: a message the user sent from
   * elsewhere, or Stella's own brief when she moved there.
   */
  protected async placeOnPiBrain(args: {
    ownerId: string;
    ownerGeneration?: string;
    deviceId: string;
    clientMsgId: string;
    prompt: string;
    attachments?: string[];
    locale?: string;
    handoff?: true;
  }): Promise<string> {
    const conversationId = this.conversationId();
    const placed = await this.ownerGate(args.ownerId).submit({
      request: {
        protocol: PLACEMENT_PROTOCOL,
        idempotencyKey: `pi-brain:${args.clientMsgId}`.slice(0, 128),
        kind: "chat",
        ingress: "cloud",
        subject: "portable",
        targetMode: "device",
        targetDeviceId: args.deviceId,
        conversationId,
        requiredCapabilities: [
          "chat",
          ...(args.attachments?.length ? (["attachments"] as const) : []),
        ],
        payload: {
          schemaVersion: 1,
          prompt: args.prompt,
          conversationId,
          clientMsgId: args.clientMsgId,
          userMessageEventId: args.clientMsgId,
          ...(args.locale ? { locale: args.locale } : {}),
          ...(args.attachments?.length
            ? { attachments: args.attachments }
            : {}),
          ...(args.handoff ? { handoff: true as const } : {}),
        },
      },
      ...(args.ownerGeneration
        ? { expectedGeneration: args.ownerGeneration }
        : {}),
    });
    if (!placed.ok) throw new Error(placed.error.message);
    return placed.response.dispatch.dispatchId;
  }

  protected reconcileRunningAgentsSoon(): void {
    const now = Date.now();
    if (now - this.agentsReconciledAt < AGENT_RECONCILE_INTERVAL_MS) return;
    this.agentsReconciledAt = now;
    if (this.agentsView) {
      this.refreshAgentsSoon();
      return;
    }
    this.ctx.waitUntil(
      this.reconcileRunningAgents().catch((error: unknown) => {
        log("error", "conversation_agent_reconcile_failed", {
          conversationId: this.conversationId(),
          message: errorMessage(error),
        });
      }),
    );
  }

  /** Read the running agents again: one read at a time, and one more for what changed during it. */
  protected refreshAgentsSoon(): void {
    if (!this.agentsView || this.purged()) return;
    if (this.agentsRefresh) {
      this.agentsRefreshAgain = true;
      return;
    }
    const refresh = (async () => {
      do {
        this.agentsRefreshAgain = false;
        await this.refreshAgents();
      } while (this.agentsRefreshAgain);
    })()
      .catch((error: unknown) => {
        log("error", "conversation_agents_refresh_failed", {
          conversationId: this.conversationId(),
          message: errorMessage(error),
        });
      })
      .finally(() => {
        this.agentsRefresh = null;
      });
    this.agentsRefresh = refresh;
    this.ctx.waitUntil(refresh);
  }

  /**
   * The running agents of a conversation pi has run in, from the records of
   * whoever runs them: Stella's own from pi's state here, everything else (a
   * computer's agents, agents on a device, agent threads) from the owner's
   * agent threads. Neither is folded from cards, so a card that was never
   * written leaves nothing running; an agent that started before pi listed
   * them and never ended is simply not listed. Clients hear the new list.
   */
  protected async refreshAgents(): Promise<void> {
    // pi's agents start and stop only while pi is open here: one it has not
    // opened for, with none listed, has none running.
    const pi =
      this.piRuntime || this.agentsView?.pi.length
        ? await (async () => {
            const runtime = await this.openPiRuntime(this.piGatewayOrigin());
            const { contextFor } = await import("../pi-runtime.js");
            return await runtime.runningAgents(contextFor());
          })()
        : [];
    const owner = await this.ownerRunningAgents().catch((error: unknown) => {
      log("error", "conversation_owner_agents_failed", {
        conversationId: this.conversationId(),
        message: errorMessage(error),
      });
      return this.agentsView?.owner ?? [];
    });
    if (this.purged()) return;
    const next: AgentsView = { pi, owner };
    const changed = JSON.stringify(next) !== JSON.stringify(this.agentsView);
    this.agentsView = next;
    if (changed || !this.agentsViewStored) {
      await this.ctx.storage.put(AGENTS_VIEW_KEY, next);
      this.agentsViewStored = true;
    }
    this.hub.agentsChanged();
  }

  /** The owner's agent threads this conversation lists as running. */
  protected async ownerRunningAgents(): Promise<AgentActivityEntry[]> {
    const ownerId = this.journal.ownerId();
    if (!ownerId) return [];
    const owner = await this.resolveOwnerForCaller({ ownerId });
    if (!owner) return [];
    const threads = unwrapRpc(
      await this.ownerGate(ownerId).ownerInternal({
        name: "agentThreads.runningIn",
        args: {
          ownerGeneration: owner.ownerGeneration,
          conversationId: this.conversationId(),
        },
        ownerGeneration: owner.ownerGeneration,
      }),
    ) as Array<{
      threadId: string;
      description: string;
      agentType: string;
      attemptGeneration: number;
      createdAt: number;
      updatedAt: number;
    }>;
    return threads.map((thread) => ({
      agentId: thread.threadId,
      title: thread.description,
      agentType: thread.agentType,
      status: "running" as const,
      createdAtMs: thread.createdAt,
      updatedAtMs: thread.updatedAt,
      attemptGeneration: thread.attemptGeneration,
    }));
  }

  /**
   * Settle what the journal of a conversation pi never ran in still shows
   * as running and has in fact ended: there its cards are what lists them.
   *
   * Whoever owns an agent's record writes the card that ends it: its report,
   * the owner's agent threads for a computer's agents. But the owner's post
   * is best effort, and an agent that ended before those cards existed has
   * none, so it read as running for good (the phantom "N agents running" a
   * phone showed). When a client connects, each agent the journal lists as
   * running is checked against the owner's agent threads (a computer's
   * agents, cloud agents, agents on a device). One that ended is settled
   * with how it ended; one still running there is left alone, and a computer
   * settles its own on its next start (`computer-agent-reconcile`).
   *
   * The first pass in a conversation also settles what no owner knows at all:
   * an agent its journal has carried since before any owner recorded agents.
   */
  protected async reconcileRunningAgents(): Promise<void> {
    if (this.purged()) return;
    const running = this.journal.runningAgents();
    const ownerId = this.journal.ownerId();
    if (running.length === 0 || !ownerId || (await this.turnRunning())) return;
    const owner = await this.resolveOwnerForCaller({ ownerId });
    if (!owner) return;
    const startedAt = Date.now();
    const threads = new Map(
      (
        unwrapRpc(
          await this.ownerGate(ownerId).ownerInternal({
            name: "agentThreads.statuses",
            args: {
              ownerGeneration: owner.ownerGeneration,
              threadIds: running.map((entry) => entry.agentId),
            },
            ownerGeneration: owner.ownerGeneration,
          }),
        ) as Array<{
          threadId: string;
          status: string;
          attemptGeneration: number;
          errorMessage?: string;
        }>
      ).map((thread) => [thread.threadId, thread]),
    );
    const unownedSettled = Boolean(
      await this.ctx.storage.get<number>(AGENTS_UNOWNED_SETTLED_KEY),
    );
    // Cards are rows: none lands inside a turn that started meanwhile.
    if (this.purged() || (await this.turnRunning())) return;
    for (const entry of running) {
      const thread = threads.get(entry.agentId);
      let ended: {
        kind: "completed" | "failed" | "canceled";
        attempt: number;
        body: string;
      } | null = null;
      if (thread) {
        // An owner record behind the journal's newest start is not about that start.
        if (
          (thread.status === "completed" ||
            thread.status === "failed" ||
            thread.status === "canceled") &&
          thread.attemptGeneration >= (entry.attemptGeneration ?? 0)
        ) {
          ended = {
            kind: thread.status,
            attempt: entry.attemptGeneration ?? thread.attemptGeneration,
            body: thread.errorMessage ?? "",
          };
        }
      } else if (
        !unownedSettled &&
        entry.createdAtMs < startedAt - AGENT_OWNER_RECORD_LAG_MS
      ) {
        ended = {
          kind: "canceled",
          attempt: entry.attemptGeneration ?? 1,
          body: "No longer running: Stella lost track of this agent when it stopped.",
        };
      }
      if (!ended) continue;
      const identity = {
        agentId: entry.agentId,
        attemptGeneration: ended.attempt,
      };
      this.publishAgentLifecycleCard(`settle:${entry.agentId}`, Date.now(), {
        type: "agent-lifecycle",
        eventId: `settle:${entry.agentId}:${ended.attempt}`,
        event:
          ended.kind === "completed"
            ? { type: "agent-completed", payload: { ...identity, result: "" } }
            : {
                type:
                  ended.kind === "failed" ? "agent-failed" : "agent-canceled",
                payload: {
                  ...identity,
                  ...(ended.body ? { error: ended.body } : {}),
                },
              },
      });
      log("info", "conversation_agent_settled", {
        conversationId: this.conversationId(),
        agentId: entry.agentId,
        status: ended.kind,
        by: thread ? "owner" : "unowned",
      });
    }
    if (!unownedSettled)
      await this.ctx.storage.put(AGENTS_UNOWNED_SETTLED_KEY, startedAt);
  }

  /**
   * A pi-durable cloud agent's own tools: web, and code with the owner's
   * connectors and the run's cloud browser (its files and shell are its
   * container's). Built on the authority the agents keep, since they run
   * between turns.
   */
  protected async createPiAgentTools(
    authority: {
      ownerId: string;
      ownerGeneration: string;
      conversationId: string;
    },
    browser: CloudBrowserClient | undefined,
  ): Promise<CloudCodeSourceAgentTool[]> {
    const ownerInternal = async (name: string, args: unknown) =>
      unwrapRpc(
        await this.ownerGate(authority.ownerId).ownerInternal({
          name,
          args,
          ownerGeneration: authority.ownerGeneration,
        }),
      );
    const web = createCloudWebTool({ ownerInternal });
    const connectors = new CloudConnectorDirectory({
      source: {
        catalog: () => listIntegrationCatalog(this.env),
        actions: (args) => listIntegrationActions(this.env, args),
        connections: async () =>
          (await ownerInternal("integrations.connections", {})) as {
            connections: Array<{ id: string; connected: boolean }>;
          },
        run: (args) => ownerInternal("integrations.run", args),
      },
      declines: this.connectorDeclines(),
    });
    const code = await createCloudCodeAgentTool({
      loader: this.env.LOADER,
      tools: [web],
      executionScope: `${authority.ownerGeneration}:${authority.conversationId}:pi-agents`,
      connect: createCloudConnectClient(connectors),
      ...(browser ? { browser } : {}),
    });
    return [code, web];
  }

  /**
   * A pi agent's login handoff, shown to the user as the owner's browser
   * interaction (every signed-in client lists `browser.pending`) and waited
   * on until it ends. Polling is the wait, as for the connect card: the
   * owner object closes the interaction when the user finishes or cancels
   * it, or at its deadline. A stopped agent withdraws it.
   */
  protected async awaitPiBrowserHandoff(
    handoff: import("../pi-runtime.js").PiBrowserHandoff,
    signal: AbortSignal | undefined,
  ): Promise<import("../pi-runtime.js").PiBrowserHandoffEnd> {
    const { authority, browser, suspension } = handoff;
    const ownerInternal = async (name: string, args: unknown) =>
      unwrapRpc(
        await this.ownerGate(authority.ownerId).ownerInternal({
          name,
          args,
          ownerGeneration: authority.ownerGeneration,
        }),
      );
    const interaction = { interactionId: suspension.interactionId };
    await ownerInternal("browser.handoffOpen", {
      conversationId: browser.conversationId,
      threadId: browser.threadId,
      turnId: browser.turnId,
      attemptGeneration: browser.attemptGeneration,
      toolCallId: handoff.toolCallId,
      suspension,
    });
    // The owner's expiry job closes it at its deadline; this one is a backstop.
    const deadline = suspension.expiresAt + BROWSER_HANDOFF_GRACE_MS;
    while (true) {
      if (signal?.aborted || Date.now() >= deadline) {
        await ownerInternal("browser.handoffCancel", interaction).catch(
          () => undefined,
        );
        if (signal?.aborted) throw new Error("Browser handoff withdrawn.");
        return { result: "expired", safeMessage: "Browser access expired." };
      }
      const state = (await ownerInternal(
        "browser.handoffState",
        interaction,
      ).catch(() => undefined)) as
        | { state: string; result?: string; safeMessage?: string }
        | undefined;
      if (
        state &&
        state.state !== "pending" &&
        state.state !== "human_control" &&
        state.result
      ) {
        return {
          result:
            state.result as import("../pi-runtime.js").PiBrowserHandoffEnd["result"],
          safeMessage: state.safeMessage ?? "Browser access ended.",
        };
      }
      // An abort just ends the wait; the loop's next check withdraws it.
      await sleepWithAbort(
        BROWSER_HANDOFF_POLL_MS,
        signal,
        () => new Error("Browser handoff wait aborted."),
      ).catch(() => undefined);
    }
  }

  // Implemented further up the chain.
  protected abstract connectorDeclines(): CloudConnectorDeclines;
  protected abstract handleTurnStart(
    request: Request,
    handoff?: {
      authority: AdmittedCloudChat;
      preparation: CloudChatPreparation;
    },
  ): Promise<Response>;
}
