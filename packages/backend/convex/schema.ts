import { defineSchema } from "convex/server";
import { conversationsSchema } from "./schema/conversations";
import { agentsSchema } from "./schema/agents";
import { authSchema } from "./schema/auth";
import { integrationsSchema } from "./schema/integrations";
import { devicesSchema } from "./schema/devices";
import { usersSchema } from "./schema/users";
import { telemetrySchema } from "./schema/telemetry";
import { billingSchema } from "./schema/billing";
import { mediaSchema } from "./schema/media";
import { fashionSchema } from "./schema/fashion";
import { feedbackSchema } from "./schema/feedback";
import { desktopReleasesSchema } from "./schema/desktop_releases";
import { emojiPacksSchema } from "./schema/emoji_packs";
import { canvasSharesSchema } from "./schema/canvas_shares";
import { promptsSchema } from "./schema/prompts";
import { gatewaySchema } from "./schema/gateway";
import { cloudAppsSchema } from "./schema/cloud_apps";
import { cloudEnginesSchema } from "./schema/cloud_engines";
import { cloudAgentHomeSchema } from "./schema/cloud_agent_home";
import { cloudDriveSchema } from "./schema/cloud_drive";
import { cloudProjectsSchema } from "./schema/cloud_projects";
import { cloudScheduleSchema } from "./schema/cloud_schedule";
import { ownerLifecycleSchema } from "./schema/owner_lifecycle";
import { executionPlacementSchema } from "./schema/execution_placement";
import { cloudConversationEditsSchema } from "./schema/cloud_conversation_edits";
import { accountExternalMediaSchema } from "./schema/account_external_media";
import { cloudBrowserSchema } from "./schema/cloud_browser";
import { cloudOutboxSchema } from "./schema/cloud_outbox";
import { xBotSchema } from "./schema/x_bot";
import { abuseSchema } from "./schema/abuse";

export default defineSchema({
  ...conversationsSchema,
  ...agentsSchema,
  ...authSchema,
  ...integrationsSchema,
  ...devicesSchema,
  ...usersSchema,
  ...telemetrySchema,
  ...billingSchema,
  ...mediaSchema,
  ...fashionSchema,
  ...feedbackSchema,
  ...desktopReleasesSchema,
  ...emojiPacksSchema,
  ...canvasSharesSchema,
  ...promptsSchema,
  ...gatewaySchema,
  ...cloudAppsSchema,
  ...cloudEnginesSchema,
  ...cloudAgentHomeSchema,
  ...cloudDriveSchema,
  ...cloudProjectsSchema,
  ...cloudScheduleSchema,
  ...ownerLifecycleSchema,
  ...executionPlacementSchema,
  ...cloudConversationEditsSchema,
  ...accountExternalMediaSchema,
  ...cloudBrowserSchema,
  ...cloudOutboxSchema,
  ...xBotSchema,
  ...abuseSchema,
});
