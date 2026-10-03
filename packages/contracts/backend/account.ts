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
