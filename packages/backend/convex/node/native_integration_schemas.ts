"use node";

import AjvModule from "ajv";
import { v } from "convex/values";
import { internalAction } from "../_generated/server";

const Ajv =
  (AjvModule as unknown as { default?: typeof AjvModule }).default ?? AjvModule;

const createValidator = () =>
  new Ajv({
    allErrors: true,
    strict: false,
    coerceTypes: false,
    validateFormats: false,
    logger: false,
  });

const parseObject = (value: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

export const validatePublishedActionSchemas = internalAction({
  args: {
    actions: v.array(
      v.object({
        name: v.string(),
        inputSchemaJson: v.string(),
      }),
    ),
  },
  returns: v.object({
    ok: v.boolean(),
    invalidAction: v.optional(v.string()),
  }),
  handler: async (_ctx, args) => {
    for (const action of args.actions) {
      const schema = parseObject(action.inputSchemaJson);
      if (!schema) return { ok: false, invalidAction: action.name };
      try {
        createValidator().compile(schema);
      } catch {
        return { ok: false, invalidAction: action.name };
      }
    }
    return { ok: true };
  },
});

export const validateActionInput = internalAction({
  args: {
    inputJson: v.string(),
    schemaJson: v.string(),
  },
  returns: v.union(
    v.literal("valid"),
    v.literal("invalid"),
    v.literal("invalid_schema"),
  ),
  handler: async (_ctx, args) => {
    const schema = parseObject(args.schemaJson);
    const input = parseObject(args.inputJson);
    if (!schema) return "invalid_schema";
    if (!input) return "invalid";
    try {
      return createValidator().compile(schema)(input) ? "valid" : "invalid";
    } catch {
      return "invalid_schema";
    }
  },
});
