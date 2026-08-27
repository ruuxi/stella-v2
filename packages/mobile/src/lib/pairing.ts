import { completePhonePairing, type StoredPhoneAccess } from "./phone-access";
import { notifyError, notifySuccess } from "./haptics";
import { userFacingError } from "./user-facing-error";

export const PAIRING_CODE_LENGTH = 8;

export const normalizePairingCode = (value: string) =>
  value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, PAIRING_CODE_LENGTH);

export type PairingResult =
  | { ok: true; access: StoredPhoneAccess }
  | { ok: false; error: string };

export async function pairWithCode(code: string): Promise<PairingResult> {
  try {
    const access = await completePhonePairing({ pairingCode: code });
    notifySuccess();
    return { ok: true, access };
  } catch (error) {
    notifyError();
    return { ok: false, error: userFacingError(error) };
  }
}
