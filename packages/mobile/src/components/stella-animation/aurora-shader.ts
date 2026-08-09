// Aurora orb shader — the mobile half of the working indicator's animation.
//
// GENERATED from packages/desktop-ui/src/shell/aurora/shader.ts (ORB_FRAGMENT).
// The GLSL below is byte-identical to the desktop orb so the two platforms
// render the same creature; edit it THERE and re-copy, never here. Mobile is a
// standalone Expo app with no path alias into desktop-ui, which is why this is
// a copy rather than a shared import (same convention as the other files in
// this directory).
//
// It is plain GLSL ES 1.0 and needs no WebGL2 feature, so it compiles as-is on
// the expo-gl context.

export const AURORA_ORB_FRAGMENT = `
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

  /**
   * Three-octave fbm for the orb. The fourth octave's detail is finer than
   * one screen pixel once the canvas is scaled into the working indicator's
   * 30px slot, so it averages out to flat haze — it costs a
   * noise fetch per sample and *lowers* contrast at the size the orb is
   * actually seen. Dropping it leaves fewer, larger lumps whose motion
   * survives the downscale. The 1.14 factor restores the amplitude the
   * missing octave contributed so the curtain thresholds still line up.
   */
  float fbmCoarse(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
    for (int i = 0; i < 3; i++) {
      v += a * noise(p);
      p = m * p;
      a *= 0.5;
    }
    return v * 1.14;
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

    // Idle fill: the canvas carries EDGE_SCALE (2.5x) of headroom for voice
    // expansion, and the orb's only consumer — the chat working indicator —
    // renders voice-idle, so that headroom is dead margin shrinking the wisp
    // inside its slot. Spending a little of it makes the body large enough
    // for its motion to register at indicator size. Kept at 1.2: measured
    // against the frame fade below, the outer 2% of the canvas stays at zero
    // luminance, so nothing is clipped.
    float radius = u_birth * scale * 1.2;
    radius *= 1.0 + sin(u_time * 1.4) * 0.07 * u_birth;
    float d = dist / max(radius, 0.001);

    // Domain-warped noise — same construction as the website hero. There is
    // deliberately no rigid rotation of the field here: spinning the texture
    // reads as a loading spinner, not as an aurora. Legible motion at
    // indicator size comes from the warp itself — a slow base drift with the
    // warp layers moving faster and against each other, so the curtains
    // churn and the silhouette's lumps morph in place.
    //
    // The field is deliberately coarse (1.8, not the hero's 2.6) and uses
    // the 3-octave fbmCoarse: the orb is seen at 30px, and detail finer
    // than that averages into haze on the way down, taking the visible
    // motion with it.
    float t = u_time * 0.5;
    vec2 p = c * 1.8;
    vec2 flow = vec2(-t * 0.30, t * 0.12);
    vec2 q = vec2(fbmCoarse(p + flow), fbmCoarse(p + flow + vec2(5.2, 1.3)));
    vec2 r = vec2(
      fbmCoarse(p + 2.0 * q + vec2(1.7, 9.2) + flow * 1.8),
      fbmCoarse(p + 2.0 * q + vec2(8.3, 2.8) - flow * 1.5)
    );
    float f = fbmCoarse(p + 2.5 * r);

    // Tighter threshold than the hero's 0.28–0.75: at indicator size the
    // curtains need real contrast to read as distinct moving shapes rather
    // than a soft gradient.
    float curtains = smoothstep(0.34, 0.70, f);
    curtains = pow(curtains, 1.2);

    // Noise-displaced silhouette: the boundary lumps and morphs with the
    // field instead of settling into a defined circle.
    float dd = d * (1.0 + (f - 0.5) * 0.7);

    // Gaussian envelope: wispy noise body over a brighter heart, no hard rim.
    // The flat term is 0.06, below the hero's 0.11: it lights the parts of the
    // body the curtains miss, and over a light theme that even wash composites
    // to grey and reads as a drop shadow behind the wisp rather than as part
    // of it.
    float falloff = exp(-dd * dd * 1.7);
    float core = exp(-dd * dd * 3.2);
    float intensity = (0.06 + curtains) * falloff * 1.25 + core * 0.35;

    // Overall luminance rides one of the warp layers. Brightness is the one
    // channel that stays fully legible when the orb is only tens of pixels
    // across — shape and position changes there are close to sub-pixel — and
    // driving it from the noise keeps the breathing irregular instead of the
    // even sinusoidal throb of a progress widget.
    intensity *= 1.0 + (q.x - 0.5) * 0.5;

    // Pull in the Gaussian's far tail. Left alone it stays faintly visible to
    // the canvas bounds, which over a light background is the grey halo; the
    // fix is not a narrower Gaussian, since shrinking the body takes its
    // motion with it (measured: a tighter falloff costs ~40% of the perceived
    // motion, undoing what makes the indicator read as animated at 30px).
    // This trims only past dd 0.65, where the field is already dim.
    // Ascending edges then inverted — smoothstep with edge0 > edge1 is
    // undefined in GLSL.
    intensity *= 1.0 - smoothstep(0.65, 1.15, dd);

    vec3 coreLift = vec3(0.22) * core * curtains;

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
