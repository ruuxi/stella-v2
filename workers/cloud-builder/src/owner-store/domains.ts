/**
 * Every backend domain, in migration order. A domain's migrations run after
 * the ones listed before it, so append new domains at the end.
 */

import { empty } from "./args.js";
import { agentThreadsDomain } from "./domains/agent-threads.js";
import { appSourceDomain } from "./domains/app-source.js";
import { billingDomain } from "./domains/billing.js";
import { conversationEditsDomain } from "./domains/conversation-edits.js";
import { conversationsDomain } from "./domains/conversations.js";
import { devicesDomain } from "./domains/devices.js";
import { homeDomain } from "./domains/home.js";
import { driveDomain } from "./domains/drive.js";
import { schedulesDomain } from "./domains/schedules.js";
import { preferencesDomain } from "./domains/preferences.js";
import { accountDomain } from "./domains/account.js";
import { sharesDomain } from "./domains/shares.js";
import { searchDomain } from "./domains/search.js";
import { mediaDomain } from "./domains/media.js";
import { voiceDomain } from "./domains/voice.js";
import { abuseDomain } from "./domains/abuse.js";
import { integrationsDomain } from "./domains/integrations.js";
import { enginesDomain } from "./domains/engines.js";
import { RATE_LIMIT_MIGRATION } from "./rate-limit.js";
import { createOwnerRegistry, type OwnerDomain } from "./registry.js";

const systemDomain: OwnerDomain = {
  name: "system",
  migrations: [RATE_LIMIT_MIGRATION],
  calls: {
    "system.ping": {
      scope: "owner",
      parse: empty(),
      handler: (ctx) => ({ now: ctx.now }),
    },
  },
};

export const ownerDomains: OwnerDomain[] = [
  systemDomain,
  conversationsDomain,
  agentThreadsDomain,
  conversationEditsDomain,
  billingDomain,
  devicesDomain,
  appSourceDomain,
  homeDomain,
  driveDomain,
  schedulesDomain,
  preferencesDomain,
  accountDomain,
  sharesDomain,
  searchDomain,
  mediaDomain,
  voiceDomain,
  abuseDomain,
  integrationsDomain,
  enginesDomain,
];

export const ownerRegistry = createOwnerRegistry(ownerDomains);
