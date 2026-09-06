/**
 * The cloud orchestrator's side of an inline connect card: create the
 * pending request the clients render, poll it while the `connector_status`
 * tool call is held open, and cancel it when the turn gives up. Authorized
 * by the turn capability; the row is scoped to that turn's owner.
 */
import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { authorizeControlPlaneRequest } from "../lib/capability_verify";
import {
  checkIntegrationConnected,
  type ConnectRequestSummary,
} from "../cloud_connector_connect";

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const readString = (value: unknown, max = 1_000): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
};

export const registerCloudConnectorConnectRoutes = (http: HttpRouter) => {
  http.route({
    path: "/api/cloud/connector-connect",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const auth = await authorizeControlPlaneRequest(ctx, request);
      if (!auth.ok) return auth.response;
      const { ownerId, ownerGeneration, turnId } = auth.authority;
      if (auth.authority.claims.audience === "anonymous") {
        return json({ error: "sign_in_required" }, 403);
      }
      const body = (await request.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const action = readString(body.action, 20) ?? "poll";
      const now = Date.now();
      // A turn capability speaks only for its own turn.
      const bodyTurnId = readString(body.turnId, 200);
      if (bodyTurnId && bodyTurnId !== turnId) {
        return json({ error: "Forbidden" }, 403);
      }
      const owner = { ownerId, ownerGeneration };
      try {
        if (action === "create") {
          const conversationId = readString(body.conversationId, 200);
          const integrationId = readString(body.integrationId, 128);
          const name = readString(body.name, 120);
          if (!conversationId || !integrationId || !name) {
            return json(
              { error: "conversationId, integrationId and name are required" },
              400,
            );
          }
          const created = (await ctx.runMutation(
            internal.cloud_connector_connect.createConnectRequestInternal,
            {
              ...owner,
              conversationId,
              turnId,
              integrationId,
              name,
              description: readString(body.description, 500),
              iconUrl: readString(body.iconUrl, 1_000),
              category: readString(body.category, 80),
              reason: readString(body.reason, 300),
              now,
            },
          )) as ConnectRequestSummary;
          return json({ request: created });
        }
        const requestId = readString(body.requestId, 128);
        if (!requestId) return json({ error: "requestId required" }, 400);
        if (action === "cancel") {
          const settled = await ctx.runMutation(
            internal.cloud_connector_connect.settleConnectRequestInternal,
            {
              ...owner,
              requestId,
              state: "canceled",
              fromStates: ["pending", "connecting"],
              now,
            },
          );
          return json({ request: settled });
        }
        if (action !== "poll") {
          return json({ error: 'action must be "create", "poll", or "cancel"' }, 400);
        }
        let current = (await ctx.runQuery(
          internal.cloud_connector_connect.getConnectRequestInternal,
          { ...owner, requestId },
        )) as ConnectRequestSummary | null;
        if (!current) return json({ error: "Connect request not found." }, 404);
        if (current.state === "expired") {
          current =
            ((await ctx.runMutation(
              internal.cloud_connector_connect.settleConnectRequestInternal,
              {
                ...owner,
                requestId,
                state: "expired",
                fromStates: ["expired"],
                now,
              },
            )) as ConnectRequestSummary | null) ?? current;
        }
        // The OAuth hop finishes on a hosted page with no callback to us:
        // while the card is `connecting`, each poll asks the provider whether
        // the account is connected yet and settles the card when it is.
        if (
          current.state === "connecting" &&
          (await checkIntegrationConnected(ctx, ownerId, current.integrationId))
        ) {
          current =
            ((await ctx.runMutation(
              internal.cloud_connector_connect.settleConnectRequestInternal,
              {
                ...owner,
                requestId,
                state: "connected",
                fromStates: ["connecting"],
                now,
              },
            )) as ConnectRequestSummary | null) ?? current;
        }
        return json({ request: current });
      } catch (error) {
        return json(
          { error: error instanceof Error ? error.message : String(error) },
          400,
        );
      }
    }),
  });
};
