import { defineSchema } from "convex/server";
import { conversationsSchema } from "./schema/conversations";
import { agentsSchema } from "./schema/agents";
import { authSchema } from "./schema/auth";
import { integrationsSchema } from "./schema/integrations";
import { devicesSchema } from "./schema/devices";
import { usersSchema } from "./schema/users";
import { telemetrySchema } from "./schema/telemetry";
import { gatewaySchema } from "./schema/gateway";
import { cloudAppsSchema } from "./schema/cloud_apps";
import { cloudEnginesSchema } from "./schema/cloud_engines";
import { cloudProjectsSchema } from "./schema/cloud_projects";
import { ownerLifecycleSchema } from "./schema/owner_lifecycle";
import { cloudBrowserSchema } from "./schema/cloud_browser";
import { cloudConnectorConnectSchema } from "./schema/cloud_connector_connect";
import { cloudOutboxSchema } from "./schema/cloud_outbox";
import { abuseSchema } from "./schema/abuse";

export default defineSchema({
  ...conversationsSchema,
  ...agentsSchema,
  ...authSchema,
  ...integrationsSchema,
  ...devicesSchema,
  ...usersSchema,
  ...telemetrySchema,
  ...gatewaySchema,
  ...cloudAppsSchema,
  ...cloudEnginesSchema,
  ...cloudProjectsSchema,
  ...ownerLifecycleSchema,
  ...cloudBrowserSchema,
  ...cloudConnectorConnectSchema,
  ...cloudOutboxSchema,
  ...abuseSchema,
});
