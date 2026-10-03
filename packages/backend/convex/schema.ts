import { defineSchema } from "convex/server";
import { authSchema } from "./schema/auth";
import { devicesSchema } from "./schema/devices";
import { telemetrySchema } from "./schema/telemetry";
import { gatewaySchema } from "./schema/gateway";
import { ownerLifecycleSchema } from "./schema/owner_lifecycle";
import { abuseSchema } from "./schema/abuse";

export default defineSchema({
  ...authSchema,
  ...devicesSchema,
  ...telemetrySchema,
  ...gatewaySchema,
  ...ownerLifecycleSchema,
  ...abuseSchema,
});
