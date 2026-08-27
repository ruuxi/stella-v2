import { defineSchema } from "convex/server";
import { conversationsSchema } from "./schema/conversations";
import { agentsSchema } from "./schema/agents";
import { authSchema } from "./schema/auth";
import { integrationsSchema } from "./schema/integrations";
import { devicesSchema } from "./schema/devices";
import { usersSchema } from "./schema/users";
import { telemetrySchema } from "./schema/telemetry";
import { billingSchema } from "./schema/billing";
import { storeSchema } from "./schema/store";
import { mediaSchema } from "./schema/media";
import { socialSchema } from "./schema/social";
import { backupsSchema } from "./schema/backups";
import { fashionSchema } from "./schema/fashion";
import { feedbackSchema } from "./schema/feedback";
import { desktopReleasesSchema } from "./schema/desktop_releases";
import { petsSchema } from "./schema/pets";
import { emojiPacksSchema } from "./schema/emoji_packs";
import { userPetsSchema } from "./schema/user_pets";
import { canvasSharesSchema } from "./schema/canvas_shares";
import { promptsSchema } from "./schema/prompts";
import { relayResumeSchema } from "./schema/relay_resume";
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
import { c8CleanupSchema } from "./schema/c8_cleanup";

export default defineSchema({
  ...conversationsSchema,
  ...agentsSchema,
  ...authSchema,
  ...integrationsSchema,
  ...devicesSchema,
  ...usersSchema,
  ...telemetrySchema,
  ...billingSchema,
  ...storeSchema,
  ...mediaSchema,
  ...socialSchema,
  ...backupsSchema,
  ...fashionSchema,
  ...feedbackSchema,
  ...desktopReleasesSchema,
  ...petsSchema,
  ...emojiPacksSchema,
  ...userPetsSchema,
  ...canvasSharesSchema,
  ...promptsSchema,
  ...relayResumeSchema,
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
  ...c8CleanupSchema,
});
