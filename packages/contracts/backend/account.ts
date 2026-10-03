/**
 * Account-wide actions, such as resetting the owner's data.
 */

export type AccountCalls = {
  /**
   * Erase the caller's data and start a new owner generation. Returns once the
   * reset has started; the purge itself finishes in the background.
   */
  "account.reset": { args: Record<string, never>; result: null };
};

/**
 * Convex service route the owner object posts to for `account.reset`
 * (`Authorization: Bearer ${BUILDER_SERVICE_SECRET}`, body `{ ownerId }`).
 * Convex still owns the owner generation and the purge job until phase 10.
 */
export const CONVEX_OWNER_RESET_PATH = "/api/cloud/owners/reset" as const;
