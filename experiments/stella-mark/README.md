# stella-mark

Stella's character mark: the six-ray brand star, with a face, rigged for
motion. Standalone prototype — nothing here is imported by the app.

```
geometry.js    path flattening, radial resampling, ring lerp, face fitting
shapes.js      the silhouettes, all derived from the shipping brand star
eyes.js        procedural eye poses (no authored point data)
stella-mark.js the rig: states, activities, springs, the rAF loop
demo.html      built playground — open it in a browser
build.mjs      inlines the modules into demo.html so it runs from file://
```

No dependencies, no framework, no build step for the modules themselves —
`build.mjs` exists only so the demo is a single file.

```js
import { createStellaMark } from "./stella-mark.js";

const mark = createStellaMark(el, { size: 28, state: "idle" });
mark.setState("thinking");
mark.setShape("brand");   // morphs; does not swap assets
mark.sparkle(18);
mark.destroy();
```

## Where it came from

The architecture is lifted from Grok Bot's character rig (`Grok Bot.app` 0.29.0,
`dist/renderer/assets/index-*.js`): render the SVG once, then run a single rAF
loop that writes `d` / `transform` / `opacity` onto a fixed pool of nodes.
Springs integrate at a fixed 1/120 s substep with `dt` clamped to 0.1 s. Every
morphable outline is 96 points sampled on 96 rays from the centre, so any shape
lerps into any other and re-emits as one closed Catmull-Rom path. The thinking
indicator is their three-slot Gaussian bounce — 1400 ms, σ 0.15, phase offset
0.119 — with the character itself as the middle dot.

## Where it differs

**The silhouette is derived from the logo, not drawn.** `packages/mobile/src/
components/WorkingStar.tsx` already ships a six-ray star, but it is not a tidy
six: the vertical pair runs to 1.0 while the four side rays reach 0.54–0.64,
and those four sit in two close pairs ~37° apart instead of evenly around the
circle. At logo size that is an aurora flare. At 24 px with a face in it, the
long pair dominates and the close pairs merge into horizontal arms — it reads
as a kite. So `starProfile()` rebuilds the profile from the logo's own ray set
with four knobs:

| knob      | character | what it does                                       |
| --------- | --------- | -------------------------------------------------- |
| `balance` | 0.94      | evens out ray heights (1 = all six the same length) |
| `even`    | 1         | evens out ray angles (1 = one ray every 60°)        |
| `core`    | 0.46      | radius of the body a ray grows from                 |
| `gamma`   | 1.15      | ray taper; >1 pointy, <1 fat and plush              |

`puff` crossfades the result against the untouched logo, so `puff: 0` is still
exactly the shipping mark — which is what lets the rig morph between the
character and the brand mark rather than keeping two assets in sync.

**The star stays a star.** Grok collapses its blob to a dot for all fourteen of
its activities. Here only `thinking` does. A star has rays worth animating, so
`working` runs a light wave around them (`twinkle`) instead.

**`loading` is a squeeze, not a spin.** A Y-axis coin-flip is the obvious motion
for a mark, and it is wrong for this one — a flip only reads on a shape whose
silhouette is roughly the same at every angle. A six-ray star at 40° is a
different star, and at 90° it is a stick; no amount of perspective, extrusion or
shading rescues that. `squeeze` takes the opposite bet: it deforms the
silhouette deliberately and never stops being a star. A band of compression
travels bottom to top over `SQ_CYCLE`, the waist pinching at the band while the
material ahead of it swells and rides upward, with a light sweep clipped to the
body riding along and the whole star stretching slightly as the band crosses the
middle. `SQ_TIP_RELIEF` eases the pinch off toward the tips, because a ray is
thin to begin with and squeezing it fully turns it into a needle that reads as a
rendering glitch. `SQ_FACE_GIVE` makes the eyes deform less than the body around
them, so the face stays legible through the pass. The band starts and ends
outside the body (`SQ_TRAVEL` > 1) so the loop has a beat of rest rather than a
seam.

**Star-shaped eyes** are reserved for `celebrate`, and the ambient glow swells
with the `twinkle` ray wave.

**Eyes are procedural.** Ten poses generated from a superellipse plus a vertical
squash and a parabolic bend — all the same 48-point loop, so any pose lerps into
any other. No authored geometry to maintain.

## States

Sixteen. Seven add an overlay (`dots`, `twinkle`, `orbit`, `radar`, `progress`,
`squeeze`, `standby`); the rest only change expression, blink cadence and face
tuning. `ACTIVITY_OF`, `POSES`, `POSE_EVERY`, `BLINK_EVERY` and `FACE_TUNE` in
`stella-mark.js` are the whole behaviour spec.

## Notes for wiring it up later

- `prefers-reduced-motion` is read once at mount and short-circuits the physics;
  the loop then parks instead of burning frames.
- The rig re-measures its own rendered width every 500 ms. Below 44 px the
  thinking dots zoom 1.5×; above 134 px they don't.
- 24 live marks on the demo page hold 60 fps.
- Nothing reads or writes global CSS. Eye colour comes from
  `--stella-mark-bg`, which should be the surface the mark sits on.
