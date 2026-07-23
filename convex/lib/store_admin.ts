import { ConvexError } from "convex/values";
import { authComponent } from "../auth";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * Store team accounts allowed to work the manual approval queue.
 *
 * Gating is by the signed-in account's email (Better Auth user record).
 * `STELLA_STORE_ADMIN_EMAILS` (comma-separated, case-insensitive)
 * overrides the built-in default, which is Rahul's account.
 */
const DEFAULT_STORE_ADMIN_EMAILS = ["lolruuxi@gmail.com"];

const getStoreAdminEmails = (): Set<string> => {
  const raw = process.env.STELLA_STORE_ADMIN_EMAILS?.trim();
  const emails = raw
    ? raw.split(",").map((email) => email.trim().toLowerCase())
    : DEFAULT_STORE_ADMIN_EMAILS;
  return new Set(emails.filter(Boolean));
};

export const isStoreAdminCtx = async (
  ctx: QueryCtx | MutationCtx,
): Promise<boolean> => {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user || typeof user !== "object") return false;
  const record = user as Record<string, unknown>;
  if (record.isAnonymous === true) return false;
  const email =
    typeof record.email === "string" ? record.email.trim().toLowerCase() : "";
  if (!email) return false;
  return getStoreAdminEmails().has(email);
};

export const requireStoreAdmin = async (
  ctx: QueryCtx | MutationCtx,
): Promise<void> => {
  if (!(await isStoreAdminCtx(ctx))) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: "Store review is restricted to the Stella team.",
    });
  }
};
