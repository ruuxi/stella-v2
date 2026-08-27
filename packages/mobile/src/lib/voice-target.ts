import AsyncStorage from "@react-native-async-storage/async-storage";

export type VoiceTargetPreference = "auto" | "phone" | "computer";

export type VoiceTarget = "phone" | "computer";

const STORAGE_KEY = "stella-mobile_voice-target.preference";

type Listener = (preference: VoiceTargetPreference) => void;

let preference: VoiceTargetPreference = "auto";
let hydrated = false;
const listeners = new Set<Listener>();

const parsePreference = (raw: string | null): VoiceTargetPreference | null =>
  raw === "auto" || raw === "phone" || raw === "computer" ? raw : null;

const notify = () => {
  for (const fn of listeners) fn(preference);
};

export function getVoiceTargetPreference(): VoiceTargetPreference {
  return preference;
}

export async function loadVoiceTargetPreference(): Promise<VoiceTargetPreference> {
  try {
    preference = parsePreference(await AsyncStorage.getItem(STORAGE_KEY)) ?? "auto";
  } catch {
    preference = "auto";
  }
  hydrated = true;
  notify();
  return preference;
}

export async function setVoiceTargetPreference(
  next: VoiceTargetPreference,
): Promise<void> {
  preference = next;
  hydrated = true;
  notify();
  try {
    if (next === "auto") {
      await AsyncStorage.removeItem(STORAGE_KEY);
    } else {
      await AsyncStorage.setItem(STORAGE_KEY, next);
    }
  } catch {

  }
}

export function voiceTargetHydrated(): boolean {
  return hydrated;
}

export function subscribeVoiceTargetPreference(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function reachabilityFromProbe(
  outcome: { available: boolean } | null,
): boolean | null {
  return outcome ? outcome.available : null;
}

export function resolveVoiceTarget(opts: {
  preference: VoiceTargetPreference;

  paired: boolean;

  lastMainTab: string | null;

  computerReachable: boolean | null;
}): VoiceTarget {
  if (!opts.paired) return "phone";
  if (opts.preference === "phone") return "phone";
  if (opts.preference === "computer") return "computer";
  if (opts.lastMainTab !== "computer") return "phone";
  return opts.computerReachable === false ? "phone" : "computer";
}
