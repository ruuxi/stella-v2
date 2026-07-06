/**
 * Tracks whether the user has explicitly agreed to share data with the
 * third-party AI providers Stella routes through (OpenRouter / Fireworks
 * gateways → Anthropic / OpenAI / Google for text; Mistral Voxtral for
 * voice transcription).
 *
 * Required by App Store Review Guideline 5.1.1(i) / 5.1.2(i): we must
 * disclose what is sent, who it is sent to, and get the user's permission
 * BEFORE any data leaves the device.
 */

import * as SecureStore from "expo-secure-store";

const CONSENT_KEY = "stella-mobile_ai-data-consent";

let cached: boolean | null = null;

type Listener = () => void;
const requestListeners = new Set<Listener>();

export async function loadAiConsent(): Promise<boolean> {
  if (cached !== null) return cached;
  const value = await SecureStore.getItemAsync(CONSENT_KEY);
  cached = value === "1";
  return cached;
}

export async function grantAiConsent(): Promise<void> {
  cached = true;
  await SecureStore.setItemAsync(CONSENT_KEY, "1");
}

export function hasAiConsent(): boolean {
  return cached === true;
}

/**
 * Imperatively ask the host to show the consent modal. Used from places
 * (like dictation) that cannot mount the modal themselves but need to
 * gate a third-party AI call behind explicit user permission.
 */
export function requestAiConsent(): void {
  for (const listener of requestListeners) listener();
}

export function subscribeAiConsentRequested(listener: Listener): () => void {
  requestListeners.add(listener);
  return () => {
    requestListeners.delete(listener);
  };
}

export function clearAiConsent(): void {
  cached = false;
  void SecureStore.deleteItemAsync(CONSENT_KEY);
}
