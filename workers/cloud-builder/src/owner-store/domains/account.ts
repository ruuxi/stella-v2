/**
 * Account-wide actions, such as resetting the owner's data.
 *
 * `account.reset` stops this object's own timers, then asks Convex to start
 * the reset: Convex still owns the owner generation and the purge job, which
 * fences the owner, drains its stores and calls back into
 * `OwnerGate.purgeOwnerData` through the worker's `/owners/purge`.
 */

import { CONVEX_OWNER_RESET_PATH } from "@stella/contracts/backend/account";
import { convexSiteBase } from "../../convex-site.js";
import { empty } from "../args.js";
import { RpcError } from "../errors.js";
import { enforceOwnerRateLimit } from "../rate-limit.js";
import type { OwnerContext, OwnerDomain } from "../registry.js";
import { SCHEDULE_FIRE_JOB } from "./schedules.js";

// Convex runs the whole reset before answering, as the old action did.
const RESET_TIMEOUT_MS = 300_000;

/** Pending scheduled fires must not start turns for data that is going away. */
const cancelScheduleFires = (ctx: OwnerContext): void => {
  const fires = ctx.db.all<{ id: string }>(
    "SELECT id FROM owner_jobs WHERE kind = ?",
    SCHEDULE_FIRE_JOB,
  );
  for (const fire of fires) ctx.jobs.cancel(fire.id);
};

const resetAccount = async (ctx: OwnerContext): Promise<null> => {
  // Matches the old Convex action's sensitive limit: five a minute.
  enforceOwnerRateLimit(
    ctx.db,
    ctx.now,
    "account.reset",
    { count: 5, windowMs: 60_000 },
    "Too many account reset attempts. Please wait a minute and try again.",
  );
  const base = convexSiteBase(ctx.env);
  const secret = ctx.env.BUILDER_SERVICE_SECRET;
  if (!base || !secret) {
    throw new RpcError("UNAVAILABLE", "Resetting your data is unavailable right now. Try again.");
  }
  let response: Response;
  try {
    response = await fetch(`${base}${CONVEX_OWNER_RESET_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ ownerId: ctx.ownerId }),
      signal: AbortSignal.timeout(RESET_TIMEOUT_MS),
    });
  } catch {
    throw new RpcError("UNAVAILABLE", "Resetting your data failed. Try again.");
  }
  if (response.status === 409) {
    throw new RpcError("CONFLICT", "Your account is being deleted.");
  }
  if (!response.ok) {
    throw new RpcError("UNAVAILABLE", "Resetting your data failed. Try again.");
  }
  // After Convex took the reset, so a refused request leaves schedules armed.
  // A fire that lands before this is refused by the owner purge fence.
  cancelScheduleFires(ctx);
  return null;
};

export const accountDomain: OwnerDomain = {
  name: "account",
  calls: {
    "account.reset": {
      scope: "owner",
      requireAccount: true,
      parse: empty(),
      handler: resetAccount,
    },
  },
};
