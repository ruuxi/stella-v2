import {
  type AdmittedCloudChat,
  chatTurnFingerprintSource,
  type CloudChatHandoff,
  cloudChatHandoffKey,
  type CloudChatPreparation,
  cloudChatTurnKey,
} from "../cloud-chat-admission.js";
import {
  HEADER_GATE_ADMITTED,
  HEADER_TURN_AUTH_KIND,
  turnStartErrorResponse,
} from "../turn-start-request.js";
import {
  type PiAgentExecution,
  runsAsPiAgent,
} from "../cloud-agent-dispatch.js";
import type { ManagedModelAudience } from "@stella/contracts/gateway/capability";
import {
  DISPATCH_ACCEPTED_LEASE_MS,
  type DispatchPayload,
  type ExecutionCapability,
} from "@stella/contracts/turn-plane/placement";
import { sha256Hex } from "@stella/contracts/turn-plane/pairing-proof";
import {
  type CloudAgentTurnStartRequest,
  type CloudAgentTurnStartResponse,
  type CloudTurnStartRequest,
  type CloudTurnStartResponse,
  TURN_OWNER_GENERATION_HEADER,
  TURN_PLANE_PROTOCOL,
} from "@stella/contracts/turn-plane/turn-start";
import { cloudUnsupportedCapabilities } from "../dispatch-policy.js";
import type {
  OwnerGateAdmitInput,
  OwnerGateAdmissionWithLease,
  OwnerGateFenceLeaseRequest,
  DispatchRow,
} from "./types.js";
import {
  DISPATCH_CLOUD_RETRY_DELAY_MS,
  DISPATCH_CLOUD_MAX_ATTEMPTS,
} from "./constants.js";
import { log } from "./support.js";
import { OwnerGateDispatch } from "./dispatch.js";

/**
 * The cloud branch of a dispatch: starting its cloud chat or cloud agent, and
 * retiring the handoff.
 */
export abstract class OwnerGateCloudDispatch extends OwnerGateDispatch {
  protected cloudPayload(row: DispatchRow): DispatchPayload | null {
    if (!row.payload_json) return null;
    try {
      return JSON.parse(row.payload_json) as DispatchPayload;
    } catch {
      return null;
    }
  }

  /**
   * Start the dispatch in Stella's cloud: a chat turn on the conversation
   * object, an agent attempt on a fresh build session. Both are addressed as
   * Durable Objects — this gate is already inside the service boundary, so
   * the trusted headers are stamped directly rather than routed back through
   * the Worker.
   */
  protected async runCloudBranch(
    row: DispatchRow,
    now: number,
  ): Promise<DispatchRow> {
    if (row.state !== "cloud_committed") return row;
    const required = JSON.parse(
      row.required_capabilities,
    ) as ExecutionCapability[];
    const unsupported = cloudUnsupportedCapabilities(required);
    if (unsupported.length > 0) {
      const failed = await this.patchDispatch(
        row,
        {
          state: "failed",
          payload_json: null,
          payload_expires_at: null,
          lease_expires_at: null,
          error_code: "CLOUD_CAPABILITY_UNAVAILABLE",
          error_message: `The cloud sandbox cannot provide the required device capability: ${unsupported.join(", ")}.`,
        },
        now,
      );
      await this.releaseGate(failed);
      return failed;
    }
    const payload = this.cloudPayload(row);
    if (!payload) {
      const failed = await this.patchDispatch(
        row,
        {
          state: "failed",
          lease_expires_at: null,
          error_code: "CLOUD_PAYLOAD_UNAVAILABLE",
          error_message: "The dispatch payload is no longer available.",
        },
        now,
      );
      await this.releaseGate(failed);
      return failed;
    }
    this.ctx.storage.sql.exec(
      `UPDATE dispatches SET cloud_attempts = cloud_attempts + 1,
                             cloud_retry_at = NULL
        WHERE dispatch_id = ?`,
      row.dispatch_id,
    );
    const attempting = this.dispatchRow(row.dispatch_id) ?? row;
    try {
      return row.kind === "chat"
        ? await this.startCloudChat(attempting, payload, now)
        : await this.startCloudAgent(attempting, payload, now);
    } catch (error) {
      // Do not guess that an ambiguous transport failure means the cloud did
      // not start. The dispatch stays `cloud_committed`; its lease resolves
      // to `reconciliation_required` rather than to a second start.
      log("error", "dispatch_cloud_start_unresolved", {
        dispatchId: row.dispatch_id,
        kind: row.kind,
        message: error instanceof Error ? error.message : String(error),
      });
      return this.dispatchRow(row.dispatch_id) ?? row;
    }
  }

  /**
   * The cloud said no. A fence or shape refusal is the dispatch's own
   * terminal error, reported with the builder's code so the client sees the
   * same reason it would have seen submitting the turn directly. Only a 503
   * — the builder unavailable, not the request refused — is worth one retry.
   */
  protected async cloudRefusal(
    row: DispatchRow,
    response: Response,
    now: number,
  ): Promise<DispatchRow> {
    const body = (await response.json().catch(() => null)) as {
      error?: { code?: unknown; message?: unknown };
    } | null;
    const code =
      typeof body?.error?.code === "string" ? body.error.code : "internal";
    const message =
      typeof body?.error?.message === "string"
        ? body.error.message
        : `The cloud refused this dispatch (${response.status}).`;
    if (
      response.status === 503 &&
      row.cloud_attempts < DISPATCH_CLOUD_MAX_ATTEMPTS
    ) {
      const retrying = await this.patchDispatch(
        row,
        {
          cloud_retry_at: now + DISPATCH_CLOUD_RETRY_DELAY_MS,
          lease_expires_at: now + DISPATCH_ACCEPTED_LEASE_MS,
          error_code: code,
          error_message: message,
        },
        now,
        { notifyExecutor: false },
      );
      await this.scheduleAlarm(now);
      return retrying;
    }
    const failed = await this.patchDispatch(
      row,
      {
        state: "failed",
        payload_json: null,
        payload_expires_at: null,
        lease_expires_at: null,
        error_code: code,
        error_message: message,
      },
      now,
    );
    await this.releaseGate(failed);
    return failed;
  }

  protected async startCloudChat(
    row: DispatchRow,
    payload: DispatchPayload,
    now: number,
  ): Promise<DispatchRow> {
    // The DO name is the authenticated owner identity for this dispatch.
    // Begin only read-only gateway preparation before durable handoff work.
    this.prepareGatewayOwner();
    const sessions = this.env.ORCHESTRATOR_SESSIONS;
    if (!sessions)
      throw new Error("Orchestrator session namespace is not bound.");
    // Start the nonce-only cold wake alongside owner admission and home
    // preparation. It cannot authorize a request or mutate policy state.
    const preparedReader = this.prepareCloudChatReader(
      sessions,
      row.conversation_id,
    );
    const request: CloudTurnStartRequest = {
      protocol: TURN_PLANE_PROTOCOL,
      clientMsgId: row.dispatch_id,
      ...(payload.userMessageEventId
        ? { originUserMessageId: payload.userMessageEventId }
        : {}),
      prompt: payload.prompt,
      lane: "chat",
      source: row.ingress === "schedule" ? "schedule" : "placement",
      ...(payload.locale ? { locale: payload.locale } : {}),
      ...(payload.attachments ? { attachments: payload.attachments } : {}),
      ...(payload.execution ? { execution: payload.execution } : {}),
      ...(payload.handoff || row.ingress === "schedule"
        ? { hiddenMessage: true }
        : {}),
    };
    const handoffKey = cloudChatHandoffKey(row.dispatch_id);
    let handoff = await this.ctx.storage.get<CloudChatHandoff>(handoffKey);
    // Old unresolved dispatches may already have a conversation-created turn.
    // Only a new dispatch starts the owner-created identity protocol.
    if (!handoff && row.cloud_attempts === 1) {
      const allocating: CloudChatHandoff = {
        phase: "allocating",
        turnId: crypto.randomUUID(),
        leaseId: crypto.randomUUID(),
      };
      await this.ctx.storage.transaction(async (txn) => {
        await txn.put(handoffKey, allocating);
        await txn.put(cloudChatTurnKey(allocating.turnId), row.dispatch_id);
      });
      handoff = allocating;
    }
    let preparation: CloudChatPreparation = {};
    if (handoff?.phase === "retired")
      return this.cloudRefusal(
        row,
        turnStartErrorResponse(
          "owner_purged",
          "This cloud admission was retired.",
          false,
        ),
        now,
      );
    if (handoff?.phase === "allocating") {
      const startedAt = performance.now();
      const result = await this.admitWithFenceLease({
        admission: {
          lane: "chat",
          turnId: handoff.turnId,
          conversationId: row.conversation_id,
          expectedGeneration: row.owner_generation,
        },
        lease: {
          leaseId: handoff.leaseId,
          turnId: handoff.turnId,
          ownerGeneration: row.owner_generation,
          sessionId: sessions.idFromName(row.conversation_id).toString(),
          namespace: "orchestrator",
          role: "orchestrator",
        },
        includeHomeContext: true,
      });
      if (!result.admission.ok)
        return this.cloudRefusal(
          row,
          turnStartErrorResponse(
            result.admission.code,
            result.admission.message,
            result.admission.retryable,
            result.admission.retryAfterMs,
          ),
          now,
        );
      this.ctx.storage.sql.exec(
        "UPDATE dispatches SET gate_held = 1 WHERE dispatch_id = ?",
        row.dispatch_id,
      );
      row.gate_held = 1;
      if (result.lease.status !== "registered")
        return this.cloudRefusal(
          row,
          turnStartErrorResponse(
            "owner_purged",
            "This account's cloud admission is unavailable.",
            false,
          ),
          now,
        );
      const authority: AdmittedCloudChat = {
        version: 1,
        ownerId: this.ownerId(),
        ownerGeneration: row.owner_generation,
        conversationId: row.conversation_id,
        clientMsgId: request.clientMsgId,
        turnId: handoff.turnId,
        leaseId: handoff.leaseId,
        fenceGeneration: result.lease.generation,
        admittedAt: Date.now(),
        snapshot: result.admission.snapshot,
        fingerprint: await sha256Hex(
          chatTurnFingerprintSource(
            this.ownerId(),
            row.conversation_id,
            request,
          ),
        ),
      };
      if ("homeContext" in result && result.homeContext) {
        const preparedReaderId = await preparedReader;
        const reader = preparedReaderId
          ? { readerId: preparedReaderId }
          : await this.modelGrants().latestReader(row.conversation_id);
        if (reader) {
          authority.ownerModelGrant = await this.issueModelGrant({
            ownerId: authority.ownerId,
            ownerGeneration: authority.ownerGeneration,
            conversationId: authority.conversationId,
            readerId: reader.readerId,
            turnId: authority.turnId,
            leaseId: authority.leaseId,
            fenceGeneration: authority.fenceGeneration,
            policy: result.homeContext.memory.preference,
            expiresAt: result.lease.expiresAt,
          });
        }
      }
      handoff = { phase: "registered", authority };
      const latest = await this.ctx.storage.get<CloudChatHandoff>(handoffKey);
      if (latest?.phase === "retired") {
        await this.release({ turnId: authority.turnId });
        return this.cloudRefusal(
          row,
          turnStartErrorResponse(
            "owner_purged",
            "This cloud admission was retired.",
            false,
          ),
          now,
        );
      }
      await this.ctx.storage.put(handoffKey, handoff);
      preparation = {
        ...("homeContext" in result ? { homeContext: result.homeContext } : {}),
        ...("destinations" in result
          ? { destinations: result.destinations }
          : {}),
      };
      log("info", "owner_chat_admission_timing", {
        dispatchId: row.dispatch_id,
        turnId: authority.turnId,
        totalMs: Math.round(performance.now() - startedAt),
      });
    }
    if (handoff?.phase === "registered") {
      const current = this.dispatchRow(row.dispatch_id);
      if (!current || current.state !== "cloud_committed") {
        await this.retireCloudChatHandoff(handoff.authority);
        await this.releaseGate(this.dispatchRow(row.dispatch_id) ?? row);
        return this.dispatchRow(row.dispatch_id) ?? row;
      }
      // Stop can target the exact turn even while its admission RPC is in
      // flight, including before the conversation has imported the handoff.
      this.ctx.storage.sql.exec(
        "UPDATE dispatches SET cloud_turn_id = ? WHERE dispatch_id = ?",
        handoff.authority.turnId,
        row.dispatch_id,
      );
    }
    const response =
      handoff?.phase === "registered"
        ? await sessions
            .getByName(row.conversation_id)
            .startAdmittedChat(request, handoff.authority, preparation)
        : await sessions
            .getByName(row.conversation_id)
            .fetch("https://orchestrator-session/turn", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-stella-owner": this.ownerId(),
                [HEADER_TURN_AUTH_KIND]: "service",
                "x-stella-conversation-id": row.conversation_id,
                [TURN_OWNER_GENERATION_HEADER]: row.owner_generation,
              },
              body: JSON.stringify(request),
            });
    if (!response.ok) {
      // A definite refusal cannot own an executing turn. An uncertain 5xx
      // keeps the same registered identity for retry or purge reconciliation.
      if (
        handoff?.phase === "registered" &&
        response.status >= 400 &&
        response.status < 500
      ) {
        await this.retireCloudChatHandoff(handoff.authority);
      }
      return await this.cloudRefusal(row, response, now);
    }
    const started = (await response.json()) as CloudTurnStartResponse;
    if (
      handoff?.phase === "registered" &&
      started.turnId !== handoff.authority.turnId
    )
      throw new Error("Cloud admission response identity changed.");
    const current = this.dispatchRow(row.dispatch_id);
    if (current && current.state !== "cloud_committed") return current;
    return await this.patchDispatch(
      row,
      {
        state: "cloud_running",
        placement: "cloud",
        cloud_turn_id: started.turnId,
        cloud_retry_at: null,
        error_code: null,
        error_message: null,
        payload_json: null,
        payload_expires_at: null,
        lease_expires_at: null,
        started_at: now,
      },
      now,
    );
  }

  protected async retireCloudChatHandoff(a: AdmittedCloudChat): Promise<void> {
    const sessions = this.env.ORCHESTRATOR_SESSIONS;
    if (!sessions) throw new Error("Orchestrator sessions unavailable.");
    const retired = await this.ownerFenceCall("unregister", {
      ownerId: a.ownerId,
      ownerGeneration: a.ownerGeneration,
      leaseId: a.leaseId,
      turnId: a.turnId,
      sessionId: sessions.idFromName(a.conversationId).toString(),
      generation: a.fenceGeneration,
    });
    if (!retired.ok) throw new Error("Cloud admission retirement is pending.");
    await this.modelGrants().retireExactTurnLease({
      ownerGeneration: a.ownerGeneration,
      conversationId: a.conversationId,
      turnId: a.turnId,
      leaseId: a.leaseId,
    });
    await this.ctx.storage.put(cloudChatHandoffKey(a.clientMsgId), {
      phase: "retired",
      turnId: a.turnId,
      leaseId: a.leaseId,
    } satisfies CloudChatHandoff);
  }

  protected async startCloudAgent(
    row: DispatchRow,
    payload: DispatchPayload,
    now: number,
  ): Promise<DispatchRow> {
    const sessions = this.env.BUILD_SESSIONS;
    if (!sessions) throw new Error("Build session namespace is not bound.");
    const snapshot = await this.snapshot({ now });
    // A fresh thread per placed agent: the gate cannot read a durable
    // thread's attempt generation, and guessing one would resume the wrong
    // attempt.
    const threadId = `thr-${crypto.randomUUID().slice(0, 18)}`;
    const request: CloudAgentTurnStartRequest = {
      protocol: TURN_PLANE_PROTOCOL,
      kind: "agent",
      ownerId: this.ownerId(),
      ownerGeneration: row.owner_generation,
      conversationId: row.conversation_id,
      threadId,
      agentDepth: 1,
      attemptGeneration: 1,
      // The session adopts the dispatch id as its turn id, so the release it
      // sends on the terminal path frees exactly the slot this gate admitted.
      turnId: row.dispatch_id,
      prompt: payload.prompt,
      description: payload.description ?? "Placed agent run",
      execution: payload.execution ?? snapshot.execution,
      audience: snapshot.allowance.audience,
      budgetMicroCents: snapshot.allowance.budgetMicroCents,
      source: "placement",
      clientMsgId: row.dispatch_id,
      ...(row.parent_turn_id ? { parentTurnId: row.parent_turn_id } : {}),
    };
    if (runsAsPiAgent(request.execution)) {
      return await this.startPiPlacedAgent(
        row,
        {
          ...request,
          execution: request.execution,
        },
        now,
      );
    }
    const response = await sessions
      .getByName(threadId)
      .fetch("https://build-session/turn", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // The gate admitted this attempt already and owns its release.
          [HEADER_GATE_ADMITTED]: "1",
        },
        body: JSON.stringify(request),
      });
    if (!response.ok) return await this.cloudRefusal(row, response, now);
    const started = (await response.json()) as CloudAgentTurnStartResponse;
    return await this.patchDispatch(
      row,
      {
        state: "cloud_running",
        placement: "cloud",
        cloud_turn_id: started.turnId ?? row.dispatch_id,
        cloud_retry_at: null,
        error_code: null,
        error_message: null,
        cloud_thread_id: started.threadId ?? threadId,
        payload_json: null,
        payload_expires_at: null,
        lease_expires_at: null,
        started_at: now,
      },
      now,
    );
  }

  /**
   * A placed agent on pi (Stella's models or the owner's ChatGPT plan) runs
   * in its conversation as a pi agent, started at once; pi admits each of
   * its runs itself, so this dispatch's own hold goes back once the
   * conversation has it. Its report settles the dispatch by its id, as a
   * BuildSession agent's terminal does.
   */
  protected async startPiPlacedAgent(
    row: DispatchRow,
    request: CloudAgentTurnStartRequest & { execution: PiAgentExecution },
    now: number,
  ): Promise<DispatchRow> {
    const sessions = this.env.ORCHESTRATOR_SESSIONS;
    if (!sessions) throw new Error("Orchestrator sessions unavailable.");
    await sessions.getByName(row.conversation_id).startPiThread({
      ownerId: request.ownerId,
      ownerGeneration: request.ownerGeneration,
      conversationId: row.conversation_id,
      audience: request.audience as ManagedModelAudience,
      budgetMicroCents: request.budgetMicroCents,
      execution: request.execution,
      prompt: request.prompt,
      attempt: {
        threadId: request.threadId,
        description: request.description,
        turnId: row.dispatch_id,
        attemptGeneration: 1,
      },
    });
    await this.releaseGate(row);
    return await this.patchDispatch(
      row,
      {
        state: "cloud_running",
        placement: "cloud",
        cloud_turn_id: row.dispatch_id,
        cloud_retry_at: null,
        error_code: null,
        error_message: null,
        cloud_thread_id: request.threadId,
        payload_json: null,
        payload_expires_at: null,
        lease_expires_at: null,
        started_at: now,
      },
      now,
    );
  }

  // ── Submit, status, cancel ────────────────────────────────────────────

  // Implemented by `OwnerGate`.
  abstract admitWithFenceLease(input: {
    admission: OwnerGateAdmitInput;
    lease: OwnerGateFenceLeaseRequest;
    includeHomeContext?: boolean;
  }): Promise<OwnerGateAdmissionWithLease>;
}
