import type { RealtimeTransport } from "../transports/types";
import type { RealtimeVoiceProvider } from "@stella/contracts/local-preferences";

export type RealtimeProviderKey = RealtimeVoiceProvider;

export type RealtimeTransportKind =
  | "openai-webrtc"
  | "xai-websocket"
  | "inworld-webrtc";

export type RealtimeSessionTool = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export interface VoiceSessionToken {

  provider: RealtimeProviderKey;

  transport: RealtimeTransportKind;

  clientSecret: string;

  model: string;

  voice: string;

  expiresAt?: number;

  sessionId?: string;

  stellaSessionId?: string;

  leaseExpiresAt?: number;

  iceServers?: RTCIceServer[];

  speed?: number;

  ttsModel?: string;
}

export interface ProviderTokenContext {

  conversationId?: string;

  instructions: string;

  tools?: RealtimeSessionTool[];
}

export interface ProviderModule {

  fetchToken(ctx: ProviderTokenContext): Promise<VoiceSessionToken>;

  createTransport(
    token: VoiceSessionToken,
    ctx: ProviderTokenContext,
  ): RealtimeTransport;
}
