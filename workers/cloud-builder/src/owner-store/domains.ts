/**
 * Every backend domain, in migration order. A domain's migrations run after
 * the ones listed before it, so append new domains at the end.
 */

import { empty } from "./args.js";
import { createOwnerRegistry, type OwnerDomain } from "./registry.js";

const systemDomain: OwnerDomain = {
  name: "system",
  calls: {
    "system.ping": {
      scope: "owner",
      parse: empty(),
      handler: (ctx) => ({ now: ctx.now }),
    },
  },
};

export const ownerDomains: OwnerDomain[] = [systemDomain];

export const ownerRegistry = createOwnerRegistry(ownerDomains);
