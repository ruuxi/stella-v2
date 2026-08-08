// Mobile port of `desktop/src/shell/ascii-creature/renderer.ts`.
//
// Differences from desktop:
//   * Atlas is uploaded via the pixel-pointer `texImage2D` overload (no DOM
//     canvas source).
//   * Texture flip / premultiplied-alpha `pixelStorei` are no-ops for
//     ArrayBufferView uploads, so we skip them.
//   * Buffer size comes from `gl.drawingBufferWidth/Height` (the GLView's
//     attached framebuffer), not a `<canvas>` element.

import type { ExpoWebGLRenderingContext } from "expo-gl";
import { DOT_COUNT, type GlyphAtlas } from "./glyph-atlas";
import { VERTEX_SOURCE, createProgram, getFragmentShader } from "./shader";

export type StellaRenderer = {
  render: (
    time: number,
    birth: number,
    flash: number,
    listening?: number,
    speaking?: number,
    voiceEnergy?: number,
    showEyes?: boolean,
  ) => void;
  setColors: (next: Float32Array) => void;
  destroy: () => void;
};

const fract = (x: number) => x - Math.floor(x);
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep01 = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

const createAnimationUniforms = (
  width: number,
  height: number,
  time: number,
) => {
  const cycle = time * 0.15;
  const phase = cycle - Math.floor(cycle / 3) * 3;
  let w1 =
    Math.max(0, 1 - Math.abs(phase)) + Math.max(0, 1 - Math.abs(phase - 3));
  let w2 = Math.max(0, 1 - Math.abs(phase - 1));
  let w3 = Math.max(0, 1 - Math.abs(phase - 2));
  const total = w1 + w2 + w3 || 1;
  w1 /= total;
  w2 /= total;
  w3 /= total;

  const eyeAngle = -time * 2.5;
  const drift1x = Math.cos(eyeAngle) * 1.1;
  const drift1y = Math.sin(eyeAngle) * 1.1;
  const et = time * 2;
  const ep1 = Math.sin(et) * 0.5 + 0.5;
  const ep2 = Math.sin(et + 2.094) * 0.5 + 0.5;
  const ep3 = Math.sin(et + 4.188) * 0.5 + 0.5;
  const epSum = ep1 + ep2 + ep3 || 1;
  const drift2x = ((ep1 - 0.5 * ep2 - 0.5 * ep3) / epSum) * 1.8;
  const drift2y = ((0.866 * ep2 - 0.866 * ep3) / epSum) * 1.8;
  const drift3y = -Math.sin(time * 0.4) * 0.9;
  const eyeDriftX = drift1x * w1 + drift2x * w2;
  const eyeDriftY = drift1y * w1 + drift2y * w2 + drift3y * w3;

  const blinkSlot = Math.floor(time / 0.8);
  const blinkLocal = fract(time / 0.8);
  const blinkHash = fract(Math.sin(blinkSlot * 91.7) * 43758.5453);
  const doBlink = blinkHash >= 0.65 ? 1 : 0;
  const bt = clamp01(blinkLocal / 0.1);
  const blinkCurve = smoothstep01(0, 1, Math.abs(bt * 2 - 1));
  let blink = 1 + (blinkCurve - 1) * doBlink;
  const dblHash = fract(Math.sin(blinkSlot * 73.3) * 28461.7);
  const doDouble = (dblHash >= 0.8 ? 1 : 0) * doBlink;
  const bt2 = clamp01((blinkLocal - 0.15) / 0.1);
  const dblCurve = smoothstep01(0, 1, Math.abs(bt2 * 2 - 1));
  blink *= 1 + (dblCurve - 1) * doDouble;

  return {
    w1,
    w2,
    w3,
    eyeOriginX: 0.5 + eyeDriftX / width,
    eyeOriginY: 0.5 - 2.5 / height + eyeDriftY / height,
    blink,
  };
};

export const initRenderer = (
  gl: ExpoWebGLRenderingContext,
  atlas: GlyphAtlas,
  gridWidth: number,
  gridHeight: number,
  initialColors: Float32Array,
  birthValue: number,
  flashValue: number,
): StellaRenderer | null => {
  const program = createProgram(gl, VERTEX_SOURCE, getFragmentShader());
  if (!program) return null;

  const positionBuffer = gl.createBuffer();
  if (!positionBuffer) {
    gl.deleteProgram(program);
    return null;
  }

  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW,
  );

  gl.useProgram(program);
  const aPosition = gl.getAttribLocation(program, "a_position");
  gl.enableVertexAttribArray(aPosition);
  gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);

  const glyphTexture = gl.createTexture();
  if (!glyphTexture) {
    gl.deleteBuffer(positionBuffer);
    gl.deleteProgram(program);
    return null;
  }
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, glyphTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    atlas.width,
    atlas.height,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    atlas.pixels,
  );

  const uCanvasSize = gl.getUniformLocation(program, "u_canvasSize");
  const uGridSize = gl.getUniformLocation(program, "u_gridSize");
  const uTime = gl.getUniformLocation(program, "u_time");
  const uCharCount = gl.getUniformLocation(program, "u_charCount");
  const uBirth = gl.getUniformLocation(program, "u_birth");
  const uFlash = gl.getUniformLocation(program, "u_flash");
  const uGlyph = gl.getUniformLocation(program, "u_glyph");
  const uColors = gl.getUniformLocation(program, "u_colors[0]");
  const uListening = gl.getUniformLocation(program, "u_listening");
  const uSpeaking = gl.getUniformLocation(program, "u_speaking");
  const uVoiceEnergy = gl.getUniformLocation(program, "u_voiceEnergy");
  const uShowEyes = gl.getUniformLocation(program, "u_showEyes");
  const uAspect = gl.getUniformLocation(program, "u_aspect");
  const uPhases = gl.getUniformLocation(program, "u_phases");
  const uEyeOrigin = gl.getUniformLocation(program, "u_eyeOrigin");
  const uEyeBlink = gl.getUniformLocation(program, "u_eyeBlink");

  if (
    !uCanvasSize ||
    !uGridSize ||
    !uTime ||
    !uCharCount ||
    !uBirth ||
    !uFlash ||
    !uGlyph ||
    !uColors
  ) {
    gl.deleteTexture(glyphTexture);
    gl.deleteBuffer(positionBuffer);
    gl.deleteProgram(program);
    return null;
  }

  const canvasW = gl.drawingBufferWidth;
  const canvasH = gl.drawingBufferHeight;
  const aspect = canvasH > 0 ? canvasW / canvasH : 1;

  gl.uniform2f(uCanvasSize, canvasW, canvasH);
  gl.uniform2f(uGridSize, gridWidth, gridHeight);
  gl.uniform1f(uCharCount, DOT_COUNT);
  gl.uniform1f(uBirth, birthValue);
  gl.uniform1f(uFlash, flashValue);
  gl.uniform1i(uGlyph, 0);
  gl.uniform3fv(uColors, initialColors);
  if (uListening) gl.uniform1f(uListening, 0);
  if (uSpeaking) gl.uniform1f(uSpeaking, 0);
  if (uVoiceEnergy) gl.uniform1f(uVoiceEnergy, 0);
  if (uShowEyes) gl.uniform1f(uShowEyes, 0);
  if (uAspect) gl.uniform1f(uAspect, aspect);

  gl.viewport(0, 0, canvasW, canvasH);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.clearColor(0, 0, 0, 0);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  const phasesArr = new Float32Array(3);

  const render = (
    time: number,
    birth: number,
    flash: number,
    listening = 0,
    speaking = 0,
    voiceEnergy = 0,
    showEyes = false,
  ) => {
    // expo-gl does not preserve GL state between `endFrameEXP()` calls the
    // way browser WebGL does — re-bind program / buffer / texture / viewport
    // every frame, otherwise only the first frame draws and the surface
    // freezes afterwards.
    gl.useProgram(program);

    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.enableVertexAttribArray(aPosition);
    gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, glyphTexture);
    gl.uniform1i(uGlyph, 0);

    gl.viewport(0, 0, canvasW, canvasH);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const u = createAnimationUniforms(gridWidth, gridHeight, time);

    gl.uniform1f(uTime, time);
    gl.uniform1f(uBirth, birth);
    gl.uniform1f(uFlash, flash);
    if (uListening) gl.uniform1f(uListening, listening);
    if (uSpeaking) gl.uniform1f(uSpeaking, speaking);
    if (uVoiceEnergy) gl.uniform1f(uVoiceEnergy, voiceEnergy);
    if (uShowEyes) gl.uniform1f(uShowEyes, showEyes ? 1 : 0);
    if (uPhases) {
      phasesArr[0] = u.w1;
      phasesArr[1] = u.w2;
      phasesArr[2] = u.w3;
      gl.uniform3fv(uPhases, phasesArr);
    }
    if (uEyeOrigin) gl.uniform2f(uEyeOrigin, u.eyeOriginX, u.eyeOriginY);
    if (uEyeBlink) gl.uniform1f(uEyeBlink, u.blink);

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.endFrameEXP();
  };

  const setColors = (next: Float32Array) => {
    gl.useProgram(program);
    gl.uniform3fv(uColors, next);
  };

  const destroy = () => {
    gl.deleteTexture(glyphTexture);
    gl.deleteBuffer(positionBuffer);
    gl.deleteProgram(program);
  };

  return { render, setColors, destroy };
};
