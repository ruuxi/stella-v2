import { AudioModule } from "expo-audio";

export type MicrophonePermissionResult =
  | { granted: true }
  | { granted: false; canAskAgain: boolean };

type PermissionLike = { granted?: boolean; canAskAgain?: boolean };

const normalize = (value: PermissionLike | null | undefined) =>
  value?.granted === true
    ? ({ granted: true } as const)
    : ({ granted: false, canAskAgain: value?.canAskAgain !== false } as const);

/**
 * Resolve microphone access before a voice surface opens: reuse an existing
 * grant silently and only show the system prompt when it is actually needed.
 * Callers open their voice UI after this resolves, so the OS prompt never
 * races the surface's own foreground/background handling.
 */
export const ensureMicrophonePermission =
  async (): Promise<MicrophonePermissionResult> => {
    const current = normalize(
      await AudioModule.getRecordingPermissionsAsync().catch(() => null),
    );
    if (current.granted) return current;
    if (!current.canAskAgain) return current;
    return normalize(await AudioModule.requestRecordingPermissionsAsync());
  };
