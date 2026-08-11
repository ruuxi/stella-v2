// Aurora star shader — the mobile half of the working indicator's animation.
//
// GENERATED: this is exactly what desktop's `getFragmentShader("star-spin")`
// returns, byte for byte, so the two platforms render the same star. Edit it in
// packages/desktop-ui/src/shell/aurora/shader.ts and re-copy — never here.
// `aurora-shader-parity.test.ts` fails if the two drift apart.
//
// Mobile is a standalone Expo app with no path alias into desktop-ui, which is
// why this is a copy rather than a shared import (same convention as the other
// files in this directory).
//
// The leading `#define` is how desktop picks the spinning star over the still
// one; the `#ifdef STAR_SPIN` blocks below are compiled out either way. It is
// plain GLSL ES 1.0 and needs no WebGL2 feature, so it compiles as-is on the
// expo-gl context.

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

  /**
   * Three-octave fbm for the star. The fourth octave's detail is finer than
   * one screen pixel once the canvas is scaled into the working indicator's
   * 30px slot, so it averages out to flat haze — it costs a
   * noise fetch per sample and *lowers* contrast at the size the star is
   * actually seen there. Dropping it leaves fewer, larger lumps whose motion
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

  /* Beat boundaries as fractions of one cycle, shared between the turn and the
   * secondary action that has to stay in step with it. */
  #define STAR_CYCLE 3.2
  #define STAR_DRIFT_END 0.50
  #define STAR_WIND_END 0.57
  #define STAR_WHIP_END 0.88

  /* STAR_SPIN, defined by getFragmentShader for the "star-spin" variant, is what
   * separates the two surfaces this shader serves. With it, the staged turn and
   * all of its secondary action run. Without it, the star turns slowly at a
   * constant rate and the aurora inside carries more of the motion, so its field
   * is given a faster drift. */
  /* The star's arms end at known lengths, so it can hug its canvas far more
   * closely than a noise-carved field can. STAR_SCALE 0.42 plus the whip's 12%
   * stretch puts the longest arm at 0.47 of the canvas half-width, just inside
   * this margin. */
  #define FRAME_MARGIN_X 0.03
  #define FRAME_MARGIN_Y 0.03

  /* Spinning, the star is seen in a 30px slot: it needs most of its canvas and
   * arms with enough girth to survive the downscale, or it reads as a speck. At
   * onboarding size neither is true — there, thick arms would coarsen a shape
   * that has 420px to be delicate in. */
  #ifdef STAR_SPIN
    #define STAR_SCALE 0.42
    #define STAR_GIRTH 1.55
    #define STAR_FIELD_RATE 1.0
  #else
    #define STAR_SCALE 0.30
    #define STAR_GIRTH 1.0
    #define STAR_FIELD_RATE 2.4
  #endif

  /* How many instants the arms are sampled at per frame, and the weights that
   * average them (see the blur loop in main). The still star turns about a
   * sixth of a degree per frame, so its five taps land on top of one another —
   * one tap is the identical picture for a fifth of the wedge work. */
  #ifdef STAR_SPIN
    #define STAR_BLUR_TAPS 5
    #define STAR_BLUR_STEP 0.25
    #define STAR_BLUR_NORM 0.2
  #else
    #define STAR_BLUR_TAPS 1
    #define STAR_BLUR_STEP 0.0
    #define STAR_BLUR_NORM 1.0
  #endif

  /**
   * The turn, in radians at time t. One revolution per cycle, staged the way an
   * animator would stage it rather than run at a rate:
   *
   *   drift        an eighth of a turn, eased in and eased out. It leaves the
   *                landing at rest, gathers a little, and slows to almost
   *                nothing again before the wind-up. Nothing here moves at a
   *                constant rate — a constant rate is the one thing that always
   *                reads as a mechanism instead of a performance.
   *   anticipation a few degrees *backwards*, taken quickly and then held at the
   *                extreme. The wind-up is what tells the eye something is about
   *                to happen, and the hold is what makes it feel loaded.
   *   whip         the remaining seven eighths, snapping to peak speed in the
   *                first third of the beat and gliding down over the rest. Hit
   *                it hard, ride it out: that asymmetry is the difference
   *                between a whip and a swing. It arrives at the mark still
   *                moving — see TAIL — because a fast action that decelerates
   *                to exactly zero reads as a freeze, however smooth the curve
   *                into it was.
   *   landing      a spring handed that leftover speed. The overshoot is what
   *                the momentum does, not a pose it was told to hit; then it
   *                rings back through the mark, once more smaller, and is spent
   *                by the end of the cycle. A slide onto the mark has no weight;
   *                a bounce does.
   *
   * Every boundary meets with matching speed on both sides, so five beats read
   * as one continuous action rather than five spliced ones.
   */
  float starTurn(float t) {
    float u = fract(t / STAR_CYCLE);
    float laps = floor(t / STAR_CYCLE);

    // Revolutions reached at the end of the drift and at the bottom of the
    // wind-up. The whip finishes the revolution; the landing rings about it.
    const float driftTurn = 0.125;
    const float windTurn = 0.114;

    // The whip's velocity: a linear ramp to peak at KNEE, then a linear fall to
    // TAIL of peak. peakRate scales that so the beat covers exactly the angle it
    // has to, which makes exitRate — the speed still on the star when it reaches
    // the mark — a derived quantity rather than a second thing to keep in sync.
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
      // Quadratic ease out: straight into the wind-up, then decelerating into a
      // hold at the extreme. The whip's own slow start extends that hold.
      turns = mix(driftTurn, windTurn, 1.0 - (1.0 - w) * (1.0 - w));
    } else if (u < STAR_WHIP_END) {
      float w = (u - STAR_WIND_END) / (STAR_WHIP_END - STAR_WIND_END);
      // Integral of that velocity: two parabolas joined at KNEE with matching
      // slope, so the acceleration has no seam in it.
      float e = w < KNEE
        ? peakRate * w * w / (2.0 * KNEE)
        : peakRate * KNEE * 0.5 + peakRate * (w - KNEE)
          - peakRate * (1.0 - TAIL) * (w - KNEE) * (w - KNEE) / (2.0 * (1.0 - KNEE));
      turns = mix(windTurn, 1.0, e);
    } else {
      float w = (u - STAR_WHIP_END) / (1.0 - STAR_WHIP_END);
      // Damped spring released from the mark at the whip's exit speed, converted
      // into this beat's own units. Frequency and damping are set so it rings
      // about once and has all but spent itself by the end of the cycle, which is
      // what lets the drift pick up from near rest.
      float handoff = (1.0 - windTurn) * exitRate
        / (STAR_WHIP_END - STAR_WIND_END) * (1.0 - STAR_WHIP_END);
      float omega = 6.5;
      float zeta = 2.0;
      turns = 1.0 + (handoff / omega) * exp(-zeta * w) * sin(omega * w);
    }
    // Every cycle is exactly one revolution, so the pose it rests on is the pose
    // it started from — and this offset moves both. At an eighth turn the four
    // arms sit evenly on the diagonals, all four the same length, rather than two
    // stretched flat across the horizontal with the other two foreshortened into
    // stubs. It is the symmetrical pose of the set, so it is the one to rest on.
    return (laps + turns) * 6.2832 + 0.7854;
  }

  /**
   * One arm of the star: a wedge running from the core along dir out to a point
   * at len, w half-wide at the base. Its sides are drawn rather than faded —
   * coverage is flat inside the arm and falls to zero across about a pixel and
   * a half at the boundary, so the arm has an edge you can see instead of a haze
   * trailing off. The slightly-more-than-linear taper bows those sides inward,
   * which is what makes the silhouette read as a star point rather than a
   * triangle.
   */
  float starArm(vec2 p, vec2 dir, float len, float w) {
    float along = dot(p, dir);
    // Reject against the arm's bounding slab before shaping it. A star is
    // mostly gaps, so the overwhelming majority of pixels are outside the
    // overwhelming majority of arms, and everything below — a pow and two
    // smoothsteps — is the expensive half of this function. Both bounds are
    // exactly where the terms below reach zero on their own (the taper only
    // ever narrows w, so nothing wider than w + the edge can be inside any
    // arm), so this rejects only what was already being drawn as nothing.
    if (along < 0.0 || along > len) return 0.0;
    float across = abs(dot(p, vec2(-dir.y, dir.x)));
    if (across > w + 0.012) return 0.0;
    float t = clamp(along / max(len, 0.001), 0.0, 1.0);
    float halfWidth = w * pow(1.0 - t, 1.7);
    // Ending the arm is a separate cut from tapering it. Past the tip the
    // taper leaves zero width, and a zero-width wedge still reports half
    // coverage along its own centre line — which draws a hairline running off
    // the point to the edge of the canvas.
    float within = step(0.0, along) * (1.0 - smoothstep(len - 0.012, len, along));
    return within * (1.0 - smoothstep(halfWidth - 0.012, halfWidth + 0.012, across));
  }

  void main() {
    vec2 uv = vec2(gl_FragCoord.x / u_canvasSize.x, 1.0 - gl_FragCoord.y / u_canvasSize.y);
    vec2 c = vec2((uv.x - 0.5) * u_aspect, 0.5 - uv.y);

    float t = u_time;

    // Birth grows the star rather than fading it in: the canvas is fixed, so
    // zooming the star's frame is what makes it arrive small and settle.
    float grow = 0.34 + 0.66 * clamp(u_birth, 0.0, 1.0);
    vec2 s = c / (STAR_SCALE * grow);
    float dist = length(s);
    if (dist > 1.9) { gl_FragColor = vec4(0.0); return; }

    // The axis is fixed upright, so the star's frame is the canvas frame.
    vec2 p = s;
    float rad = length(p);

#ifdef STAR_SPIN
    float spin = starTurn(t);
    // How far the turn carries in one frame, and how hard it is working. 0.032 is
    // about one frame at 30fps in shader time, which is why the working indicator
    // asks for 30fps at an unscaled clock — at any other pairing the smear below
    // stops matching the distance actually covered between frames.
    float sweep = starTurn(t + 0.032) - spin;
    float energy = clamp(abs(sweep) / 0.36, 0.0, 1.0);

    // Secondary action for the slow beats. A hold that is perfectly still reads
    // as a freeze, not as a pause, so through the drift the whole figure breathes
    // — the moving hold that keeps it alive while the turn is barely moving. Then
    // it compresses through the wind-up: the squash that the whip's stretch
    // answers, so the two beats belong to one action.
    float u = fract(t / STAR_CYCLE);
    float coil = smoothstep(STAR_DRIFT_END - 0.06, STAR_WIND_END, u)
               * (1.0 - smoothstep(STAR_WIND_END, STAR_WIND_END + 0.04, u));
    float breath = 1.0 + 0.035 * sin(t * 1.9) * (1.0 - energy);
    float squash = 1.0 - 0.07 * coil;
    float bulge = 1.0 + 0.12 * coil;
#else
    // A slow, constant turn from the resting pose. Constant is the point: this
    // surface is a welcome screen, not a progress report, so there is no action
    // to stage and nothing for an ease to be the ease of. What the eye gets is
    // the arms cycling through their foreshortening, which at this rate is a
    // drift rather than a spin.
    //
    // Around a sixth of a degree per frame, so there is nothing to smear and no
    // speed for the stretch to answer: the blur collapses to a single tap and
    // breath, squash and stretch all resolve to unity.
    float spin = 0.7854 + t * 0.40;
    float sweep = 0.0;
    float energy = 0.0;
    float breath = 1.0;
    float squash = 1.0;
    float bulge = 1.0;
#endif

    // The four arms standing horizontally, turning about the vertical. sinElev
    // is the camera's height above the star's equator: it is what stops an arm
    // swinging away from us from collapsing to nothing.
    float sinElev = 0.30;

    // Motion blur, and it is not decoration: at the peak of the whip the arms
    // cover about 24 degrees per frame, and with four of them ninety degrees
    // apart that is a third of the way to the next identical pose — sampled at
    // one instant per frame the whip strobes instead of moving. Averaging the
    // arms across the angle they sweep during the frame is what a fast pass
    // looks like on film, and it costs nothing when the star is crawling because
    // the taps then all land in the same place.
    //
    // Only two of the four are ever worth asking about. Arms two apart point in
    // opposite directions, and length is symmetric, so a pair is one wedge and
    // its mirror at the same size — whichever of the two faces away from this
    // pixel contributes nothing to the union. Folding each pair onto the half
    // the pixel is actually on halves the wedge evaluations and takes three of
    // every four sin/cos with them.
    //
    // Stretch: the arms draw out along the direction of travel and thin across
    // it while the star is moving, and recover as it settles. A foreshortened
    // arm also keeps its width in principle, but at this length it would be a
    // wedge wider than it is long, so narrow it with the foreshortening too.
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

    // The axis itself, plus a small hub so the arms meet in a body instead of
    // crossing at a seam. Unioned rather than summed: where two arms overlap the
    // star must not brighten, or the shape dissolves back into a glow.
    float stretch = (1.0 + 0.05 * energy) * breath * squash;
    shape = max(shape,
      starArm(p, vec2(0.0, 1.0), 1.0 * stretch, 0.19 * STAR_GIRTH * bulge));
    shape = max(shape,
      starArm(p, vec2(0.0, -1.0), 0.95 * stretch, 0.17 * STAR_GIRTH * bulge));
    shape = max(shape, 1.0 - smoothstep(0.105 * STAR_GIRTH, 0.125 * STAR_GIRTH, rad));

    float core = exp(-(rad * rad) / 0.040);

    // Aurora inside the star, dissolving in place. Sampling this field in polar
    // coordinates with the spin folded into the angle is what made the colours
    // wheel around like a dial; addressed in the star's own plane instead, with
    // only a slow base drift, the motion comes from the domain warp — the two
    // warp layers travel faster than the base and against each other, so the
    // curtains fold through one another and remix where they are rather than
    // going anywhere.
    vec2 cp = p * 2.2;
    vec2 drift = vec2(-t * 0.09, t * 0.05) * STAR_FIELD_RATE;
    vec2 q = vec2(fbmCoarse(cp + drift), fbmCoarse(cp + drift + vec2(5.2, 1.3)));
    vec2 r = vec2(
      fbmCoarse(cp + 2.0 * q + vec2(1.7, 9.2) + drift * 2.6),
      fbmCoarse(cp + 2.0 * q + vec2(8.3, 2.8) - drift * 2.1)
    );
    float f = fbmCoarse(cp + 2.5 * r);
    float curtains = smoothstep(0.28, 0.72, f);

    // Now that the silhouette is drawn rather than carved, the field must not be
    // allowed to eat the edge. It varies the light *within* the shape instead:
    // a little in alpha for depth, the rest as an additive lift, which
    // brightens without thinning. The star holds its outline and the aurora
    // moves through it.
    float intensity = shape * (0.82 + 0.18 * curtains);
    // The pass carries a flare, and the bloom around it answers late: sampling
    // the turn a moment in the past gives a glow that peaks after the whip has
    // gone by rather than with it. Light lagging the thing that caused it is what
    // stops the two halves of the action reading as one rigid unit.
#ifdef STAR_SPIN
    float trail = clamp(abs(spin - starTurn(t - 0.14)) / 0.9, 0.0, 1.0);
#else
    float trail = 0.0;
#endif
    intensity *= 1.0 + 0.12 * energy;
    // Ambient bloom so the star sits in light rather than on the background.
    intensity += exp(-rad * 2.4) * (0.11 + 0.09 * trail) * curtains;

    vec3 coreLift = vec3(0.16) * curtains * shape
                  + vec3(0.22 + 0.12 * trail) * core;
    // The ramp runs the height of the star — teal at the bottom point, rose at
    // the top, matching the brand mark's own gradient — but weighted upward.
    // Spread evenly the rose only arrived inside the top arm; dividing the
    // height by 0.68 lands the end of the ramp just above the middle, so the
    // rose reaches down into the body of the star while still leaving the upper
    // half a gradient rather than one flat colour.
    //
    // The warp layer pushes the ramp around as well as the epilogue's own
    // jitter: two independent wanders on the same ramp is what makes
    // neighbouring colours bleed into each other instead of holding tidy bands.
    float height = 0.5 + p.y * 0.5;
    float hueAxis = clamp(height / 0.68 + (q.x - 0.5) * 0.38, 0.0, 1.0);

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

    // Hue: ramp along hueAxis, warped by the noise field — the website
    // hero's identity (teal low, rose high).
    float hue = clamp(hueAxis * 0.92 + 0.04 + 0.28 * (r.y - 0.5), 0.0, 1.0);
    vec3 col = ramp(hue);
    col += coreLift;

    // Flash: expanding brightness wave from center outward.
    float waveRadius = (1.0 - u_flash) * 1.8;
    float waveIntensity = smoothstep(0.3, 0.0, abs(dist - waveRadius)) * u_flash;
    col *= 1.0 + waveIntensity * 2.0;

    // Soft frame fade — noise-displaced silhouettes and voice overlays can
    // reach the canvas bounds, so fade out before every edge; without this
    // the aurora clips flat wherever a lump crosses the backing rectangle.
    //
    // The margin is a variant's to override. A field that the noise can push
    // anywhere needs a generous one; a variant whose silhouette is bounded
    // analytically knows exactly how far it reaches, and for that one the
    // default margin is dead space it has to shrink itself to fit inside.
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
