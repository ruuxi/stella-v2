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
import { backupsSchema } from "./schema/backups";
import { fashionSchema } from "./schema/fashion";
import { feedbackSchema } from "./schema/feedback";
import { desktopReleasesSchema } from "./schema/desktop_releases";
import { emojiPacksSchema } from "./schema/emoji_packs";
import { canvasSharesSchema } from "./schema/canvas_shares";
import { promptsSchema } from "./schema/prompts";

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
  ...backupsSchema,
  ...fashionSchema,
  ...feedbackSchema,
  ...desktopReleasesSchema,
  ...emojiPacksSchema,
  ...canvasSharesSchema,
  ...promptsSchema,
});
