import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * Where the hands-free "Talk to Stella" voice loop (CarPlay today) sends the
 * dictated message:
 *
 *   • `phone`    — the local cloud chat (the original behaviour).
 *   • `computer` — the paired desktop's Stella agent over the bridge, i.e.
 *                  the same conversation as the Computer tab.
 *   • `auto`     — pick contextually: computer when that's the chat the user
 *                  last used AND the desktop looks reachable; phone otherwise.
 *
 * The preference is set from the Settings screen (Auto / Phone / Computer)
 * or pinned by the CarPlay target row (which toggles Phone ↔ Computer).
 */
export type VoiceTargetPreference = "auto" | "phone" | "computer";

/** A resolved, concrete target — what the voice loop actually routes to. */
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
    // Keep the in-memory value; worst case the choice doesn't survive relaunch.
  }
}

export function voiceTargetHydrated(): boolean {
  return hydrated;
}

/** Subscribe to preference changes; returns an unsubscribe function. */
export function subscribeVoiceTargetPreference(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Map a bridge status-probe outcome to the `computerReachable` input of
 * {@link resolveVoiceTarget}: a completed probe yields its confirmed
 * availability; a probe that FAILED (network error, auth hiccup, timeout)
 * yields null — unknown. Unknown must never demote Auto to the phone: only a
 * probe that positively answered "not available" may, otherwise the computer
 * target stands and the send path wakes the desktop or fails audibly with the
 * spoken offline reply.
 */
export function reachabilityFromProbe(
  outcome: { available: boolean } | null,
): boolean | null {
  return outcome ? outcome.available : null;
}

/**
 * Resolve the preference to a concrete target. Pure so the routing policy is
 * unit-testable; callers gather the async inputs (pairing, last tab, bridge
 * reachability) and pass them in.
 *
 * Rules:
 *   • Nothing paired → always phone (a computer target would be a dead end).
 *   • Explicit phone/computer → honored. An explicitly-chosen computer stays
 *     computer even when it looks offline: the desktop send path wakes the
 *     machine, and on failure surfaces a spoken "your computer is offline"
 *     reply — a clear outcome, never dead air.
 *   • Auto → computer only when the Computer tab is where the user left off
 *     AND the desktop isn't known-unreachable (unknown counts as reachable —
 *     the send path's wake/offline reply covers the miss).
 */
export function resolveVoiceTarget(opts: {
  preference: VoiceTargetPreference;
  /** Whether a desktop is paired (a computer target is even possible). */
  paired: boolean;
  /** The last main tab the user was on ("chat" | "computer" | ...), if known. */
  lastMainTab: string | null;
  /** Bridge availability probe result; null when unknown/not probed. */
  computerReachable: boolean | null;
}): VoiceTarget {
  if (!opts.paired) return "phone";
  if (opts.preference === "phone") return "phone";
  if (opts.preference === "computer") return "computer";
  if (opts.lastMainTab !== "computer") return "phone";
  return opts.computerReachable === false ? "phone" : "computer";
}
