import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const serviceAuthorized = (request: Request): boolean => {
  const secret = process.env.BUILDER_SERVICE_SECRET?.trim();
  return Boolean(
    secret && request.headers.get("authorization") === `Bearer ${secret}`,
  );
};

export function registerCloudAppRoutes(http: HttpRouter) {
  http.route({
    path: "/api/cloud/events",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      if (!serviceAuthorized(request)) return json({ error: "Unauthorized" }, 401);
      const body = (await request.json()) as {
        turnId: string;
        sessionId: string;
        seq: number;
        kind: string;
        payload: unknown;
        terminal?: boolean;
      };
      const result = await ctx.runMutation(
        internal.cloud_apps.appendEventInternal,
        {
          turnId: body.turnId,
          sessionId: body.sessionId,
          seq: body.seq,
          kind: body.kind,
          payloadJson: JSON.stringify(body.payload ?? {}),
          terminal: body.terminal === true,
          now: Date.now(),
        },
      );
      return json(result);
    }),
  });

  http.route({
    path: "/api/cloud/builds",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      if (!serviceAuthorized(request)) return json({ error: "Unauthorized" }, 401);
      const body = (await request.json()) as {
        buildId: string;
        appId: string;
        ownerId: string;
        artifactPrefix: string;
        previewUrl: string;
        metrics: unknown;
        slug: string;
        autoActivate: boolean;
        title?: string;
      };
      await ctx.runMutation(internal.cloud_apps.recordBuildInternal, {
        buildId: body.buildId,
        appId: body.appId,
        ownerId: body.ownerId,
        artifactPrefix: body.artifactPrefix,
        previewUrl: body.previewUrl,
        metricsJson: JSON.stringify(body.metrics),
        slug: body.slug,
        autoActivate: body.autoActivate,
        title: typeof body.title === "string" ? body.title : undefined,
        now: Date.now(),
      });
      return json({ ok: true });
    }),
  });

  http.route({
    path: "/api/cloud/model",
    method: "POST",
    handler: httpAction(async (_ctx, request) => {
      if (!serviceAuthorized(request)) return json({ error: "Unauthorized" }, 401);
      const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
      if (!apiKey) return json({ error: "Anthropic relay is not configured" }, 503);
      const body = (await request.json()) as { prompt?: string };
      const startedAt = Date.now();
      const upstream = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 900,
          system:
            "You are Stella's cloud app art director. Return only JSON with keys title, eyebrow, headline, subhead, accent, accentSoft, habits (array of exactly four objects with name, detail, progress number 0-100), and focus. No markdown.",
          messages: [{ role: "user", content: body.prompt ?? "" }],
        }),
      });
      const payload = (await upstream.json()) as {
        content?: Array<{ type?: string; text?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number };
        model?: string;
        error?: { message?: string };
      };
      if (!upstream.ok) {
        return json({ error: payload.error?.message ?? "Provider request failed" }, upstream.status);
      }
      const text = payload.content?.find((item) => item.type === "text")?.text ?? "";
      const parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, ""));
      const inputTokens = payload.usage?.input_tokens ?? 0;
      const outputTokens = payload.usage?.output_tokens ?? 0;
      return json({
        spec: parsed,
        usage: {
          model: payload.model ?? "claude-haiku-4-5-20251001",
          inputTokens,
          outputTokens,
          estimatedCostUsd: inputTokens / 1_000_000 + (outputTokens * 5) / 1_000_000,
          durationMs: Date.now() - startedAt,
        },
      });
    }),
  });
}
