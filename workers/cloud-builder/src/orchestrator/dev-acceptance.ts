import { sha256Hex } from "../hash.js";
import {
  authorizeDevAcceptanceProbe,
  DEV_ACCEPTANCE_PROBE_STATE_KEY,
  DEV_ACCEPTANCE_PROVIDER_DISPATCH_COUNT_KEY,
  devAcceptanceProbesEnabled,
  type DevAcceptanceProbeState,
  recordDevAcceptanceProbeReceipt,
} from "../dev-acceptance-probes.js";
import { CANONICAL_PROMPTS, type CanonicalPrompts } from "../cloud-prompt.js";
import { BACKFILL_BATCH_RECORDS } from "../conversation-types.js";
import type { ChatTurnRequest } from "./types.js";
import {
  json,
  log,
  CloudContextBlockedError,
  cloudContextFailure,
} from "./support.js";
import { OrchestratorConversationEdit } from "./conversation-edit.js";

/**
 * Dev acceptance probes and the canonical prompt/journal checks behind them.
 */
export abstract class OrchestratorDevAcceptance extends OrchestratorConversationEdit {
  protected async devAcceptanceProbeSnapshot(
    operation: "status" | "self_abort" | "arm_fault",
    replayed: boolean,
    receiptSha256: string,
  ): Promise<Record<string, unknown>> {
    const state = await this.ctx.storage.get<DevAcceptanceProbeState>(
      DEV_ACCEPTANCE_PROBE_STATE_KEY,
    );
    const historyFault = this.journal.acceptanceContextFaultStatus();
    return {
      version: 1,
      operation,
      replayed,
      bootIdSha256: await sha256Hex(this.devAcceptanceBootId),
      durableObjectIdSha256: await sha256Hex(this.ctx.id.toString()),
      providerDispatchCount:
        (await this.ctx.storage.get<number>(
          DEV_ACCEPTANCE_PROVIDER_DISPATCH_COUNT_KEY,
        )) ?? 0,
      receiptSha256,
      fault: state?.promptFaultArmed
        ? { kind: "canonical_prompt", armed: true }
        : historyFault
          ? {
              kind: "canonical_history",
              armed: true,
              corruptSeq: historyFault.seq,
              originalPayloadSha256: historyFault.original_payload_sha256,
              corruptPayloadSha256: historyFault.corrupt_payload_sha256,
              observedFailures: historyFault.observed_failures,
              repairAfterFailures: historyFault.repair_after_failures,
            }
          : null,
    };
  }

  /**
   * Strict dev-only product-proof control. The public Worker has already
   * checked the service secret, and the DO checks it again along with the
   * deployment, owner generation, and exact disposable conversation marker.
   */
  protected async handleDevAcceptanceProbe(
    request: Request,
  ): Promise<Response> {
    const body = await request.json().catch(() => null);
    const authorization = await authorizeDevAcceptanceProbe({
      env: this.env,
      suppliedServiceSecret: request.headers.get(
        "x-stella-acceptance-service-secret",
      ),
      body,
      meta: {
        ownerId: this.journal.ownerId(),
        ownerGeneration: this.ownerGeneration,
        conversationId: this.conversationId(),
        title: this.journal.meta().title,
      },
    });
    if (!authorization.ok) {
      return json({ error: "Not found." }, authorization.status);
    }
    const current = await this.ctx.storage.get<DevAcceptanceProbeState>(
      DEV_ACCEPTANCE_PROBE_STATE_KEY,
    );
    const receipt = recordDevAcceptanceProbeReceipt({
      current,
      authorization,
      now: Date.now(),
    });
    if (receipt.status === "conflict") {
      return json(
        {
          code: "acceptance_probe_conflict",
          message: "Acceptance probe identity conflicts with durable state.",
        },
        409,
      );
    }
    const replayed = receipt.status === "replayed";
    if (!replayed && authorization.request.operation === "arm_fault") {
      const fault = authorization.request.fault;
      if (!fault) return json({ error: "Not found." }, 404);
      if (receipt.state.usedFaults?.includes(fault)) {
        return json(
          {
            code: "acceptance_probe_consumed",
            message: "This one-shot acceptance fault was already used.",
          },
          409,
        );
      }
      if (authorization.request.fault === "canonical_prompt") {
        if (
          receipt.state.promptFaultArmed ||
          this.journal.acceptanceContextFaultStatus()
        ) {
          return json(
            {
              code: "acceptance_probe_busy",
              message: "A bounded acceptance fault is already armed.",
            },
            409,
          );
        }
        receipt.state.promptFaultArmed = true;
      } else {
        if (receipt.state.promptFaultArmed) {
          return json(
            {
              code: "acceptance_probe_busy",
              message: "A bounded acceptance fault is already armed.",
            },
            409,
          );
        }
        const existing = this.journal.acceptanceContextFaultStatus();
        if (existing) {
          if (existing.run_id_sha256 !== authorization.runIdSha256) {
            return json(
              {
                code: "acceptance_probe_busy",
                message: "A bounded acceptance fault is already armed.",
              },
              409,
            );
          }
        } else {
          const candidate = this.journal.acceptanceContextFaultCandidate();
          if (!candidate) {
            return json(
              {
                code: "acceptance_probe_unavailable",
                message: "No eligible canonical context row is available.",
              },
              409,
            );
          }
          this.journal.armAcceptanceContextFault({
            runIdSha256: authorization.runIdSha256,
            seq: candidate.seq,
            expectedPayloadJson: candidate.payloadJson,
            originalPayloadSha256: await sha256Hex(candidate.payloadJson),
            corruptPayloadSha256: await sha256Hex(
              '{"stellaAcceptanceContextFault":',
            ),
            createdAt: Date.now(),
          });
        }
      }
      receipt.state.usedFaults = [...(receipt.state.usedFaults ?? []), fault];
    }
    await this.ctx.storage.put(DEV_ACCEPTANCE_PROBE_STATE_KEY, receipt.state);
    log("info", "dev_acceptance_probe", {
      operation: authorization.request.operation,
      requestIdSha256: authorization.requestIdSha256,
      runIdSha256: authorization.runIdSha256,
      ownerIdSha256: authorization.ownerIdSha256,
      conversationIdSha256: authorization.conversationIdSha256,
      replayed,
    });
    const snapshot = await this.devAcceptanceProbeSnapshot(
      authorization.request.operation,
      replayed,
      authorization.fingerprintSha256,
    );
    if (!replayed && authorization.request.operation === "self_abort") {
      // Give the 202 response a chance to leave the isolate, then force a real
      // DO restart. The durable receipt makes a retried request a no-op.
      this.ctx.waitUntil(
        scheduler.wait(50).then(() => {
          this.ctx.abort("controlled dev acceptance restart");
        }),
      );
      return json({ ...snapshot, selfAbortScheduled: true }, 202);
    }
    return json(snapshot);
  }

  protected async noteDevAcceptanceProviderDispatch(): Promise<void> {
    if (!devAcceptanceProbesEnabled(this.env)) return;
    const state = await this.ctx.storage.get<DevAcceptanceProbeState>(
      DEV_ACCEPTANCE_PROBE_STATE_KEY,
    );
    if (!state) return;
    const current =
      (await this.ctx.storage.get<number>(
        DEV_ACCEPTANCE_PROVIDER_DISPATCH_COUNT_KEY,
      )) ?? 0;
    await this.ctx.storage.put(
      DEV_ACCEPTANCE_PROVIDER_DISPATCH_COUNT_KEY,
      current + 1,
    );
  }

  protected async loadCanonicalPromptsForTurn(
    signal?: AbortSignal,
  ): Promise<CanonicalPrompts> {
    signal?.throwIfAborted();
    if (devAcceptanceProbesEnabled(this.env)) {
      const state = await this.ctx.storage.get<DevAcceptanceProbeState>(
        DEV_ACCEPTANCE_PROBE_STATE_KEY,
      );
      signal?.throwIfAborted();
      if (state?.promptFaultArmed) {
        state.promptFaultArmed = false;
        signal?.throwIfAborted();
        await this.ctx.storage.put(DEV_ACCEPTANCE_PROBE_STATE_KEY, state);
        signal?.throwIfAborted();
        log("info", "dev_acceptance_fault_consumed", {
          kind: "canonical_prompt",
          runIdSha256: state.runIdSha256,
        });
        throw new CloudContextBlockedError(
          "canonical_prompt",
          "dev_acceptance_fault",
        );
      }
    }
    return CANONICAL_PROMPTS;
  }

  protected async observeDevAcceptanceContextFailure(
    contextFailure: ReturnType<typeof cloudContextFailure>,
  ): Promise<void> {
    if (
      contextFailure?.component !== "canonical_history" ||
      !devAcceptanceProbesEnabled(this.env)
    ) {
      return;
    }
    const state = await this.ctx.storage.get<DevAcceptanceProbeState>(
      DEV_ACCEPTANCE_PROBE_STATE_KEY,
    );
    if (!state) return;
    const observation = this.journal.observeAcceptanceContextFault(
      state.runIdSha256,
    );
    if (!observation) return;
    log("info", "dev_acceptance_context_fault_observed", {
      runIdSha256: state.runIdSha256,
      corruptSeq: observation.seq,
      observedFailures: observation.observedFailures,
      repaired: observation.repaired,
      originalPayloadSha256: observation.originalPayloadSha256,
      corruptPayloadSha256: observation.corruptPayloadSha256,
    });
  }

  /**
   * The journal probe reads the canonical journal exactly the way a client
   * does, including through R2 segments.
   */
  protected async handleJournalProbe(url: URL): Promise<Response> {
    const requested = Number(url.searchParams.get("limit") ?? "50");
    const limit = Math.min(
      Number.isFinite(requested) && requested > 0 ? requested : 50,
      BACKFILL_BATCH_RECORDS,
    );
    const head = this.journal.head(this.live ? "running" : "idle");
    const beforeSeq = url.searchParams.get("beforeSeq");
    const to =
      beforeSeq !== null && Number.isFinite(Number(beforeSeq))
        ? Number(beforeSeq) - 1
        : head.headSeq;
    const from = Math.max(0, to - limit + 1);
    const range = await this.archive.readRange(from, to, limit);
    const meta = this.journal.meta();
    // The wake state, so the invariant "an accepted turn always has a pending
    // alarm" is observable rather than merely asserted: `queued` non-empty with
    // `alarmAt` null is a stranded turn, and there is no other way to see it
    // from outside the object.
    const queued = await this.ctx.storage.list<ChatTurnRequest>({
      prefix: "queued:",
    });
    return json({
      head,
      alarmAt: await this.ctx.storage.getAlarm(),
      queued: [...queued.values()].map((entry) => entry.turnId),
      sealed: this.purged(),
      indexSyncedSeq: meta.index_synced_seq,
      hot: this.journal.hotStats(),
      inbox: this.journal.inboxSize(),
      databaseBytes: this.journal.databaseSize(),
      storedBytes: this.journal.storedBytes(),
      spillObjects: this.journal.allSpillKeys().length,
      purgePending: this.journal.purgePending(),
      complete: range.complete,
      records: range.records,
    });
  }
}
