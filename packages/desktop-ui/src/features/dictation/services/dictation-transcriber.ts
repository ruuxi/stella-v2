/**
 * Where a finished dictation recording goes to become text:
 *
 * - `managed`: the Stella backend serves dictation (`/api/dictation/transcribe`)
 *   and the user has a Stella session.
 * - `openrouter`: no managed dictation, but the user saved their own
 *   OpenRouter key; Electron main transcribes with it, so the key never
 *   reaches the renderer.
 * - `needs-key`: neither; the first mic press asks for an OpenRouter key.
 */

import { getAuthToken } from "@/global/auth/services/auth-token";
import { backendUrl } from "@/platform/backend/backend-url";

export type DictationRoute = "managed" | "openrouter" | "needs-key";

const TRANSCRIBE_PATH = "/api/dictation/transcribe";
const SAMPLE_RATE = 16_000;
const AVAILABILITY_TTL_MS = 10 * 60_000;

export class DictationRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** True or false as the backend says; null when it couldn't be asked. */
let managedAvailability: { value: Promise<boolean | null>; at: number } | null = null;

const loadManagedAvailability = (): Promise<boolean | null> => {
  if (managedAvailability && Date.now() - managedAvailability.at < AVAILABILITY_TTL_MS) {
    return managedAvailability.value;
  }
  const entry = {
    value: backendUrl
      ? fetch(`${backendUrl}${TRANSCRIBE_PATH}`)
          .then((response) => (response.ok ? response.json() : null))
          .then((body: { available?: unknown } | null) =>
            typeof body?.available === "boolean" ? body.available : null,
          )
          .catch(() => null)
      : Promise.resolve(false),
    at: Date.now(),
  };
  managedAvailability = entry;
  void entry.value.then((value) => {
    if (value === null && managedAvailability === entry) managedAvailability = null;
  });
  return entry.value;
};

const hasOpenRouterKey = async (): Promise<boolean> =>
  (await window.electronAPI?.dictation?.hasOpenRouterKey?.().catch(() => false)) ?? false;

let lastRoute: DictationRoute | null = null;

/** The last resolved route, for a press that shouldn't wait on the network. */
export const cachedDictationRoute = (): DictationRoute | null => lastRoute;

export const resolveDictationRoute = async (): Promise<DictationRoute> => {
  const [managed, token] = await Promise.all([
    loadManagedAvailability(),
    getAuthToken().catch(() => null),
  ]);
  const route: DictationRoute =
    managed !== false && token
      ? "managed"
      : (await hasOpenRouterKey())
        ? "openrouter"
        : "needs-key";
  lastRoute = route;
  return route;
};

/** Warm the availability check and token ahead of a press. Cheap to repeat. */
export const prewarmDictation = (): void => {
  void resolveDictationRoute().catch(() => undefined);
};

/** A user-saved key changes the answer; forget the cached route. */
export const invalidateDictationRoute = (): void => {
  lastRoute = null;
};

/** 16 kHz mono PCM16 chunks as one WAV file. */
export const encodeDictationWav = (chunks: readonly Int16Array[]): ArrayBuffer => {
  const samples = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, samples * 2, true);
  const pcm = new Int16Array(buffer, 44, samples);
  let offset = 0;
  for (const chunk of chunks) {
    pcm.set(chunk, offset);
    offset += chunk.length;
  }
  return buffer;
};

const transcribeManaged = async (wav: ArrayBuffer, signal?: AbortSignal): Promise<string> => {
  const token = await getAuthToken();
  if (!token) throw new DictationRequestError("Sign in to Stella to use dictation.", 401);
  const response = await fetch(`${backendUrl}${TRANSCRIBE_PATH}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "audio/wav" },
    body: wav,
    signal,
  });
  const body = (await response.json().catch(() => ({}))) as {
    text?: unknown;
    error?: unknown;
    code?: unknown;
  };
  if (!response.ok) {
    throw new DictationRequestError(
      typeof body.error === "string" ? body.error : `Dictation failed (${response.status}).`,
      response.status,
      typeof body.code === "string" ? body.code : undefined,
    );
  }
  return typeof body.text === "string" ? body.text.trim() : "";
};

const transcribeWithOwnKey = async (wav: ArrayBuffer): Promise<string> => {
  const api = window.electronAPI?.dictation;
  if (!api?.transcribeWithOpenRouter) {
    throw new DictationRequestError("Dictation isn't available in this window.", 503);
  }
  const { text } = await api.transcribeWithOpenRouter(wav);
  return text.trim();
};

export const transcribeDictation = async (
  wav: ArrayBuffer,
  signal?: AbortSignal,
): Promise<string> => {
  const route = lastRoute ?? (await resolveDictationRoute());
  if (route === "managed") {
    try {
      return await transcribeManaged(wav, signal);
    } catch (error) {
      const unavailable =
        error instanceof DictationRequestError && error.code === "dictation_unavailable";
      if (!unavailable || !(await hasOpenRouterKey())) throw error;
      managedAvailability = null;
      lastRoute = "openrouter";
    }
  }
  return await transcribeWithOwnKey(wav);
};
