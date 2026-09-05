import { DurableObject } from "cloudflare:workers";
import type { CloudTurnStartRequest } from "@stella/contracts/turn-plane/turn-start";
import type {
  AdmittedCloudChat,
  CloudChatPreparation,
} from "./cloud-chat-admission.js";
import type { OwnerModelGrantFreezeRequest } from "./owner-model-grants.js";
import type { Env } from "./build-session/shared/env.js";

/**
 * Thin Durable Object shell for conversation sessions. The shell is what the
 * Worker and OwnerGate import on cold entry; the conversation implementation,
 * Agent runtime, tool definitions, and socket hub load only when this DO is
 * actually addressed.
 */
export class OrchestratorSession extends DurableObject<Env> {
  private implementation?: Promise<
    import("./orchestrator-session-object.js").OrchestratorSessionObject
  >;

  private loadImplementation(): Promise<
    import("./orchestrator-session-object.js").OrchestratorSessionObject
  > {
    if (!this.implementation) {
      this.implementation = import("./orchestrator-session-object.js")
        .then(async ({ OrchestratorSessionObject }) => {
          const implementation = new OrchestratorSessionObject(
            this.ctx,
            this.env,
          );
          await implementation.ready();
          return implementation;
        })
        .catch((error: unknown) => {
          this.implementation = undefined;
          throw error;
        });
    }
    return this.implementation;
  }

  async fetch(request: Request): Promise<Response> {
    return await (await this.loadImplementation()).fetch(request);
  }

  async alarm(): Promise<void> {
    await (await this.loadImplementation()).alarm();
  }

  async prepareCloudChatReader(): Promise<string> {
    return await (await this.loadImplementation()).prepareCloudChatReader();
  }

  async startAdmittedChat(
    start: CloudTurnStartRequest,
    authority: AdmittedCloudChat,
    preparation: CloudChatPreparation,
  ): Promise<Response> {
    return await (
      await this.loadImplementation()
    ).startAdmittedChat(start, authority, preparation);
  }

  async freezeOwnerModelGrants(
    args: OwnerModelGrantFreezeRequest,
  ): Promise<{ frozen: true }> {
    return await (await this.loadImplementation()).freezeOwnerModelGrants(args);
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    await (await this.loadImplementation()).webSocketMessage(ws, message);
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> {
    await (
      await this.loadImplementation()
    ).webSocketClose(ws, code, reason, wasClean);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    await (await this.loadImplementation()).webSocketError(ws, error);
  }
}
