// Mobile port of `desktop/src/shell/ascii-creature/StellaAnimation.tsx`.
//
// `width` / `height` are character-grid units (same as desktop), not layout pt.
// Optional `displayWidth` / `displayHeight` set the GLView layout size in pt
// (e.g. 70 for the working indicator — desktop's 350px canvas × scale(0.2)).

import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import { StyleSheet, View } from "react-native";
import { GLView, type ExpoWebGLRenderingContext } from "expo-gl";
import { useColors, useTheme } from "../../theme/theme-context";
import { type Colors } from "../../theme/colors";
import { generateAuroraStops } from "../../theme/oklch";
import {
  BIRTH_DURATION,
  FLASH_DURATION,
  buildGlyphAtlas,
  parseColor,
} from "./glyph-atlas";
import { getStellaRenderLayout } from "./layout";
import { initRenderer, type StellaRenderer } from "./renderer";
import { initAuroraRenderer } from "./aurora-renderer";

const TIME_RATE = 0.96;
/** One display frame at 60Hz — the unit `frameSkip` counts in. */
const FRAME_PERIOD_MS = 1000 / 60;
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

export interface StellaAnimationHandle {
  triggerFlash: () => void;
  startBirth: () => void;
  reset: (value?: number) => void;
}

export type VoiceMode = "idle" | "listening" | "speaking";

/**
 * `"creature"` — the ascii/glyph creature.
 * `"star"` — the star from the brand mark, made of aurora and spun like a top,
 * matching the desktop working indicator (`desktop-ui/src/shell/aurora`,
 * variant `"star-spin"`).
 */
export type StellaVariant = "creature" | "star";

export interface StellaAnimationProps {
  /** Character-grid width — matches desktop `StellaAnimation` `width`. */
  width?: number;
  /** Character-grid height — matches desktop `StellaAnimation` `height`. */
  height?: number;
  /**
   * GLView layout width in pt. Defaults to the full supersampled canvas size
   * (`width × 7 × 2.5`). Pass `WORKING_INDICATOR_DISPLAY_PT` for the inline
   * indicator — RN GLView breaks inside `transform: scale`, so the surface is
   * sized natively rather than rendered large and scaled down.
   */
  displayWidth?: number;
  /** GLView layout height in pt. */
  displayHeight?: number;
  /**
   * Frames skipped between draws, counted in 60Hz display frames — 0 draws at
   * 60fps, 1 at 30, 2 at 20. It sets the timer's period rather than filtering
   * its callbacks, so a skipped frame costs no JS wake-up either.
   */
  frameSkip?: number;
  /**
   * Multiplier on shader time. The star wants 1 — its turn is staged inside the
   * shader against an unscaled clock, and its motion blur is sized to one frame
   * of that clock (see `starTurn` / `sweep` in the shader). Scaling time here
   * desynchronises the smear from the ground the arms actually cover.
   */
  timeScale?: number;
  initialBirthProgress?: number;
  paused?: boolean;
  /** Audio-reactive state used by the realtime voice surface. */
  voiceMode?: VoiceMode;
  /** Server-side speech detection for the user's microphone. */
  isUserSpeaking?: boolean;
  /** Normalized microphone energy (0…1). */
  micLevel?: number;
  /** Normalized Stella output energy (0…1). */
  outputLevel?: number;
  /** Restores the original drifting/blinking creature eyes. */
  showEyes?: boolean;
  /** Which creature to draw. Defaults to the ascii `"creature"`. */
  variant?: StellaVariant;
}

const colorsToFloat = (c: Colors): Float32Array =>
  new Float32Array([
    ...parseColor(c.borderStrong),
    ...parseColor(c.textMuted),
    ...parseColor(c.accent),
    ...parseColor(c.accentHover),
    ...parseColor(c.text),
  ]);

/**
 * The star's five aurora ramp stops. Desktop seeds these from the theme's
 * `interactive` + `accent`; the mobile `Colors` shape carries those same two
 * seeds as `accentHover` (= `Src.interactive`) and `decorative`
 * (= `Src.accent`) — see the `map()` in theme/themes.ts.
 */
const colorsToAurora = (c: Colors, isDark: boolean): Float32Array =>
  new Float32Array(
    generateAuroraStops(c.accentHover, c.decorative, isDark).flatMap((stop) =>
      parseColor(stop),
    ),
  );

const StellaAnimationInner = React.forwardRef<
  StellaAnimationHandle,
  StellaAnimationProps
>(function StellaAnimation(
  {
    width = 80,
    height = 40,
    displayWidth,
    displayHeight,
    frameSkip = 0,
    timeScale = 1,
    initialBirthProgress = 1,
    paused = false,
    voiceMode = "idle",
    isUserSpeaking = false,
    micLevel = 0,
    outputLevel = 0,
    showEyes = false,
    variant = "creature",
  },
  ref,
) {
  const colors = useColors();
  const { isDark } = useTheme();
  const shaderColors = useMemo(
    () =>
      variant === "star"
        ? colorsToAurora(colors, isDark)
        : colorsToFloat(colors),
    [colors, isDark, variant],
  );
  const shaderColorsRef = useRef(shaderColors);
  shaderColorsRef.current = shaderColors;
  const variantRef = useRef(variant);
  variantRef.current = variant;
  const timeScaleRef = useRef(timeScale);
  timeScaleRef.current = timeScale;

  const layout = useMemo(
    () => getStellaRenderLayout(width, height),
    [width, height],
  );

  const layoutStyle = useMemo(
    () => ({
      width: displayWidth ?? layout.renderWidth,
      height: displayHeight ?? layout.renderHeight,
    }),
    [displayWidth, displayHeight, layout.renderWidth, layout.renderHeight],
  );

  const rendererRef = useRef<StellaRenderer | null>(null);
  const tickFnRef = useRef<(() => void) | null>(null);
  const pausedRef = useRef(paused);
  const timeRef = useRef(0);
  const lastFrameMsRef = useRef(0);
  const birthRef = useRef(initialBirthProgress);
  const flashRef = useRef(0);
  const listeningRef = useRef(0);
  const speakingRef = useRef(0);
  const voiceEnergyRef = useRef(0);
  const noiseFloorRef = useRef(0);
  const voiceModeRef = useRef<VoiceMode>(voiceMode);
  const isUserSpeakingRef = useRef(isUserSpeaking);
  const micLevelRef = useRef(micLevel);
  const outputLevelRef = useRef(outputLevel);
  const showEyesRef = useRef(showEyes);
  const birthAnimRef = useRef<{
    startMs: number;
    startValue: number;
    duration: number;
  } | null>(null);
  const flashAnimRef = useRef<{ startMs: number; duration: number } | null>(
    null,
  );

  useEffect(() => {
    voiceModeRef.current = voiceMode;
  }, [voiceMode]);

  useEffect(() => {
    isUserSpeakingRef.current = isUserSpeaking;
  }, [isUserSpeaking]);

  useEffect(() => {
    micLevelRef.current = micLevel;
  }, [micLevel]);

  useEffect(() => {
    outputLevelRef.current = outputLevel;
  }, [outputLevel]);

  useEffect(() => {
    showEyesRef.current = showEyes;
  }, [showEyes]);

  useImperativeHandle(
    ref,
    () => ({
      triggerFlash: () => {
        flashAnimRef.current = {
          startMs: nowMs(),
          duration: FLASH_DURATION,
        };
        flashRef.current = 1;
      },
      startBirth: () => {
        if (birthRef.current >= 1) return;
        birthAnimRef.current = {
          startMs: nowMs(),
          startValue: birthRef.current,
          duration: BIRTH_DURATION,
        };
      },
      reset: (value = initialBirthProgress) => {
        birthRef.current = value;
        birthAnimRef.current = null;
        flashRef.current = 0;
        flashAnimRef.current = null;
      },
    }),
    [initialBirthProgress],
  );

  useEffect(() => {
    rendererRef.current?.setColors(shaderColors);
  }, [shaderColors]);

  useEffect(() => {
    pausedRef.current = paused;
    if (paused) {
      lastFrameMsRef.current = 0;
    }
  }, [paused]);

  const { shaderGridW, shaderGridH } = layout;

  const onContextCreate = useCallback(
    (gl: ExpoWebGLRenderingContext) => {
      const buildRenderer = (): StellaRenderer | null => {
        if (variantRef.current === "star") {
          // The star is a plain screen-space quad — no glyph atlas or grid.
          return initAuroraRenderer(
            gl,
            shaderColorsRef.current,
            birthRef.current,
            flashRef.current,
          );
        }
        const glyphWidth = Math.max(
          4,
          Math.floor(gl.drawingBufferWidth / shaderGridW),
        );
        const glyphHeight = Math.max(
          4,
          Math.floor(gl.drawingBufferHeight / shaderGridH),
        );
        return initRenderer(
          gl,
          buildGlyphAtlas(glyphWidth, glyphHeight),
          shaderGridW,
          shaderGridH,
          shaderColorsRef.current,
          birthRef.current,
          flashRef.current,
        );
      };
      const renderer = buildRenderer();
      if (!renderer) return;
      rendererRef.current = renderer;

      renderer.render(
        timeRef.current,
        birthRef.current,
        flashRef.current,
        listeningRef.current,
        speakingRef.current,
        voiceEnergyRef.current,
        showEyesRef.current,
      );

      const tick = () => {
        if (pausedRef.current) {
          lastFrameMsRef.current = 0;
          return;
        }

        const now = nowMs();
        const dt =
          lastFrameMsRef.current > 0
            ? Math.min(now - lastFrameMsRef.current, 100)
            : 16.667;
        lastFrameMsRef.current = now;
        timeRef.current += (dt / 1000) * TIME_RATE * timeScaleRef.current;

        const birthAnim = birthAnimRef.current;
        if (birthAnim) {
          const t = Math.min(
            (now - birthAnim.startMs) / birthAnim.duration,
            1,
          );
          const eased = 1 - Math.pow(1 - t, 3);
          birthRef.current =
            birthAnim.startValue + (1 - birthAnim.startValue) * eased;
          if (t >= 1) birthAnimRef.current = null;
        }

        const flashAnim = flashAnimRef.current;
        if (flashAnim) {
          const t = Math.min(
            (now - flashAnim.startMs) / flashAnim.duration,
            1,
          );
          flashRef.current = 1 - t;
          if (t >= 1) {
            flashRef.current = 0;
            flashAnimRef.current = null;
          }
        }

        const micEnergy = Math.max(0, Math.min(1, micLevelRef.current));
        const outputEnergy = Math.max(0, Math.min(1, outputLevelRef.current));
        const isVoiceActive = voiceModeRef.current !== "idle";

        // Match the legacy realtime creature: learn the ambient microphone
        // floor slowly, then react only when actual speech clears it.
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
          voiceModeRef.current === "speaking" || outputEnergy > 0.08;
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

        if (targetListening === 0 && listeningRef.current < 0.005) {
          listeningRef.current = 0;
        }
        if (targetSpeaking === 0 && speakingRef.current < 0.005) {
          speakingRef.current = 0;
        }
        if (rawEnergy === 0 && voiceEnergyRef.current < 0.005) {
          voiceEnergyRef.current = 0;
        }

        renderer.render(
          timeRef.current,
          birthRef.current,
          flashRef.current,
          listeningRef.current,
          speakingRef.current,
          voiceEnergyRef.current,
          showEyesRef.current,
        );
      };

      tickFnRef.current = tick;
    },
    [shaderGridW, shaderGridH],
  );

  // Use setInterval rather than rAF: on React Native, rAF is coalesced into the
  // JS scheduler and goes idle if no React commits are queued, which freezes
  // expo-gl after the first frame even when JS is free.
  //
  // The timer runs at the frame rate rather than at 60Hz with the extras thrown
  // away: waking JS sixty times a second to skip two of every three wake-ups is
  // pure battery on a phone, and there is nothing for the discarded ticks to do.
  // A paused surface gets no timer at all — it used to keep waking to find out
  // that it was still paused.
  useEffect(() => {
    if (paused) return;
    const periodMs = Math.round(FRAME_PERIOD_MS * (Math.max(0, frameSkip) + 1));
    const id = setInterval(() => tickFnRef.current?.(), periodMs);
    return () => clearInterval(id);
  }, [frameSkip, paused]);

  useEffect(() => {
    return () => {
      tickFnRef.current = null;
      const renderer = rendererRef.current;
      rendererRef.current = null;
      if (renderer) {
        try {
          renderer.destroy();
        } catch {
          // GL context may already be gone.
        }
      }
    };
  }, []);

  const containerStyle = useMemo(
    () => [styles.container, layoutStyle],
    [layoutStyle],
  );

  return (
    <View style={containerStyle} pointerEvents="none" collapsable={false}>
      {/* Both surfaces here draw one quad covering the whole view, so there is
          no polygon edge for multisampling to find: every sample in a pixel is
          covered, the fragment shader runs once, and the resolve averages four
          identical samples. iOS turns 4x MSAA on by default, which buys a
          multisampled colour buffer and a resolve pass per frame for exactly
          nothing — desktop measured the same trade at 0.49ms against 0.016ms
          for byte-identical output. Every edge you can see in these shaders is
          drawn by a smoothstep instead, which MSAA could never have helped. */}
      <GLView
        style={styles.gl}
        msaaSamples={0}
        onContextCreate={onContextCreate}
      />
    </View>
  );
});

/**
 * Memoized so the working indicator's GL surface is never re-rendered by the
 * chat's per-token streaming commits or by status-label swaps. The frame loop
 * is a JS-thread `setInterval` (expo-gl can only be driven from the JS thread),
 * so keeping this component out of the streaming re-render path is what stops
 * the star's frames from being reset/starved while a reply streams. Props are
 * primitives that stay stable across a working-indicator session (only
 * `paused` toggles), so the default shallow comparison is correct; the realtime
 * voice surface still re-renders on changing mic/output levels.
 */
export const StellaAnimation = React.memo(StellaAnimationInner);

const nowMs = (): number => {
  if (
    typeof globalThis !== "undefined" &&
    typeof globalThis.performance?.now === "function"
  ) {
    return globalThis.performance.now();
  }
  return Date.now();
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: "transparent",
  },
  gl: {
    width: "100%",
    height: "100%",
    backgroundColor: "transparent",
  },
});

export {
  STELLA_EDGE_SCALE,
  STELLA_GLYPH_PX,
  WORKING_INDICATOR_DISPLAY_PT,
  WORKING_INDICATOR_GRID,
  WORKING_INDICATOR_VIEWPORT_PT,
  getStellaRenderLayout,
  getWorkingIndicatorLayout,
} from "./layout";
