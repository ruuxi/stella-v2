export const AURORA_STAR_SPIN_FRAGMENT = `#define STAR_SPIN 1

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

  #define STAR_CYCLE 3.2
  #define STAR_DRIFT_END 0.50
  #define STAR_WIND_END 0.57
  #define STAR_WHIP_END 0.88

  #define FRAME_MARGIN_X 0.03
  #define FRAME_MARGIN_Y 0.03

  #ifdef STAR_SPIN
    #define STAR_SCALE 0.42
    #define STAR_GIRTH 1.55
    #define STAR_FIELD_RATE 1.0
  #else
    #define STAR_SCALE 0.30
    #define STAR_GIRTH 1.0
    #define STAR_FIELD_RATE 2.4
  #endif

  #ifdef STAR_SPIN
    #define STAR_BLUR_TAPS 5
    #define STAR_BLUR_STEP 0.25
    #define STAR_BLUR_NORM 0.2
  #else
    #define STAR_BLUR_TAPS 1
    #define STAR_BLUR_STEP 0.0
    #define STAR_BLUR_NORM 1.0
  #endif

  float starTurn(float t) {
    float u = fract(t / STAR_CYCLE);
    float laps = floor(t / STAR_CYCLE);

    const float driftTurn = 0.125;
    const float windTurn = 0.114;

    const float KNEE = 0.28;
    const float TAIL = 0.34;
    float peakRate = 2.0 / (KNEE + (1.0 - KNEE) * (1.0 + TAIL));
    float exitRate = peakRate * TAIL;

    float turns;
    if (u < STAR_DRIFT_END) {
      float w = u / STAR_DRIFT_END;
      turns = driftTurn * smoothstep(0.0, 1.0, w);
    } else if (u < STAR_WIND_END) {
      float w = (u - STAR_DRIFT_END) / (STAR_WIND_END - STAR_DRIFT_END);

      turns = mix(driftTurn, windTurn, 1.0 - (1.0 - w) * (1.0 - w));
    } else if (u < STAR_WHIP_END) {
      float w = (u - STAR_WIND_END) / (STAR_WHIP_END - STAR_WIND_END);

      float e = w < KNEE
        ? peakRate * w * w / (2.0 * KNEE)
        : peakRate * KNEE * 0.5 + peakRate * (w - KNEE)
          - peakRate * (1.0 - TAIL) * (w - KNEE) * (w - KNEE) / (2.0 * (1.0 - KNEE));
      turns = mix(windTurn, 1.0, e);
    } else {
      float w = (u - STAR_WHIP_END) / (1.0 - STAR_WHIP_END);

      float handoff = (1.0 - windTurn) * exitRate
        / (STAR_WHIP_END - STAR_WIND_END) * (1.0 - STAR_WHIP_END);
      float omega = 6.5;
      float zeta = 2.0;
      turns = 1.0 + (handoff / omega) * exp(-zeta * w) * sin(omega * w);
    }

    return (laps + turns) * 6.2832 + 0.7854;
  }

  float starArm(vec2 p, vec2 dir, float len, float w) {
    float along = dot(p, dir);

    if (along < 0.0 || along > len) return 0.0;
    float across = abs(dot(p, vec2(-dir.y, dir.x)));
    if (across > w + 0.012) return 0.0;
    float t = clamp(along / max(len, 0.001), 0.0, 1.0);
    float halfWidth = w * pow(1.0 - t, 1.7);

    float within = step(0.0, along) * (1.0 - smoothstep(len - 0.012, len, along));
    return within * (1.0 - smoothstep(halfWidth - 0.012, halfWidth + 0.012, across));
  }

  void main() {
    vec2 uv = vec2(gl_FragCoord.x / u_canvasSize.x, 1.0 - gl_FragCoord.y / u_canvasSize.y);
    vec2 c = vec2((uv.x - 0.5) * u_aspect, 0.5 - uv.y);

    float t = u_time;

    float grow = 0.34 + 0.66 * clamp(u_birth, 0.0, 1.0);
    vec2 s = c / (STAR_SCALE * grow);
    float dist = length(s);
    if (dist > 1.9) { gl_FragColor = vec4(0.0); return; }

    vec2 p = s;
    float rad = length(p);

#ifdef STAR_SPIN
    float spin = starTurn(t);

    float sweep = starTurn(t + 0.032) - spin;
    float energy = clamp(abs(sweep) / 0.36, 0.0, 1.0);

    float u = fract(t / STAR_CYCLE);
    float coil = smoothstep(STAR_DRIFT_END - 0.06, STAR_WIND_END, u)
               * (1.0 - smoothstep(STAR_WIND_END, STAR_WIND_END + 0.04, u));
    float breath = 1.0 + 0.035 * sin(t * 1.9) * (1.0 - energy);
    float squash = 1.0 - 0.07 * coil;
    float bulge = 1.0 + 0.12 * coil;
#else

    float spin = 0.7854 + t * 0.40;
    float sweep = 0.0;
    float energy = 0.0;
    float breath = 1.0;
    float squash = 1.0;
    float bulge = 1.0;
#endif

    float sinElev = 0.30;

    float stretchLen = 0.95 * (1.0 + 0.12 * energy) * breath * squash;
    float taperW = 0.20 * STAR_GIRTH * (1.0 - 0.18 * energy) * bulge;
    float horiz = 0.0;
    for (int k = 0; k < STAR_BLUR_TAPS; k++) {
      float a = spin + sweep * (float(k) * STAR_BLUR_STEP - 0.5);
      float ca = cos(a);
      float sa = sin(a);
      vec2 va = vec2(ca, sa * sinElev);
      vec2 vb = vec2(-sa, ca * sinElev);
      float la = length(va);
      float lb = length(vb);
      horiz += max(
        starArm(p, (dot(p, va) < 0.0 ? -va : va) / max(la, 0.001),
                la * stretchLen, taperW * (0.55 + 0.45 * la)),
        starArm(p, (dot(p, vb) < 0.0 ? -vb : vb) / max(lb, 0.001),
                lb * stretchLen, taperW * (0.55 + 0.45 * lb)));
    }
    float shape = horiz * STAR_BLUR_NORM;

    float stretch = (1.0 + 0.05 * energy) * breath * squash;
    shape = max(shape,
      starArm(p, vec2(0.0, 1.0), 1.0 * stretch, 0.19 * STAR_GIRTH * bulge));
    shape = max(shape,
      starArm(p, vec2(0.0, -1.0), 0.95 * stretch, 0.17 * STAR_GIRTH * bulge));
    shape = max(shape, 1.0 - smoothstep(0.105 * STAR_GIRTH, 0.125 * STAR_GIRTH, rad));

    float core = exp(-(rad * rad) / 0.040);

    vec2 cp = p * 2.2;
    vec2 drift = vec2(-t * 0.09, t * 0.05) * STAR_FIELD_RATE;
    vec2 q = vec2(fbmCoarse(cp + drift), fbmCoarse(cp + drift + vec2(5.2, 1.3)));
    vec2 r = vec2(
      fbmCoarse(cp + 2.0 * q + vec2(1.7, 9.2) + drift * 2.6),
      fbmCoarse(cp + 2.0 * q + vec2(8.3, 2.8) - drift * 2.1)
    );
    float f = fbmCoarse(cp + 2.5 * r);
    float curtains = smoothstep(0.28, 0.72, f);

    float intensity = shape * (0.82 + 0.18 * curtains);

#ifdef STAR_SPIN
    float trail = clamp(abs(spin - starTurn(t - 0.14)) / 0.9, 0.0, 1.0);
#else
    float trail = 0.0;
#endif
    intensity *= 1.0 + 0.12 * energy;

    intensity += exp(-rad * 2.4) * (0.11 + 0.09 * trail) * curtains;

    vec3 coreLift = vec3(0.16) * curtains * shape
                  + vec3(0.22 + 0.12 * trail) * core;

    float height = 0.5 + p.y * 0.5;
    float hueAxis = clamp(height / 0.68 + (q.x - 0.5) * 0.38, 0.0, 1.0);

    if (u_listening > 0.01) {
      float rings = sin(dist * 20.0 + u_time * 5.0) * 0.5 + 0.5;
      rings *= smoothstep(0.5, 0.1, dist);
      intensity += rings * u_listening * 0.3;
      intensity *= 1.0 + u_voiceEnergy * u_listening * 0.8;
    }

    if (u_speaking > 0.01) {
      float waves = sin(dist * 10.0 - u_time * 8.0) * 0.5 + 0.5;
      waves *= smoothstep(1.2, 0.1, dist) * u_voiceEnergy;
      intensity += waves * u_speaking * 0.4;
      intensity *= 1.0 + u_speaking * u_voiceEnergy * 0.4;
    }

    intensity *= sqrt(clamp(u_birth, 0.0, 1.0));
    intensity = clamp(intensity, 0.0, 1.0);

    float hue = clamp(hueAxis * 0.92 + 0.04 + 0.28 * (r.y - 0.5), 0.0, 1.0);
    vec3 col = ramp(hue);
    col += coreLift;

    float waveRadius = (1.0 - u_flash) * 1.8;
    float waveIntensity = smoothstep(0.3, 0.0, abs(dist - waveRadius)) * u_flash;
    col *= 1.0 + waveIntensity * 2.0;

    #ifndef FRAME_MARGIN_X
      #define FRAME_MARGIN_X 0.10
      #define FRAME_MARGIN_Y 0.08
    #endif
    float frame = smoothstep(0.0, FRAME_MARGIN_X, uv.x)
                * smoothstep(1.0, 1.0 - FRAME_MARGIN_X, uv.x)
                * smoothstep(0.0, FRAME_MARGIN_Y, uv.y)
                * smoothstep(1.0, 1.0 - FRAME_MARGIN_Y, uv.y);

    float alpha = clamp(intensity * 1.35 * frame, 0.0, 0.96);
    gl_FragColor = vec4(col, alpha);
  }
`;
