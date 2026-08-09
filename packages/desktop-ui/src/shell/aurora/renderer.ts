import {
  createProgram,
  getFragmentShader,
  getVertexShader,
  type AuroraVariant,
} from "./shader";

type GlRenderer = {
  render: (
    time: number,
    birth: number,
    flashValue: number,
    listening?: number,
    speaking?: number,
    voiceEnergy?: number,
  ) => void;
  setColors: (next: Float32Array) => void;
  destroy: () => void;
};

export const initRenderer = (
  targetCanvas: HTMLCanvasElement,
  colors: Float32Array,
  birthValue: number,
  flashValue: number,
  variant: AuroraVariant = "orb",
): GlRenderer | null => {
  const gl =
    (targetCanvas.getContext("webgl", {
      alpha: true,
      premultipliedAlpha: false,
    }) as WebGLRenderingContext | null) ||
    (targetCanvas.getContext(
      "experimental-webgl",
    ) as WebGLRenderingContext | null);
  if (!gl) return null;

  const program = createProgram(
    gl,
    getVertexShader(),
    getFragmentShader(variant),
  );
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

  const canvasW = targetCanvas.width;
  const canvasH = targetCanvas.height;
  const aspect = canvasH > 0 ? canvasW / canvasH : 1;

  gl.uniform2f(uCanvasSize, canvasW, canvasH);
  gl.uniform1f(uBirth, birthValue);
  gl.uniform1f(uFlash, flashValue);
  gl.uniform3fv(uColors, colors);
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
    gl.uniform1f(uTime, time);
    gl.uniform1f(uBirth, birth);
    gl.uniform1f(uFlash, flash);
    if (uListening) gl.uniform1f(uListening, listening);
    if (uSpeaking) gl.uniform1f(uSpeaking, speaking);
    if (uVoiceEnergy) gl.uniform1f(uVoiceEnergy, voiceEnergy);

    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  };

  const setColors = (next: Float32Array) => {
    gl.uniform3fv(uColors, next);
  };

  const destroy = () => {
    gl.deleteBuffer(positionBuffer);
    gl.deleteProgram(program);
  };

  return { render, setColors, destroy };
};
