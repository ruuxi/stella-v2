import { defineSchema } from "convex/server";
import { authSchema } from "./schema/auth";
import { ownerLifecycleSchema } from "./schema/owner_lifecycle";
import { abuseSchema } from "./schema/abuse";

export default defineSchema({
  ...authSchema,
  ...ownerLifecycleSchema,
  ...abuseSchema,
});
