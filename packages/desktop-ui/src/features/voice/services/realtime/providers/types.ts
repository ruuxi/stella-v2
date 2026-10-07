/**
 * Provider module contract.
 *
 * A provider knows how to authenticate one realtime voice route and which
 * transport to build for it. Since the move to client delegation, no provider
 * ships a tool catalog: the voice model only converses, and every action goes
 * through Stella's text orchestrator.
 */

import type { VoiceHistoryMessage } from "@stella/contracts/backend/voice";
import type { RealtimeVoiceProvider } from "@stella/contracts/local-preferences";
import type { RealtimeTransport } from "../transports/types";

export type RealtimeProviderKey = RealtimeVoiceProvider;

export type RealtimeTransportKind =
  | "gptlive-webrtc"
  | "openai-webrtc"
  | "xai-websocket";

export type VoiceSessionAuthority = {
  leaseId: string;
  leaseExpiresAt: number;
};

/**
 * Fail closed when a Stella-managed session is missing its server lease.
 * BYOK tokens never pass through this validator.
 */
export const requireVoiceSessionAuthority = (value: {
  leaseId?: unknown;
  leaseExpiresAt?: unknown;
}): VoiceSessionAuthority => {
  const leaseId = typeof value.leaseId === "string" ? value.leaseId.trim() : "";
  const leaseExpiresAt = value.leaseExpiresAt;
  if (
    !leaseId ||
    typeof leaseExpiresAt !== "number" ||
    !Number.isFinite(leaseExpiresAt) ||
    leaseExpiresAt <= 0
  ) {
    throw new Error(
      "Stella voice session response did not include a valid lease.",
    );
  }
  return { leaseId, leaseExpiresAt };
};

export interface VoiceSessionToken {
  /**
   * Which provider authenticated the connection. "stella" means the Stella
   * backend opened a managed GPT-Live session; "openai"/"xai" means the
   * user's BYOK key was used directly.
   */
  provider: RealtimeProviderKey;
  /** Which wire protocol to talk over. */
  transport: RealtimeTransportKind;
  /** Short-lived secret for the transport's auth (empty on the managed path). */
  clientSecret: string;
  /** Server-reported model id, or the requested model as fallback. */
  model: string;
  /** Default voice id selected at session-create time. */
  voice: string;
  /** Unix-seconds expiry, if the provider reports one. */
  expiresAt?: number;
  /** BYOK OpenAI only: returned session id, useful for debugging. */
  sessionId?: string;
  /** Stella-managed voice lease. Present only when Stella opened the session. */
  leaseId?: string;
  /** The lease closes unless renewed before this (Unix milliseconds). */
  leaseExpiresAt?: number;
}

export interface ProviderTokenContext {
  /** Conversation id the call belongs to. */
  conversationId?: string;
  /**
   * Conversation style and delegation policy — a short brief, not Stella's
   * system prompt. The orchestrator keeps its own prompt.
   */
  instructions: string;
  /** Recent text turns, so the call opens knowing where the chat is. */
  history?: VoiceHistoryMessage[];
}

export interface ProviderModule {
  /** Open a session for this provider (managed lease, or a BYOK token). */
  fetchToken(ctx: ProviderTokenContext): Promise<VoiceSessionToken>;
  /** Construct the right transport for this provider's wire protocol. */
  createTransport(
    token: VoiceSessionToken,
    ctx: ProviderTokenContext,
  ): RealtimeTransport;
}
