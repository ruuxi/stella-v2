import type { StellaCharacterState } from "@/ui/stella-character/rig";

export type PhoneAccessCharacterInput = {
  hasConnectedAccount: boolean;
  hasActivePairing: boolean;
  pairedCount: number;
};

/**
 * The pose the phone-access hero holds, from the card's own state:
 *
 *  1. Pairing in flight — the QR is up and we are waiting on the phone, so
 *     the mark listens: its radar rings are the beacon the phone is joining.
 *  2. Already paired — she is pleased to have you on your phone.
 *  3. Otherwise (signed out, or nothing paired yet) she idles and waits.
 */
export function getPhoneAccessCharacterState({
  hasConnectedAccount,
  hasActivePairing,
  pairedCount,
}: PhoneAccessCharacterInput): StellaCharacterState {
  if (!hasConnectedAccount) return "idle";
  if (hasActivePairing) return "listening";
  if (pairedCount > 0) return "happy";
  return "idle";
}
