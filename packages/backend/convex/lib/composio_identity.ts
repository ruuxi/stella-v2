import { hashSha256Hex } from "./crypto_utils";

/** Stable provider principal used by every Composio session for one owner. */
export const composioUserIdForOwner = async (
  ownerId: string,
): Promise<string> => `stella_${(await hashSha256Hex(ownerId)).slice(0, 32)}`;
