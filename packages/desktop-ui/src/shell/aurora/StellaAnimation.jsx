import React, { useEffect, useImperativeHandle, useRef } from "react";
import "./StellaAnimation.css";
import {
  BIRTH_DURATION,
  FLASH_DURATION,
  parseColor,
  resolveAuroraSpec,
} from "./aurora-spec";
import { acquireAuroraRenderer, releaseAuroraRenderer } from "./renderer-pool";
import { computeAnalyserEnergy } from "@/features/voice/services/audio-energy";
import { useContinuousAnimationGate } from "@/shared/hooks/use-continuous-animation-gate";
import { createDemandDrivenAnimationLoop } from "@/shared/lib/demand-driven-animation-loop";

let energyBuffer = null;
function computeEnergy(analyser) {
  const result = computeAnalyserEnergy(analyser, energyBuffer);
  energyBuffer = result.buffer;
  return result.energy;
}
const NOISE_FLOOR_FAST_RATE = 0.1;
const NOISE_FLOOR_SLOW_RATE = 0.005;
const NOISE_FLOOR_SPEECH_RATIO = 3;
const NOISE_FLOOR_MIN_THRESHOLD = 0.04;
const LISTENING_ATTACK_LERP = 0.35;
const LISTENING_RELEASE_LERP = 0.14;
const SPEAKING_ATTACK_LERP = 0.18;
const SPEAKING_RELEASE_LERP = 0.12;
const VOICE_ENERGY_ATTACK_RATE = 0.24;
const VOICE_ENERGY_RELEASE_RATE = 0.08;

const TIME_RATE = 0.96;

const AURORA_STOP_DECLARATION = /--stella-aurora-\d\s*:[^;]*/g;

function readPaletteSignature() {
  const root = document.documentElement;
  const inline = root.getAttribute("style");
  return [
    root.getAttribute("class") ?? "",
    root.getAttribute("data-theme") ?? "",
    root.getAttribute("data-base-theme") ?? "",
    inline ? (inline.match(AURORA_STOP_DECLARATION) ?? []).join(";") : "",
  ].join("|");
}
export const StellaAnimation = React.forwardRef(
  (
    {
      width = 80,
      height = 40,
      displayWidth,
      displayHeight,
      initialBirthProgress = 1,
      paused = false,
      maxDpr,
      frameSkip = 0,
      maxFps,
      requireWindowFocus = false,
      timeScale = 1,
      variant = "star",
      voiceMode = "idle",
      isUserSpeaking = false,
      analyserRef: externalAnalyserRef,
      outputAnalyserRef: externalOutputAnalyserRef,
      micLevel: externalMicLevel,
      outputLevel: externalOutputLevel,
      micLevelRef: externalMicLevelSourceRef,
      outputLevelRef: externalOutputLevelSourceRef,
    },
    ref,
  ) => {
    const containerRef = useRef(null);
    const stop1Ref = useRef(null);
    const stop2Ref = useRef(null);
    const stop3Ref = useRef(null);
    const stop4Ref = useRef(null);
    const stop5Ref = useRef(null);
    const animationGateOpen = useContinuousAnimationGate({
      active: !paused,
      elementRef: containerRef,
      requireWindowFocus,
    });
    const effectivePaused = paused || !animationGateOpen;
    const loopRef = useRef(null);
    const renderStaticRef = useRef(null);
    const pausedRef = useRef(effectivePaused);
    const timeRef = useRef(0);
    const lastFrameTimeRef = useRef(0);
    const birthRef = useRef(initialBirthProgress);
    const flashRef = useRef(0);
    const birthAnimationRef = useRef(null);
    const flashAnimationRef = useRef(null);
    const listeningRef = useRef(0);
    const speakingRef = useRef(0);
    const voiceEnergyRef = useRef(0);
    const noiseFloorRef = useRef(0);
    const voiceModeRef = useRef(voiceMode);
    const isUserSpeakingRef = useRef(isUserSpeaking);
    const externalMicLevelValueRef = useRef(externalMicLevel);
    const externalOutputLevelValueRef = useRef(externalOutputLevel);

    const timeScaleRef = useRef(timeScale);
    const resolvedMaxFps = maxFps ?? 60 / (Math.max(0, frameSkip) + 1);
    useImperativeHandle(
      ref,
      () => ({
        triggerFlash: () => {
          flashAnimationRef.current = {
            startTime: performance.now(),
            duration: FLASH_DURATION,
          };
          flashRef.current = 1;
        },
        startBirth: () => {
          if (birthRef.current >= 1) return;
          birthAnimationRef.current = {
            startTime: performance.now(),
            startValue: birthRef.current,
            duration: BIRTH_DURATION,
          };
        },
        reset: (value = initialBirthProgress) => {
          birthRef.current = value;
          birthAnimationRef.current = null;
          flashRef.current = 0;
          flashAnimationRef.current = null;
        },
      }),
      [initialBirthProgress],
    );
    useEffect(() => {
      if (!birthAnimationRef.current) {
        birthRef.current = initialBirthProgress;
      }
    }, [initialBirthProgress]);
    useEffect(() => {
      timeScaleRef.current = timeScale;
    }, [timeScale]);
    useEffect(() => {
      voiceModeRef.current = voiceMode;
    }, [voiceMode]);
    useEffect(() => {
      isUserSpeakingRef.current = isUserSpeaking;
    }, [isUserSpeaking]);
    useEffect(() => {
      externalMicLevelValueRef.current = externalMicLevel;
    }, [externalMicLevel]);
    useEffect(() => {
      externalOutputLevelValueRef.current = externalOutputLevel;
    }, [externalOutputLevel]);
    useEffect(() => {
      pausedRef.current = effectivePaused;
      if (effectivePaused) {
        loopRef.current?.stop();
        lastFrameTimeRef.current = 0;
        renderStaticRef.current?.();
        return;
      }
      loopRef.current?.start();
    }, [effectivePaused]);
    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;
      const readColors = () => {
        const swatches = [
          stop1Ref.current,
          stop2Ref.current,
          stop3Ref.current,
          stop4Ref.current,
          stop5Ref.current,
        ];
        const parsed = swatches.map((el) =>
          parseColor(getComputedStyle(el || container).color),
        );
        return new Float32Array(parsed.flat());
      };
      const spec = resolveAuroraSpec(container, {
        width,
        height,
        displayWidth,
        displayHeight,
        maxDpr,
        variant,
      });

      const pooled = acquireAuroraRenderer(
        spec,
        readColors(),
        birthRef.current,
        flashRef.current,
      );
      if (!pooled) return;
      container.appendChild(pooled.canvas);
      const mainRenderer = pooled.renderer;
      const animate = (now) => {
        if (pausedRef.current) {
          lastFrameTimeRef.current = 0;
          return;
        }
        const dt =
          lastFrameTimeRef.current > 0
            ? Math.min(now - lastFrameTimeRef.current, 100)
            : 16.667;
        lastFrameTimeRef.current = now;
        timeRef.current += (dt / 1000) * TIME_RATE * timeScaleRef.current;
        const birthAnimation = birthAnimationRef.current;
        if (birthAnimation) {
          const elapsed = now - birthAnimation.startTime;
          const t = Math.min(elapsed / birthAnimation.duration, 1);
          const eased = 1 - Math.pow(1 - t, 3);
          birthRef.current =
            birthAnimation.startValue + (1 - birthAnimation.startValue) * eased;
          if (t >= 1) birthAnimationRef.current = null;
        }
        const flashAnimation = flashAnimationRef.current;
        if (flashAnimation) {
          const elapsed = now - flashAnimation.startTime;
          const t = Math.min(elapsed / flashAnimation.duration, 1);
          flashRef.current = 1 - t;
          if (t >= 1) {
            flashRef.current = 0;
            flashAnimationRef.current = null;
          }
        }

        const outputAnalyser = externalOutputAnalyserRef?.current ?? null;
        const micAnalyser = externalAnalyserRef?.current ?? null;
        const outputLevelFromRef = externalOutputLevelSourceRef?.current;
        const micLevelFromRef = externalMicLevelSourceRef?.current;
        const outputEnergy =
          typeof outputLevelFromRef === "number"
            ? outputLevelFromRef
            : typeof externalOutputLevelValueRef.current === "number"
              ? externalOutputLevelValueRef.current
              : outputAnalyser
                ? computeEnergy(outputAnalyser)
                : 0;
        const micEnergy =
          typeof micLevelFromRef === "number"
            ? micLevelFromRef
            : typeof externalMicLevelValueRef.current === "number"
              ? externalMicLevelValueRef.current
              : micAnalyser
                ? computeEnergy(micAnalyser)
                : 0;
        const isVoiceActive = voiceModeRef.current !== "idle";

        if (!isVoiceActive) {
          noiseFloorRef.current = 0;
        } else {
          const floor = noiseFloorRef.current;
          if (micEnergy <= floor || floor === 0) {

            noiseFloorRef.current =
              floor * (1 - NOISE_FLOOR_FAST_RATE) +
              micEnergy * NOISE_FLOOR_FAST_RATE;
          } else if (micEnergy < floor * NOISE_FLOOR_SPEECH_RATIO) {

            noiseFloorRef.current =
              floor * (1 - NOISE_FLOOR_SLOW_RATE) +
              micEnergy * NOISE_FLOOR_SLOW_RATE;
          }

        }
        const speechThreshold = Math.max(
          noiseFloorRef.current * NOISE_FLOOR_SPEECH_RATIO,
          NOISE_FLOOR_MIN_THRESHOLD,
        );

        const isSpeakingNow =
          voiceModeRef.current === "speaking" ||
          (isVoiceActive && outputEnergy > 0.08);
        const isListeningNow =
          isVoiceActive &&
          !isSpeakingNow &&
          (isUserSpeakingRef.current || micEnergy > speechThreshold);

        const targetListening = isListeningNow ? 1 : 0;
        const targetSpeaking = isSpeakingNow ? 1 : 0;
        const listeningLerp =
          targetListening > listeningRef.current
            ? LISTENING_ATTACK_LERP
            : LISTENING_RELEASE_LERP;
        const speakingLerp =
          targetSpeaking > speakingRef.current
            ? SPEAKING_ATTACK_LERP
            : SPEAKING_RELEASE_LERP;
        listeningRef.current +=
          (targetListening - listeningRef.current) * listeningLerp;
        speakingRef.current +=
          (targetSpeaking - speakingRef.current) * speakingLerp;

        const rawEnergy = isSpeakingNow
          ? Math.min(outputEnergy * 2.5, 1)
          : Math.min(micEnergy * 2.5, 1);
        const energyRate =
          rawEnergy > voiceEnergyRef.current
            ? VOICE_ENERGY_ATTACK_RATE
            : VOICE_ENERGY_RELEASE_RATE;
        voiceEnergyRef.current +=
          (rawEnergy - voiceEnergyRef.current) * energyRate;

        if (targetListening === 0 && listeningRef.current < 0.005)
          listeningRef.current = 0;
        if (targetSpeaking === 0 && speakingRef.current < 0.005)
          speakingRef.current = 0;
        if (rawEnergy === 0 && voiceEnergyRef.current < 0.005)
          voiceEnergyRef.current = 0;
        mainRenderer.render(
          timeRef.current,
          birthRef.current,
          flashRef.current,
          listeningRef.current,
          speakingRef.current,
          voiceEnergyRef.current,
        );
      };
      const renderStatic = () =>
        mainRenderer.render(
          timeRef.current,
          birthRef.current,
          flashRef.current,
          0,
          0,
          0,
        );
      const loop = createDemandDrivenAnimationLoop({
        maxFramesPerSecond: resolvedMaxFps,
        onFrame: animate,
      });
      loopRef.current = loop;
      renderStaticRef.current = renderStatic;

      renderStatic();
      if (!pausedRef.current) {
        loop.start();
      }

      let paletteSignature = readPaletteSignature();
      const observer = new MutationObserver(() => {
        const next = readPaletteSignature();
        if (next === paletteSignature) return;
        paletteSignature = next;
        mainRenderer.setColors(readColors());
      });
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "style", "data-theme", "data-base-theme"],
      });
      return () => {
        loop.stop();
        if (loopRef.current === loop) loopRef.current = null;
        if (renderStaticRef.current === renderStatic) {
          renderStaticRef.current = null;
        }
        observer.disconnect();

        releaseAuroraRenderer(pooled);
      };
    }, [
      width,
      height,
      displayWidth,
      displayHeight,
      externalAnalyserRef,
      externalOutputAnalyserRef,
      externalMicLevelSourceRef,
      externalOutputLevelSourceRef,
      maxDpr,
      requireWindowFocus,
      resolvedMaxFps,
      variant,
    ]);
    return (
      <div
        ref={containerRef}
        className={
          effectivePaused
            ? "stella-animation-container stella-animation-container--paused"
            : "stella-animation-container"
        }
      >
        <span
          ref={stop1Ref}
          className="aurora-color-swatch aurora-stop-1"
          aria-hidden="true"
        />
        <span
          ref={stop2Ref}
          className="aurora-color-swatch aurora-stop-2"
          aria-hidden="true"
        />
        <span
          ref={stop3Ref}
          className="aurora-color-swatch aurora-stop-3"
          aria-hidden="true"
        />
        <span
          ref={stop4Ref}
          className="aurora-color-swatch aurora-stop-4"
          aria-hidden="true"
        />
        <span
          ref={stop5Ref}
          className="aurora-color-swatch aurora-stop-5"
          aria-hidden="true"
        />
      </div>
    );
  },
);
StellaAnimation.displayName = "StellaAnimation";
