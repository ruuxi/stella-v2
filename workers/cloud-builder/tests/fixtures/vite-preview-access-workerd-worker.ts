import { DurableObject } from "cloudflare:workers";
import {
  PREVIEW_ACCESS_STORAGE_KEY,
  issuePreviewAccessCapability,
  previewAccessLogFields,
  resolvePreviewTunnelRequest,
  verifyPreviewAccessCapability,
  type PreviewAccessActiveRecord,
} from "../../src/vite-preview-access.js";

type FixtureEnv = {
  PREVIEW_PROOF: DurableObjectNamespace<PreviewAccessProof>;
};

const identity = {
  buildSessionName: "workerd-proof-session",
  turnId: "workerd-proof-turn",
  sandboxId: "workerd-proof-sandbox",
};
const secret = "fixture-only-preview-secret-with-thirty-two-bytes";
const sensitiveTunnelUrl = "https://must-not-leak-preview.trycloudflare.com/";

export class PreviewAccessProof extends DurableObject<FixtureEnv> {
  async issue(): Promise<{
    capability: string;
    logFields: ReturnType<typeof previewAccessLogFields>;
  }> {
    const issued = await issuePreviewAccessCapability({
      identity,
      tunnelUrl: sensitiveTunnelUrl,
      secret,
      now: Date.now(),
      ttlMs: 5 * 60_000,
    });
    await this.ctx.storage.put(PREVIEW_ACCESS_STORAGE_KEY, issued.activeRecord);
    return {
      capability: issued.capability,
      logFields: previewAccessLogFields(issued.activeRecord),
    };
  }

  async verify(capability: string): Promise<{
    ok: boolean;
    code?: string;
    targetMatched?: boolean;
  }> {
    const active = await this.ctx.storage.get<PreviewAccessActiveRecord>(
      PREVIEW_ACCESS_STORAGE_KEY,
    );
    const result = await verifyPreviewAccessCapability({
      capability,
      secret,
      expected: identity,
      activeRecord: active,
      now: Date.now(),
    });
    return result.ok
      ? { ok: true, targetMatched: result.tunnelUrl === sensitiveTunnelUrl }
      : result;
  }

  async snapshot(): Promise<ReturnType<typeof previewAccessLogFields> | null> {
    const active = await this.ctx.storage.get<PreviewAccessActiveRecord>(
      PREVIEW_ACCESS_STORAGE_KEY,
    );
    return active ? previewAccessLogFields(active) : null;
  }

  async revoke(): Promise<void> {
    await this.ctx.storage.delete(PREVIEW_ACCESS_STORAGE_KEY);
  }
}

const bodyCapability = async (request: Request): Promise<string> => {
  const body = (await request.json().catch(() => null)) as {
    capability?: unknown;
  } | null;
  return typeof body?.capability === "string" ? body.capability : "";
};

const bodyPath = async (request: Request): Promise<string> => {
  const body = (await request.json().catch(() => null)) as {
    path?: unknown;
  } | null;
  return typeof body?.path === "string" ? body.path : "";
};

export default {
  async fetch(request: Request, env: FixtureEnv): Promise<Response> {
    const proof = env.PREVIEW_PROOF.getByName("vite-preview-proof");
    const { pathname } = new URL(request.url);
    if (request.method === "POST" && pathname === "/issue") {
      return Response.json(await proof.issue());
    }
    if (request.method === "POST" && pathname === "/verify") {
      return Response.json(await proof.verify(await bodyCapability(request)));
    }
    if (request.method === "GET" && pathname === "/snapshot") {
      return Response.json(await proof.snapshot());
    }
    if (request.method === "DELETE" && pathname === "/revoke") {
      await proof.revoke();
      return new Response(null, { status: 204 });
    }
    if (request.method === "POST" && pathname === "/resolve") {
      const target = resolvePreviewTunnelRequest({
        tunnelUrl: sensitiveTunnelUrl,
        proxyPathname: await bodyPath(request),
      });
      return Response.json(
        target
          ? {
              ok: true,
              originMatched:
                target.origin === new URL(sensitiveTunnelUrl).origin,
            }
          : { ok: false },
      );
    }
    if (request.method === "GET" && pathname.startsWith("/resolve-path")) {
      const target = resolvePreviewTunnelRequest({
        tunnelUrl: sensitiveTunnelUrl,
        proxyPathname: `/vite-preview${pathname.slice("/resolve-path".length)}`,
      });
      return Response.json(
        target
          ? {
              ok: true,
              originMatched:
                target.origin === new URL(sensitiveTunnelUrl).origin,
            }
          : { ok: false },
      );
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  },
} satisfies ExportedHandler<FixtureEnv>;
