import { DurableObject } from "cloudflare:workers";
import type { OwnerSnapshot } from "@stella/contracts/turn-plane/owner-snapshot";
import { OrchestratorSession } from "../../src/index.js";
import {
  HEADER_ISSUER,
  HEADER_OWNER,
  HEADER_SESSION,
  HEADER_SUBJECT,
  HEADER_TOKEN_EXP,
  stripStellaHeaders,
  SUBPROTOCOL,
} from "../../src/conversation-hub.js";
import { HEADER_CONVERSATION_ID } from "../../src/build-session/shared/keys.js";
import type { OwnerModelGrantFreezeRequest } from "../../src/owner-model-grants.js";

export { OrchestratorSession };

type ReaderRegistration = {
  ownerId: string;
  ownerGeneration: string;
  conversationId: string;
  readerId: string;
};

type Env = {
  ORCHESTRATOR_SESSIONS: DurableObjectNamespace<OrchestratorSession>;
  OWNER_GATES: DurableObjectNamespace<OwnerReaderRegistry>;
};

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const conversationStub = (
  env: Env,
  conversationId: string,
): DurableObjectStub<OrchestratorSession> =>
  env.ORCHESTRATOR_SESSIONS.getByName(conversationId);

export class OwnerReaderRegistry extends DurableObject<Env> {
  async snapshot(): Promise<OwnerSnapshot> {
    const ownerId = this.ctx.id.name ?? "owner-1";
    return {
      v: 1,
      ownerId,
      ownerGeneration: "generation-1",
      writable: true,
      isAnonymous: false,
      identityLevel: 3,
      plan: "pro",
      allowance: { audience: "pro", budgetMicroCents: 1_000_000 },
      execution: { engine: "stella", target: "cloud" },
      fetchedAt: Date.now(),
      ttlMs: 60_000,
    };
  }

  async registerConversationReader(
    registration: ReaderRegistration,
  ): Promise<void> {
    const rows =
      (await this.ctx.storage.get<ReaderRegistration[]>("registrations")) ?? [];
    rows.push(registration);
    await this.ctx.storage.put("registrations", rows);
  }

  async fetch(): Promise<Response> {
    const rows =
      (await this.ctx.storage.get<ReaderRegistration[]>("registrations")) ?? [];
    return json({ registrations: rows });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const [, route, rawConversationId] = url.pathname.split("/");
    const conversationId = decodeURIComponent(
      rawConversationId ?? "wrapper-conversation",
    );

    if (url.pathname === "/") return json({ ok: true });

    if (route === "reader") {
      const readerId = await conversationStub(
        env,
        conversationId,
      ).prepareCloudChatReader();
      return json({ readerId });
    }

    if (route === "registrations") {
      return await env.OWNER_GATES.getByName("owner-1").fetch(
        "https://owner-gate/registrations",
      );
    }

    if (route === "snapshot") {
      return json(await env.OWNER_GATES.getByName("owner-1").snapshot());
    }

    if (route === "freeze") {
      const now = Date.now();
      const requestBody = {
        ownerId: "owner-1",
        ownerGeneration: "generation-1",
        conversationId,
        readerId: "reader-missing",
        reason: "policy_change",
        grants: [{ grantId: "grant-missing", expiresAt: now + 30_000 }],
      } satisfies OwnerModelGrantFreezeRequest;
      return json(
        await conversationStub(env, conversationId).freezeOwnerModelGrants(
          requestBody,
        ),
      );
    }

    if (route === "cancel") {
      const response = await conversationStub(env, conversationId).fetch(
        "https://orchestrator-session/cancel",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      );
      return response;
    }

    if (route === "socket") {
      const target = new URL("https://orchestrator-session/socket");
      target.search = url.search;
      const forwarded = new Request(target.toString(), request);
      stripStellaHeaders(forwarded.headers);
      forwarded.headers.set(HEADER_OWNER, "owner-1");
      forwarded.headers.set(HEADER_SUBJECT, "subject-1");
      forwarded.headers.set(HEADER_SESSION, "session-1");
      forwarded.headers.set(HEADER_TOKEN_EXP, String(Date.now() + 60_000));
      forwarded.headers.set(HEADER_ISSUER, "fixture");
      forwarded.headers.set(HEADER_CONVERSATION_ID, conversationId);
      if (forwarded.headers.has("sec-websocket-protocol")) {
        forwarded.headers.set("sec-websocket-protocol", SUBPROTOCOL);
      }
      forwarded.headers.delete("authorization");
      return await conversationStub(env, conversationId).fetch(forwarded);
    }

    return json({ error: "not_found" }, 404);
  },
};
