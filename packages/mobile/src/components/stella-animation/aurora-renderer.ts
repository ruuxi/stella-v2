// Renderer for the aurora star variant — the mobile half of the working
// indicator's animation. Mirrors `desktop-ui/src/shell/aurora/renderer.ts`.
//
// Kept separate from `renderer.ts` (the ascii creature) because the star needs
// no glyph atlas, character grid, or eye uniforms — just a screen-space quad
// and the aurora's own uniforms.

import type { ExpoWebGLRenderingContext } from "expo-gl";
import { AURORA_STAR_SPIN_FRAGMENT } from "./aurora-shader";
import { VERTEX_SOURCE, createProgram } from "./shader";

export type AuroraRenderer = {
  render: (
    time: number,
    birth: number,
    flash: number,
    listening?: number,
    speaking?: number,
    voiceEnergy?: number,
  ) => void;
  setColors: (next: Float32Array) => void;
  destroy: () => void;
};

export const initAuroraRenderer = (
  gl: ExpoWebGLRenderingContext,
  initialColors: Float32Array,
  birthValue: number,
  flashValue: number,
): AuroraRenderer | null => {
  const program = createProgram(gl, VERTEX_SOURCE, AURORA_STAR_SPIN_FRAGMENT);
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

  const uCanvasSize = gl.getUniformLocation(program, "u_canvasSize");
  const uTime = gl.getUniformLocation(program, "u_time");
  const uBirth = gl.getUniformLocation(program, "u_birth");
  const uFlash = gl.getUniformLocation(program, "u_flash");
  const uColors = gl.getUniformLocation(program, "u_colors[0]");
  const uListening = gl.getUniformLocation(program, "u_listening");
  const uSpeaking = gl.getUniformLocation(program, "u_speaking");
  const uVoiceEnergy = gl.getUniformLocation(program, "u_voiceEnergy");
  const uAspect = gl.getUniformLocation(program, "u_aspect");

  if (!uCanvasSize || !uTime || !uBirth || !uFlash || !uColors) {
    gl.deleteBuffer(positionBuffer);
    gl.deleteProgram(program);
    return null;
  }

  const canvasW = gl.drawingBufferWidth;
  const canvasH = gl.drawingBufferHeight;
  const aspect = canvasH > 0 ? canvasW / canvasH : 1;

  gl.uniform2f(uCanvasSize, canvasW, canvasH);
  gl.uniform1f(uBirth, birthValue);
  gl.uniform1f(uFlash, flashValue);
  gl.uniform3fv(uColors, initialColors);
  if (uListening) gl.uniform1f(uListening, 0);
  if (uSpeaking) gl.uniform1f(uSpeaking, 0);
  if (uVoiceEnergy) gl.uniform1f(uVoiceEnergy, 0);
  if (uAspect) gl.uniform1f(uAspect, aspect);

  gl.viewport(0, 0, canvasW, canvasH);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.clearColor(0, 0, 0, 0);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  const render = (
    time: number,
    birth: number,
    flash: number,
    listening = 0,
    speaking = 0,
    voiceEnergy = 0,
  ) => {
    // expo-gl does not preserve GL state between `endFrameEXP()` calls the way
    // browser WebGL does — re-bind program / buffer / viewport every frame,
    // otherwise only the first frame draws and the surface freezes afterwards.
    gl.useProgram(program);

    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.enableVertexAttribArray(aPosition);
    gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);

    gl.viewport(0, 0, canvasW, canvasH);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.uniform1f(uTime, time);
    gl.uniform1f(uBirth, birth);
    gl.uniform1f(uFlash, flash);
    if (uListening) gl.uniform1f(uListening, listening);
    if (uSpeaking) gl.uniform1f(uSpeaking, speaking);
    if (uVoiceEnergy) gl.uniform1f(uVoiceEnergy, voiceEnergy);

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
    gl.deleteBuffer(positionBuffer);
    gl.deleteProgram(program);
  };

  return { render, setColors, destroy };
};
