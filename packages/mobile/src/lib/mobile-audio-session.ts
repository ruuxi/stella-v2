import { setAudioModeAsync } from "expo-audio";
import {
  AudioSessionCoordinator,
  type MobileAudioMode,
  type RecordingAudioLease,
} from "./audio-session-coordinator";

const coordinator = new AudioSessionCoordinator(setAudioModeAsync);

export const acquireRecordingAudioSession = (mode?: MobileAudioMode) =>
  coordinator.acquireRecording(mode);

export const refreshRecordingAudioSession = (
  lease: RecordingAudioLease,
  mode: MobileAudioMode,
) => coordinator.refreshRecording(lease, mode);

export const releaseRecordingAudioSession = (lease: RecordingAudioLease) =>
  coordinator.releaseRecording(lease);

export const configurePlaybackAudioSession = () =>
  coordinator.configurePlayback();

export type { RecordingAudioLease } from "./audio-session-coordinator";
