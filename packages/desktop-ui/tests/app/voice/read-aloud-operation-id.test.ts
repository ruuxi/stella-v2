import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createServiceRequestMock } = vi.hoisted(() => ({
  createServiceRequestMock: vi.fn(
    async (path: string, headers: Record<string, string>) => ({
      endpoint: `https://example.test${path}`,
      headers,
    }),
  ),
}));

const { playReadAloudMock, playReadAloudStreamMock, stopReadAloudMock } =
  vi.hoisted(() => ({
    playReadAloudMock: vi.fn(async () => undefined),
    playReadAloudStreamMock: vi.fn(async () => undefined),
    stopReadAloudMock: vi.fn(),
  }));

vi.mock("@/platform/http/service-request", () => ({
  createServiceRequest: createServiceRequestMock,
}));
vi.mock("@/features/voice/services/read-aloud/read-aloud-player", () => ({
  canStreamReadAloud: () => true,
  playReadAloud: playReadAloudMock,
  playReadAloudStream: playReadAloudStreamMock,
  stopReadAloud: stopReadAloudMock,
}));
vi.mock("@/features/voice/services/read-aloud/read-aloud-voice-prefs", () => ({
  resolveReadAloudVoicePrefs: async () => ({
    family: "inworld",
    voice: "Brooke",
    speed: 1,
  }),
}));

import {
  createReadAloudOperationId,
  fetchReadAloudAudio,
  openReadAloudStream,
} from "@/features/voice/services/read-aloud/tts-client";
import { toggleManualReadAloud } from "@/features/voice/services/read-aloud/manual-read-aloud";

const fetchMock = vi.fn(async () =>
  Promise.resolve(
    new Response(new Uint8Array([0xff, 0xe0]), {
      status: 200,
      headers: { "content-type": "audio/mpeg" },
    }),
  ),
);

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("read-aloud logical operation identity", () => {
  it("serializes the same bounded operation id for stream and fallback", async () => {
    const operationId = createReadAloudOperationId();

    await openReadAloudStream({
      operationId,
      text: "Read this once",
      voice: "Brooke",
    });
    await fetchReadAloudAudio({
      operationId,
      text: "Read this once",
      voiceProvider: "inworld",
      voice: "Brooke",
    });

    const streamBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body),
    ) as { operationId?: unknown };
    const fallbackBody = JSON.parse(
      String((fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.body),
    ) as { operationId?: unknown };

    expect(operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(streamBody.operationId).toBe(operationId);
    expect(fallbackBody.operationId).toBe(operationId);
  });

  it("keeps one operation id when a manual stream falls back", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response("stream unavailable", {
          status: 503,
          headers: { "content-type": "text/plain" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([0xff, 0xe0]), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        }),
      );

    await toggleManualReadAloud("message-1", "Read this once");

    const streamBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body),
    ) as { operationId?: unknown };
    const fallbackBody = JSON.parse(
      String((fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.body),
    ) as { operationId?: unknown };

    expect(typeof streamBody.operationId).toBe("string");
    expect(fallbackBody.operationId).toBe(streamBody.operationId);
    expect(playReadAloudStreamMock).not.toHaveBeenCalled();
    expect(playReadAloudMock).toHaveBeenCalledOnce();

    await toggleManualReadAloud("message-1", "Read this once");
  });
});
