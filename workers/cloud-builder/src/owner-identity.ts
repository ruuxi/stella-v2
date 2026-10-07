/**
 * Tell an owner's object its verified caller's identity level, for routes
 * that reach the owner through another object, such as a conversation's
 * turns. RPC and live calls carry the caller to the owner object themselves.
 * Each isolate tells an owner once per identity it sees.
 */

import type { VerifiedToken } from "./auth-jwt.js";

const NOTED_MAX = 10_000;
const noted = new Map<string, string>();

export const noteOwnerIdentity = async (
  env: Pick<Cloudflare.Env, "OWNER_GATES">,
  token: Pick<VerifiedToken, "ownerId" | "identityLevel">,
): Promise<void> => {
  const identity = String(token.identityLevel);
  if (noted.get(token.ownerId) === identity) return;
  try {
    await env.OWNER_GATES.getByName(token.ownerId).noteIdentity({
      identityLevel: token.identityLevel,
    });
  } catch (error) {
    // The owner object refuses the turn itself if it is unreachable.
    console.error(
      JSON.stringify({ event: "owner_identity_note_failed", message: error instanceof Error ? error.message : String(error) }),
    );
    return;
  }
  if (noted.size >= NOTED_MAX) noted.clear();
  noted.set(token.ownerId, identity);
};
