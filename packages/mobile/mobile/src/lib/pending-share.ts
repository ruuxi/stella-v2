import type { ImagePickerAsset } from "expo-image-picker";

/**
 * Content shared into Stella from another app (share sheet), parked here
 * until the chat screen is mounted and ready to prefill the composer.
 */
export type PendingShare = {
  text?: string;
  assets?: ImagePickerAsset[];
};

let pending: PendingShare | null = null;
const listeners = new Set<() => void>();

export function setPendingShare(share: PendingShare) {
  pending = share;
  for (const listener of listeners) listener();
}

/** Returns and clears the parked share. */
export function consumePendingShare(): PendingShare | null {
  const out = pending;
  pending = null;
  return out;
}

export function subscribePendingShare(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
