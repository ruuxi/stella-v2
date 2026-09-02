import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { postAlert } from "./lib/alerts";

export const postAlertInternal = internalAction({
  args: {
    text: v.string(),
    fields: v.optional(
      v.record(v.string(), v.union(v.string(), v.number())),
    ),
  },
  returns: v.null(),
  handler: async (_ctx, args) => {
    await postAlert(args.text, args.fields);
    return null;
  },
});
