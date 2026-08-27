import { describe, expect, test } from "bun:test";
import {
  AudioSessionCoordinator,
  type MobileAudioMode,
} from "../audio-session-coordinator";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("AudioSessionCoordinator", () => {
  test("keeps trailing speech when playback is requested during dictation", async () => {
    let recorderActive = false;
    const captured: string[] = [];
    const coordinator = new AudioSessionCoordinator(async (mode) => {

      recorderActive = mode.allowsRecording === true;
    });
    const speak = (words: string) => {
      if (recorderActive) captured.push(words);
    };

    const lease = await coordinator.acquireRecording();
    speak("I would do like");
    expect(await coordinator.configurePlayback()).toBe(false);
    speak("continue with the rest");

    expect(captured.join(" ")).toBe(
      "I would do like continue with the rest",
    );
    await coordinator.releaseRecording(lease!);
  });

  test("a late playback setup cannot stop a newly claimed recorder", async () => {
    const playbackNativeCall = deferred();
    const applied: MobileAudioMode[] = [];
    const coordinator = new AudioSessionCoordinator(async (mode) => {
      applied.push(mode);
      if (mode.allowsRecording === false) await playbackNativeCall.promise;
    });

    const playback = coordinator.configurePlayback();
    await Promise.resolve();
    const recording = coordinator.acquireRecording();

    playbackNativeCall.resolve();
    expect(await playback).toBe(false);
    const lease = await recording;

    expect(lease !== null).toBe(true);
    expect(applied).toEqual([
      { allowsRecording: false, playsInSilentMode: true },
      { allowsRecording: true, playsInSilentMode: true },
    ]);
    expect(await coordinator.configurePlayback()).toBe(false);
  });

  test("an old release cannot disable a newer recording lease", async () => {
    const applied: MobileAudioMode[] = [];
    const coordinator = new AudioSessionCoordinator(async (mode) => {
      applied.push(mode);
    });

    const first = await coordinator.acquireRecording();
    expect(first !== null).toBe(true);
    const secondPromise = coordinator.acquireRecording();
    await coordinator.releaseRecording(first!);
    const second = await secondPromise;

    expect(second !== null).toBe(true);
    expect(applied.at(-1)).toEqual({
      allowsRecording: true,
      playsInSilentMode: true,
    });
  });
});
