import { action, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { v, ConvexError } from "convex/values";
import { requireUserId } from "../auth";
import { ConnectorError } from "./errors";

/**
 * Read the stored input JSON Schema for a connector action from the shared
 * `integration_actions` catalog. This is executor-neutral: the same per-action
 * schema rows serve Composio and first-party. Used to enforce server-side input
 * validation before a first-party provider call.
 */
export const getConnectorActionSchema = internalQuery({
  args: { connectorId: v.string(), action: v.string() },
  returns: v.union(v.null(), v.object({ inputSchemaJson: v.string() })),
  handler: async (ctx, args) => {
    const connectorId = args.connectorId.trim().toLowerCase();
    const row = await ctx.db
      .query("integration_actions")
      .withIndex("by_integrationId_and_name", (q) =>
        q.eq("integrationId", connectorId).eq("name", args.action),
      )
      .unique();
    return row ? { inputSchemaJson: row.inputSchemaJson } : null;
  },
});

/**
 * Public, authenticated first-party execution entrypoint for the runtime broker.
 * The route (which executor runs) is resolved server-side from
 * `connector_rollouts`; this endpoint only ever runs the FIRST-PARTY executor.
 * Composio-routed connectors keep using the existing `/api/native-integrations/
 * run` path. There is never any dual-execution or cross-executor fallback.
 */
export const runConnectorAction = action({
  args: {
    connectorId: v.string(),
    action: v.string(),
    input: v.any(),
    requestId: v.optional(v.string()),
  },
  returns: v.object({ executor: v.literal("first_party"), output: v.any() }),
  handler: async (ctx, args): Promise<{ executor: "first_party"; output: unknown }> => {
    const ownerId = await requireUserId(ctx);
    const connectorId = args.connectorId.trim().toLowerCase();
    try {
      const schema = await ctx.runQuery(
        internal.connectors.run.getConnectorActionSchema,
        { connectorId, action: args.action },
      );
      return await ctx.runAction(
        internal.connectors.execute.runFirstPartyConnectorAction,
        {
          ownerId,
          connectorId,
          action: args.action,
          inputJson: JSON.stringify(args.input ?? {}),
          requestId: args.requestId,
          schemaJson: schema?.inputSchemaJson,
        },
      );
    } catch (error) {
      if (error instanceof ConnectorError) {
        throw new ConvexError({ code: "CONNECTOR_ERROR", message: error.code });
      }
      throw error;
    }
  },
});
