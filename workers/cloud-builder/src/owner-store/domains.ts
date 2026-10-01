/**
 * Every backend domain, in migration order. A domain's migrations run after
 * the ones listed before it, so append new domains at the end.
 */

import { empty } from "./args.js";
import { agentThreadsDomain } from "./domains/agent-threads.js";
import { conversationsDomain } from "./domains/conversations.js";
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
];

export const ownerRegistry = createOwnerRegistry(ownerDomains);
