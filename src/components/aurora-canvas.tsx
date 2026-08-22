"use client";

import { useEffect, useRef } from "react";
import { Renderer, Triangle, Program, Mesh } from "ogl";
import { shouldRunAuroraShader } from "@/lib/device-perf";

const MAX_RENDER_DPR = 1;
/**
 * The CSS-pixel viewport height the aurora was composed at. The noise domain
 * is expressed in units of this fixed virtual height rather than being
 * normalized to whatever surface it lands on — so at any window size one
 * curtain covers the same number of on-screen pixels, and a taller viewport
 * sees MORE field instead of the same features stretched fat. CSS pixels on
 * purpose: two displays at the same logical size render identically no matter
 * their devicePixelRatio, and page zoom scales the art together with the rest
 * of the page instead of re-compositing it.
 */
const VIRTUAL_HEIGHT = 900;
const FRAME_INTERVAL_MS = 1000 / 30;
/**
 * How many render failures we tolerate per mount before giving up on WebGL
 * for good. The first failure gets one rebuild of the GL scene (covers a
 * transient context loss / a driver hiccup); a second failure means the
 * environment can't run the shader and the CSS gradient takes over.
 */
const MAX_RENDER_FAILURES = 2;

/**
 * Marks which AuroraCanvas mount currently owns a canvas element.
 *
 * React can re-run this effect on the very same <canvas> without ever
 * unmounting the DOM node — StrictMode's simulated unmount/remount in dev, and
 * Fast Refresh. A canvas only ever has one WebGL context object: once
 * `WEBGL_lose_context.loseContext()` has been called on it, every later
 * `getContext()` hands back that same, permanently lost object. If the
 * cleanup released the context synchronously, the next mount would build the
 * whole ogl scene on a lost context — shaders silently fail to link, ogl's
 * Program never gets its uniform table, and the first frame throws inside
 * `Program.use()`. So cleanup defers the release by a tick and skips it when
 * a new mount has claimed the canvas in the meantime. The claim lives on the
 * element itself (under a registry symbol, so it survives this module being
 * re-evaluated by Fast Refresh) rather than in module state.
 */
const OWNER = Symbol.for("stella.aurora-canvas.owner");
type OwnedCanvas = HTMLCanvasElement & { [OWNER]?: symbol };

const vertex = /* glsl */ `
  attribute vec2 uv;
  attribute vec2 position;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 0.0, 1.0);
  }
`;

const fragment = /* glsl */ `
  precision highp float;

  varying vec2 vUv;
  uniform float uTime;
  uniform float uAspect;
  uniform float uStrength;
  uniform float uScale;

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

  vec3 auroraPalette(float t) {
    vec3 teal   = vec3(0.04, 0.80, 0.58);
    vec3 cyan   = vec3(0.10, 0.62, 0.96);
    vec3 violet = vec3(0.45, 0.36, 0.96);
    vec3 rose   = vec3(0.95, 0.40, 0.74);
    vec3 c = mix(teal, cyan, smoothstep(0.0, 0.42, t));
    c = mix(c, violet, smoothstep(0.42, 0.74, t));
    c = mix(c, rose, smoothstep(0.74, 1.0, t));
    return c;
  }

  void main() {
    vec2 uv = vUv;

    /* These regions are guaranteed to have zero alpha below: rightRamp is
     * zero through x=0.20 and vert is zero through y=0.05. Return before the
     * five FBM evaluations so transparent pixels do no noise work. */
    if (uv.x <= 0.20 || uv.y <= 0.05) {
      gl_FragColor = vec4(0.0);
      return;
    }

    float t = uTime * 0.06;

    /* uScale = viewportHeight / VIRTUAL_HEIGHT: the domain reads in fixed
     * virtual-height units, so curtain size is constant on screen at every
     * window size. flow takes the same factor so the drift keeps a constant
     * on-screen speed too. At uScale = 1.0 this line is exactly the original. */
    vec2 p = vec2(uv.x * uAspect, uv.y) * vec2(1.7, 0.66) * uScale;
    vec2 flow = vec2(-t * 0.55, t * 0.22) * uScale;

    vec2 q = vec2(
      fbm(p + flow),
      fbm(p + flow + vec2(5.2, 1.3))
    );
    vec2 r = vec2(
      fbm(p + 2.0 * q + vec2(1.7, 9.2) + flow * 0.5),
      fbm(p + 2.0 * q + vec2(8.3, 2.8) - flow * 0.4)
    );
    float f = fbm(p + 2.5 * r);

    float hue = clamp(uv.y * 0.92 + 0.04 + 0.28 * (r.y - 0.5), 0.0, 1.0);
    vec3 col = auroraPalette(hue);

    /* Floor the curtains so the aurora never disappears entirely when the
     * noise field drifts to low values, keeping the band visible across the
     * full animation loop instead of flickering between busy and empty. */
    float curtains = smoothstep(0.30, 0.78, f);
    curtains = pow(curtains, 1.25);
    curtains = max(curtains, 0.22);

    float rightRamp = smoothstep(0.20, 0.95, uv.x);

    float vert = smoothstep(0.05, 0.28, uv.y) * smoothstep(1.05, 0.78, uv.y);

    float alpha = curtains * rightRamp * vert * 1.55 * uStrength;
    alpha = clamp(alpha, 0.0, 0.96);

    gl_FragColor = vec4(col, alpha);
  }
`;

type Scene = {
  renderer: Renderer;
  gl: Renderer["gl"];
  program: Program;
  mesh: Mesh;
  loseContext: WEBGL_lose_context | null;
};

type BuildResult =
  | { ok: true; scene: Scene }
  /* `lost`: the canvas's context exists but is in the lost state; `failed`:
   * no context, or the shader didn't compile/link on this GPU. */
  | { ok: false; reason: "lost" | "failed" };

/* Build the whole ogl stack for a canvas. Never throws. Every failure mode of
 * `new Renderer` / `new Program` on a dead or unsuitable context is reported
 * as a result instead of surfacing later as an exception in the frame loop. */
function buildScene(canvas: HTMLCanvasElement): BuildResult {
  try {
    const renderer = new Renderer({
      canvas,
      alpha: true,
      premultipliedAlpha: false,
      // The FBM shader runs five four-octave noise fields per pixel. Retina
      // resolution is invisible in this deliberately soft effect, but at
      // DPR 2 it quadruples the fragment work for no useful visual gain.
      dpr: Math.min(window.devicePixelRatio || 1, MAX_RENDER_DPR),
    });
    const gl = renderer.gl;
    if (!gl) return { ok: false, reason: "failed" };
    if (gl.isContextLost()) return { ok: false, reason: "lost" };

    gl.clearColor(0, 0, 0, 0);

    const program = new Program(gl, {
      vertex,
      fragment,
      transparent: true,
      uniforms: {
        uTime: { value: 0 },
        uAspect: { value: 1 },
        uStrength: { value: 1 },
        uScale: { value: 1 },
      },
    });
    // ogl's Program returns early from setShaders() when the program fails to
    // link (shader compile error on this GPU, or the context dropping out
    // mid-construction) and leaves `uniformLocations`/`attributeLocations`
    // undefined — the first render() would then throw
    // "Cannot read properties of undefined (reading 'forEach')" from
    // Program.use(). Catch that here, where it can be handled.
    if (
      !gl.getProgramParameter(program.program, gl.LINK_STATUS) ||
      !program.uniformLocations
    ) {
      program.remove();
      return { ok: false, reason: gl.isContextLost() ? "lost" : "failed" };
    }

    const mesh = new Mesh(gl, { geometry: new Triangle(gl), program });
    return {
      ok: true,
      scene: {
        renderer,
        gl,
        program,
        mesh,
        loseContext: gl.getExtension("WEBGL_lose_context"),
      },
    };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

function disposeScene(scene: Scene) {
  try {
    scene.mesh.geometry.remove();
    scene.program.remove();
    scene.gl.deleteShader(scene.program.vertexShader);
    scene.gl.deleteShader(scene.program.fragmentShader);
  } catch {
    // A lost context makes these no-ops; anything else is not worth surfacing.
  }
}

/* Aurora — WebGL noise field rendered to a full-bleed canvas. Ported from
 * fromyou-ai's landing page (src/aurora.js). The CSS fallback gradient on
 * `.aurora-canvas` only shows when WebGL is unavailable; the shader clears
 * it via JS the moment it takes over — and hands it back if WebGL ever stops
 * working (context loss that isn't restored, repeated render failures). */
export function AuroraCanvas({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;

    // No real GPU (or a software rasterizer / memory-starved device): skip
    // WebGL entirely and let the animated CSS gradient fallback carry the hero.
    // Running the FBM shader through SwiftShader looks broken — a few fps or a
    // blank canvas — so we never blank the fallback in that case.
    if (!shouldRunAuroraShader()) return;

    const owner = Symbol("aurora");
    (canvas as OwnedCanvas)[OWNER] = owner;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    let scene: Scene | null = null;
    /* Cleanup has run — nothing may touch the canvas or schedule work again. */
    let disposed = false;
    /* WebGL has been given up on for this mount: the CSS gradient owns the
     * pixels and no frame will ever be scheduled again. */
    let abandoned = false;
    let failures = 0;
    let raf = 0;
    let lastRenderTime = -FRAME_INTERVAL_MS;
    let inView = true;

    // The shader owns the pixels: drop the CSS fallback gradient and stop its
    // drift animation (gated on `[data-webgl="on"]`). `showFallback` is the
    // exact inverse, used whenever WebGL stops being able to draw.
    const showShader = () => {
      canvas.style.background = "none";
      canvas.dataset.webgl = "on";
    };
    const showFallback = () => {
      canvas.style.background = "";
      delete canvas.dataset.webgl;
      // ogl's setSize pins the element's CSS size in px; while the stylesheet
      // owns the pixels again, let it own the box too (otherwise a viewport
      // change after falling back would leave a stale px width behind).
      canvas.style.width = "";
      canvas.style.height = "";
    };

    const pause = () => {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    };

    const abandon = () => {
      abandoned = true;
      pause();
      if (scene) {
        disposeScene(scene);
        scene = null;
      }
      showFallback();
    };

    const resize = () => {
      if (!scene) return;
      const parent = canvas.parentElement;
      const w = parent?.clientWidth || window.innerWidth;
      /* Height is decoupled from the parent so the aurora stays at its
       * intended visual size even when the hero is shorter — ogl's setSize
       * locks canvas.style.height in pixels, so we drive it from the viewport
       * instead of measuring the canvas (which would lock to its own px). */
      const h = window.innerHeight;
      scene.renderer.setSize(w, h);
      canvas.style.height = `${h}px`;
      scene.program.uniforms.uAspect.value = w / Math.max(h, 1);
      scene.program.uniforms.uStrength.value = w < 640 ? 0.72 : 1.0;
      scene.program.uniforms.uScale.value = h / VIRTUAL_HEIGHT;
      if (reduceMotion.matches) renderStill();
    };

    /* Draw one frame at the given shader time. Returns false when the draw
     * failed — the failure has already been dealt with (rebuild or abandon),
     * so callers must not touch `scene` afterwards. */
    const render = (time: number): boolean => {
      if (!scene || abandoned || disposed) return false;
      if (scene.gl.isContextLost()) {
        // Nothing can be drawn until `webglcontextrestored`; that handler
        // rebuilds the scene and resumes. Stop burning frames meanwhile.
        pause();
        return false;
      }
      try {
        scene.program.uniforms.uTime.value = time;
        scene.renderer.render({ scene: scene.mesh });
        return true;
      } catch (error) {
        onRenderFailure(error);
        return false;
      }
    };

    const renderStill = () => {
      render(8.0);
    };

    const frame = (t: number) => {
      raf = 0;
      if (disposed || abandoned) return;
      if (t - lastRenderTime >= FRAME_INTERVAL_MS) {
        lastRenderTime = t;
        if (!render(t * 0.001)) return;
      }
      raf = requestAnimationFrame(frame);
    };
    // Only render while the hero is actually on screen, and cap this decorative
    // background at 30fps. The motion is intentionally slow, so rendering at
    // the display's full refresh rate only burns GPU time and competes with
    // scrolling and the hero entrance animation.
    const play = () => {
      if (
        !raf &&
        scene &&
        !disposed &&
        !abandoned &&
        !reduceMotion.matches &&
        inView &&
        !document.hidden
      ) {
        raf = requestAnimationFrame(frame);
      }
    };

    /* Resume after a (re)build: a still frame under reduced motion, the loop
     * otherwise. */
    const start = () => {
      if (reduceMotion.matches) renderStill();
      else play();
    };

    /* Replace the GL scene (after a context restore or a failed frame). */
    const rebuild = (): boolean => {
      if (scene) {
        disposeScene(scene);
        scene = null;
      }
      const result = buildScene(canvas);
      if (!result.ok) return false;
      scene = result.scene;
      showShader();
      resize();
      return true;
    };

    function onRenderFailure(error: unknown) {
      failures += 1;
      pause();
      if (failures < MAX_RENDER_FAILURES && rebuild()) {
        start();
        return;
      }
      console.warn(
        "[aurora] WebGL rendering failed; falling back to the CSS gradient.",
        error,
      );
      abandon();
    }

    // Context loss — GPU reset, driver crash, the browser reclaiming contexts
    // on a tab-heavy machine, or WEBGL_lose_context. preventDefault() tells the
    // browser we want the context back. Until then the canvas is blank, so
    // the CSS gradient takes over; on restore every GL object is gone, so the
    // scene is rebuilt from scratch before the loop resumes.
    const onContextLost = (event: Event) => {
      event.preventDefault();
      pause();
      showFallback();
    };
    const onContextRestored = () => {
      if (disposed || abandoned) return;
      if (rebuild()) start();
      else abandon();
    };
    canvas.addEventListener("webglcontextlost", onContextLost);
    canvas.addEventListener("webglcontextrestored", onContextRestored);

    const initial = buildScene(canvas);
    if (initial.ok) {
      scene = initial.scene;
      showShader();
      resize();
    } else if (initial.reason === "lost") {
      // Someone lost this canvas's context before we got here. If it comes
      // back, `webglcontextrestored` builds the scene; until then (or forever,
      // if it never does) the CSS gradient is showing and nothing is scheduled.
      showFallback();
    } else {
      // No usable context or the shader won't compile on this GPU: leave the
      // CSS gradient alone and don't schedule anything.
      abandoned = true;
    }

    const ro = new ResizeObserver(resize);
    if (canvas.parentElement) ro.observe(canvas.parentElement);
    window.addEventListener("resize", resize);

    if (scene) start();

    const io = new IntersectionObserver(
      (entries) => {
        inView = entries[0]?.isIntersecting ?? true;
        if (inView) play();
        else pause();
      },
      { rootMargin: "120px 0px" },
    );
    io.observe(canvas);

    const onVisibility = () => {
      if (document.hidden) pause();
      else play();
    };
    document.addEventListener("visibilitychange", onVisibility);

    const onReduceChange = () => {
      if (reduceMotion.matches) {
        pause();
        renderStill();
      } else {
        play();
      }
    };
    reduceMotion.addEventListener?.("change", onReduceChange);

    return () => {
      disposed = true;
      pause();
      io.disconnect();
      ro.disconnect();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
      reduceMotion.removeEventListener?.("change", onReduceChange);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);

      const loseContext = scene?.loseContext ?? null;
      if (scene) {
        disposeScene(scene);
        scene = null;
      }
      // Hand the element back with its CSS fallback in place. If this is a
      // StrictMode / Fast Refresh remount, the same canvas is about to be
      // taken over again and must not sit blank in between.
      showFallback();

      // Release the GPU context — but only if no new mount has claimed this
      // canvas by the time the tick runs (see `canvasOwners`). A synchronous
      // remount reuses the live context; a real unmount frees it right away
      // instead of waiting for GC, so a busy tab can't run out of contexts.
      setTimeout(() => {
        if ((canvas as OwnedCanvas)[OWNER] !== owner) return;
        delete (canvas as OwnedCanvas)[OWNER];
        loseContext?.loseContext();
      }, 0);
    };
  }, []);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
