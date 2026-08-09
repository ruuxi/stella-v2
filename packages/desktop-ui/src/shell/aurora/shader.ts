const compileShader = (
  gl: WebGLRenderingContext,
  type: number,
  source: string,
) => {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
};

export const createProgram = (
  gl: WebGLRenderingContext,
  vs: string,
  fs: string,
) => {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vs);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fs);
  if (!vertexShader || !fragmentShader) return null;

  const program = gl.createProgram();
  if (!program) return null;

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);

  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }

  return program;
};

export const getVertexShader = (): string => `
  attribute vec2 a_position;
  void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

/**
 * Two renderings of the stella-website hero aurora (domain-warped FBM
 * noise over the brand teal→cyan→violet→rose ramp):
 *
 * - `"waves"` — soft horizontal aurora ribbons undulating across the
 *   canvas, the friendlier read of the site's flowing curtains. Used by
 *   onboarding.
 * - `"orb"` — the aurora folded into a nebula orb with a noise-carved
 *   silhouette. Moodier; used by the chat working indicator.
 */
export type AuroraVariant = "orb" | "waves";

/**
 * Shared shader prelude: uniforms, the site hero's hash/noise/fbm chain,
 * and the five-stop color ramp fed from CSS (see StellaAnimation.css).
 */
const FRAGMENT_PRELUDE = `
  precision mediump float;

  uniform vec2 u_canvasSize;
  uniform float u_time;
  uniform float u_birth;
  uniform float u_flash;
  uniform float u_listening;
  uniform float u_speaking;
  uniform float u_voiceEnergy;
  uniform float u_aspect;
  uniform vec3 u_colors[5];

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 345.45));
    p += dot(p, p + 34.345);
    return fract(p.x * p.y);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
    for (int i = 0; i < 4; i++) {
      v += a * noise(p);
      p = m * p;
      a *= 0.5;
    }
    return v;
  }

  vec3 ramp(float t) {
    float pos = clamp(t, 0.0, 1.0) * 4.0;
    float ci = floor(min(pos, 3.0));
    float cf = smoothstep(0.0, 1.0, pos - ci);
    vec3 color;
    if (ci < 1.0) {
      color = mix(u_colors[0], u_colors[1], cf);
    } else if (ci < 2.0) {
      color = mix(u_colors[1], u_colors[2], cf);
    } else if (ci < 3.0) {
      color = mix(u_colors[2], u_colors[3], cf);
    } else {
      color = mix(u_colors[3], u_colors[4], cf);
    }
    return color;
  }
`;

/**
 * Shared main() epilogue: voice overlays (listening rings / speaking
 * waves), the birth fade, the vertical hue ramp, and the flash wave.
 * Expects \`dist\`, \`uv\`, \`r\`, and \`intensity\` in scope, plus a
 * \`coreLift\` term added to the color for inner luminosity.
 */
const FRAGMENT_EPILOGUE = `
    // Voice: listening — inward-flowing rings, energy pulses brightness.
    if (u_listening > 0.01) {
      float rings = sin(dist * 20.0 + u_time * 5.0) * 0.5 + 0.5;
      rings *= smoothstep(0.5, 0.1, dist);
      intensity += rings * u_listening * 0.3;
      intensity *= 1.0 + u_voiceEnergy * u_listening * 0.8;
    }

    // Voice: speaking — outward-flowing waves scaled by output energy.
    if (u_speaking > 0.01) {
      float waves = sin(dist * 10.0 - u_time * 8.0) * 0.5 + 0.5;
      waves *= smoothstep(1.2, 0.1, dist) * u_voiceEnergy;
      intensity += waves * u_speaking * 0.4;
      intensity *= 1.0 + u_speaking * u_voiceEnergy * 0.4;
    }

    // Birth: material fades in as the aurora grows.
    intensity *= sqrt(clamp(u_birth, 0.0, 1.0));
    intensity = clamp(intensity, 0.0, 1.0);

    // Hue: vertical ramp warped by the noise field — the website hero's
    // identity (teal low, rose high).
    float hue = clamp((1.0 - uv.y) * 0.92 + 0.04 + 0.28 * (r.y - 0.5), 0.0, 1.0);
    vec3 col = ramp(hue);
    col += coreLift;

    // Flash: expanding brightness wave from center outward.
    float waveRadius = (1.0 - u_flash) * 1.8;
    float waveIntensity = smoothstep(0.3, 0.0, abs(dist - waveRadius)) * u_flash;
    col *= 1.0 + waveIntensity * 2.0;

    // Soft frame fade — noise-displaced silhouettes and voice overlays can
    // reach the canvas bounds, so fade out before every edge; without this
    // the aurora clips flat wherever a lump crosses the backing rectangle.
    float frame = smoothstep(0.0, 0.10, uv.x) * smoothstep(1.0, 0.90, uv.x)
                * smoothstep(0.0, 0.08, uv.y) * smoothstep(1.0, 0.92, uv.y);

    float alpha = clamp(intensity * 1.35 * frame, 0.0, 0.96);
    gl_FragColor = vec4(col, alpha);
  }
`;

const ORB_FRAGMENT = `${FRAGMENT_PRELUDE}
  void main() {
    vec2 uv = vec2(gl_FragCoord.x / u_canvasSize.x, 1.0 - gl_FragCoord.y / u_canvasSize.y);
    vec2 c = (uv - 0.5) * 1.2;
    c.x *= u_aspect;
    float dist = length(c) * 2.0;

    // Early out — pixels far outside the orb are always transparent.
    if (dist > 2.0) { gl_FragColor = vec4(0.0); return; }

    // Voice-driven radius: contract when listening, swell when speaking,
    // plus a slow idle breath.
    float scale = 1.0 - u_listening * 0.22
                + u_speaking * 0.10 + u_speaking * u_voiceEnergy * 0.14;
    float radius = u_birth * scale;
    radius *= 1.0 + sin(u_time * 1.4) * 0.05 * u_birth;
    float d = dist / max(radius, 0.001);

    // Slow swirl of the whole noise field. The drift alone is sub-pixel
    // when the orb renders small (the chat working indicator), so rotate
    // the texture to keep the motion legible at any size.
    float swirl = u_time * 0.25;
    vec2 cr = mat2(cos(swirl), -sin(swirl), sin(swirl), cos(swirl)) * c;

    // Domain-warped noise — same construction as the website hero.
    float t = u_time * 0.35;
    vec2 p = cr * 2.6;
    vec2 flow = vec2(-t * 0.55, t * 0.22);
    vec2 q = vec2(fbm(p + flow), fbm(p + flow + vec2(5.2, 1.3)));
    vec2 r = vec2(
      fbm(p + 2.0 * q + vec2(1.7, 9.2) + flow * 0.5),
      fbm(p + 2.0 * q + vec2(8.3, 2.8) - flow * 0.4)
    );
    float f = fbm(p + 2.5 * r);

    float curtains = smoothstep(0.28, 0.75, f);
    curtains = pow(curtains, 1.2);

    // Noise-displaced silhouette: the boundary lumps and morphs with the
    // field instead of settling into a defined circle.
    float dd = d * (1.0 + (f - 0.5) * 0.7);

    // Gaussian envelope: wispy noise body over a brighter heart, no hard rim.
    float falloff = exp(-dd * dd * 1.7);
    float core = exp(-dd * dd * 3.2);
    float intensity = (0.11 + curtains) * falloff * 1.25 + core * 0.35;

    vec3 coreLift = vec3(0.22) * core * curtains;
${FRAGMENT_EPILOGUE}`;

const WAVES_FRAGMENT = `${FRAGMENT_PRELUDE}
  void main() {
    vec2 uv = vec2(gl_FragCoord.x / u_canvasSize.x, 1.0 - gl_FragCoord.y / u_canvasSize.y);
    vec2 c = (uv - 0.5) * 1.2;
    c.x *= u_aspect;
    float dist = length(c) * 2.0;

    // Early out — pixels far outside the aurora are always transparent.
    if (dist > 2.0) { gl_FragColor = vec4(0.0); return; }

    // Voice-driven scale: contract when listening, swell when speaking,
    // plus a slow idle breath.
    float scale = 1.0 - u_listening * 0.22
                + u_speaking * 0.10 + u_speaking * u_voiceEnergy * 0.14;
    float radius = u_birth * scale;
    radius *= 1.0 + sin(u_time * 1.4) * 0.03 * u_birth;
    vec2 s = c * 2.0 / max(radius, 0.001);

    // Domain-warped noise — same construction as the website hero.
    float t = u_time * 0.35;
    vec2 p = vec2(s.x * 2.0, s.y * 0.8);
    vec2 flow = vec2(-t * 0.55, t * 0.22);
    vec2 q = vec2(fbm(p + flow), fbm(p + flow + vec2(5.2, 1.3)));
    vec2 r = vec2(
      fbm(p + 2.0 * q + vec2(1.7, 9.2) + flow * 0.5),
      fbm(p + 2.0 * q + vec2(8.3, 2.8) - flow * 0.4)
    );
    float f = fbm(p + 2.5 * r);

    // Curtain texture only modulates brightness along the ribbons — it
    // never carves dark holes, which is what keeps this variant friendly.
    float curtains = smoothstep(0.30, 0.78, f);
    float tex = 0.45 + 0.55 * curtains;

    // Three soft ribbons undulating horizontally, each displaced by the
    // warped noise so the waves stay organic.
    float wave1 = sin(s.x * 2.2 + u_time * 0.9) * 0.22 + (r.y - 0.5) * 0.3;
    float d1 = s.y - wave1;
    float rib1 = exp(-d1 * d1 * 28.0);
    float wave2 = sin(s.x * 1.6 - u_time * 0.7 + 1.7) * 0.24 - 0.55 + (r.x - 0.5) * 0.25;
    float d2 = s.y - wave2;
    float rib2 = exp(-d2 * d2 * 22.0);
    float wave3 = sin(s.x * 1.9 + u_time * 0.55 + 3.4) * 0.22 + 0.55 + (q.y - 0.5) * 0.25;
    float d3 = s.y - wave3;
    float rib3 = exp(-d3 * d3 * 24.0);

    float horiz = smoothstep(1.25, 0.5, abs(s.x));
    float glow = exp(-(s.x * s.x * 0.7 + s.y * s.y * 1.4)) * 0.10;
    float intensity = (rib1 + rib2 * 0.8 + rib3 * 0.65) * tex * horiz + glow;

    vec3 coreLift = vec3(0.8) * glow;
${FRAGMENT_EPILOGUE}`;

export const getFragmentShader = (variant: AuroraVariant = "orb"): string =>
  variant === "waves" ? WAVES_FRAGMENT : ORB_FRAGMENT;
