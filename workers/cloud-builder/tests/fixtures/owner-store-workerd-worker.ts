/**
 * The real `OwnerGate` serving a test domain inside workerd, so live sockets,
 * hibernation tags and alarm-driven jobs run on the actual runtime rather
 * than the bun fakes. Identity is stamped here the way the production Worker
 * stamps it after verifying a JWT.
 */
import { OwnerGate } from "../../src/owner-gate.js";
import { number, object, string } from "../../src/owner-store/args.js";
import { accountDomain } from "../../src/owner-store/domains/account.js";
import {
  createOwnerRegistry,
  type OwnerCaller,
  type OwnerDomain,
} from "../../src/owner-store/registry.js";

const notes = {
  name: "notes",
  migrations: [
    {
      id: "notes.1-init",
      statements: ["CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT NOT NULL)"],
    },
  ],
  calls: {
    "notes.add": {
      scope: "owner",
      parse: object({ id: string(), body: string() }),
      handler: (ctx: any, args: { id: string; body: string }) => {
        ctx.db.run("INSERT INTO notes (id, body) VALUES (?, ?)", args.id, args.body);
        return { id: args.id };
      },
    },
    "notes.later": {
      scope: "owner",
      parse: object({ delayMs: number({ min: 0 }), id: string() }),
      handler: (ctx: any, args: { delayMs: number; id: string }) => {
        ctx.jobs.schedule("notes.remind", ctx.now + args.delayMs, { id: args.id });
        return null;
      },
    },
  },
  views: {
    "notes.list": {
      parse: object({}),
      read: (ctx: any) => ctx.db.all("SELECT id, body FROM notes ORDER BY id"),
    },
  },
  jobs: {
    "notes.remind": {
      run: (ctx: any, payload: { id: string }) => {
        ctx.db.run("INSERT INTO notes (id, body) VALUES (?, 'from job')", `job-${payload.id}`);
      },
    },
  },
} as unknown as OwnerDomain;

// The gate reads the account domain's owner state on every call.
const registry = createOwnerRegistry([accountDomain, notes]);

export class StoreTestOwnerGate extends OwnerGate {
  protected override backendRegistry() {
    return registry;
  }
}

type Env = { OWNER_GATES: DurableObjectNamespace<StoreTestOwnerGate> };

const callerFor = (ownerId: string): OwnerCaller => ({
  ownerId,
  subject: ownerId,
  sessionId: "session",
  isAnonymous: false,
  expiresAtMs: Date.now() + 30 * 60_000,
});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/") return new Response("ok");
    const ownerId = url.searchParams.get("owner") ?? "owner-1";
    const gate = env.OWNER_GATES.getByName(ownerId);
    if (url.pathname === "/rpc" && request.method === "POST") {
      const body = (await request.json()) as { name: string; args: unknown };
      return Response.json(
        await gate.ownerRpc({ name: body.name, args: body.args, caller: callerFor(ownerId) }),
      );
    }
    if (url.pathname === "/live") {
      const caller = callerFor(ownerId);
      const forwarded = new Request("https://owner-gate.internal/live", request);
      forwarded.headers.set("x-stella-owner", caller.ownerId);
      forwarded.headers.set("x-stella-subject", caller.subject);
      forwarded.headers.set("x-stella-session", caller.sessionId);
      forwarded.headers.set("x-stella-token-exp", String(caller.expiresAtMs));
      forwarded.headers.set("x-stella-anonymous", "0");
      return await gate.fetch(forwarded);
    }
    return new Response("not found", { status: 404 });
  },
};
