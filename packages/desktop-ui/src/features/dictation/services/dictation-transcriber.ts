import { getAuthToken } from "@/global/auth/services/auth-token";
import { backendUrl } from "@/platform/backend/backend-url";

export type DictationRoute = "streaming" | "managed" | "openrouter" | "needs-key";

type ManagedAvailability = { available: boolean; streaming: boolean };

const TRANSCRIBE_PATH = "/api/dictation/transcribe";
const AVAILABILITY_TTL_MS = 10 * 60_000;
const AVAILABILITY_TIMEOUT_MS = 5_000;

export class DictationRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

let managedAvailability: { value: Promise<ManagedAvailability | null>; at: number } | null = null;
let routeGeneration = 0;
let lastRoute: DictationRoute | null = null;

const loadManagedAvailability = (): Promise<ManagedAvailability | null> => {
  if (managedAvailability && Date.now() - managedAvailability.at < AVAILABILITY_TTL_MS) {
    return managedAvailability.value;
  }
  const entry = {
    value: backendUrl
      ? fetch(`${backendUrl}${TRANSCRIBE_PATH}`, { signal: AbortSignal.timeout(AVAILABILITY_TIMEOUT_MS) })
          .then((response) => (response.ok ? response.json() : null))
          .then((body: { available?: unknown; streaming?: unknown } | null) =>
            typeof body?.available === "boolean"
              ? { available: body.available, streaming: body.streaming === true }
              : null,
          )
          .catch(() => null)
      : Promise.resolve({ available: false, streaming: false }),
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

export const cachedDictationRoute = (): DictationRoute | null => lastRoute;

export const resolveDictationRoute = async (): Promise<DictationRoute> => {
  const generation = routeGeneration;
  const [managed, token] = await Promise.all([
    loadManagedAvailability(),
    getAuthToken().catch(() => null),
  ]);
  const route: DictationRoute =
    token && managed?.streaming
      ? "streaming"
      : token && managed?.available !== false
        ? "managed"
        : (await hasOpenRouterKey())
          ? "openrouter"
          : "needs-key";
  if (generation === routeGeneration) lastRoute = route;
  return route;
};

export const prewarmDictation = (): void => {
  void resolveDictationRoute().catch(() => undefined);
};

export const invalidateDictationRoute = (): void => {
  routeGeneration += 1;
  lastRoute = null;
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

const transcribeWithOwnKey = async (wav: ArrayBuffer, signal?: AbortSignal): Promise<string> => {
  const api = window.electronAPI?.dictation;
  if (!api?.transcribeWithOpenRouter) {
    throw new DictationRequestError("Dictation isn't available in this window.", 503);
  }
  signal?.throwIfAborted();
  const requestId = crypto.randomUUID();
  const onAbort = () => api.cancelOpenRouter?.({ requestId });
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const aborted = new Promise<never>((_, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    const { text } = await Promise.race([api.transcribeWithOpenRouter({ requestId, wav }), aborted]);
    return text.trim();
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
};

export const transcribeDictation = async (
  wav: ArrayBuffer,
  signal?: AbortSignal,
): Promise<string> => {
  const route = lastRoute ?? (await resolveDictationRoute());
  if (route === "managed" || route === "streaming") {
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
  return await transcribeWithOwnKey(wav, signal);
};
