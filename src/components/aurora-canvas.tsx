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

/* Aurora — WebGL noise field rendered to a full-bleed canvas. Ported from
 * fromyou-ai's landing page (src/aurora.js). The CSS fallback gradient on
 * `.aurora-canvas` only shows when WebGL is unavailable; the shader clears
 * it via JS the moment it takes over. */
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

    let renderer: Renderer;
    try {
      renderer = new Renderer({
        canvas,
        alpha: true,
        premultipliedAlpha: false,
        // The FBM shader runs five four-octave noise fields per pixel. Retina
        // resolution is invisible in this deliberately soft effect, but at
        // DPR 2 it quadruples the fragment work for no useful visual gain.
        dpr: Math.min(window.devicePixelRatio || 1, MAX_RENDER_DPR),
      });
    } catch {
      return;
    }

    const gl = renderer.gl;
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
    const mesh = new Mesh(gl, { geometry: new Triangle(gl), program });

    // The shader now owns the pixels: drop the CSS fallback gradient and stop
    // its drift animation (gated on `[data-webgl="on"]`).
    canvas.style.background = "none";
    canvas.dataset.webgl = "on";

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    const resize = () => {
      const parent = canvas.parentElement;
      const w = parent?.clientWidth || window.innerWidth;
      /* Height is decoupled from the parent so the aurora stays at its
       * intended visual size even when the hero is shorter — ogl's setSize
       * locks canvas.style.height in pixels, so we drive it from the viewport
       * instead of measuring the canvas (which would lock to its own px). */
      const h = window.innerHeight;
      renderer.setSize(w, h);
      canvas.style.height = `${h}px`;
      program.uniforms.uAspect.value = w / Math.max(h, 1);
      program.uniforms.uStrength.value = w < 640 ? 0.72 : 1.0;
      program.uniforms.uScale.value = h / VIRTUAL_HEIGHT;
      if (reduceMotion.matches) renderer.render({ scene: mesh });
    };
    resize();
    const ro = new ResizeObserver(resize);
    if (canvas.parentElement) ro.observe(canvas.parentElement);
    window.addEventListener("resize", resize);

    let raf = 0;
    let lastRenderTime = -FRAME_INTERVAL_MS;
    // Only render while the hero is actually on screen, and cap this decorative
    // background at 30fps. The motion is intentionally slow, so rendering at
    // the display's full refresh rate only burns GPU time and competes with
    // scrolling and the hero entrance animation.
    let inView = true;
    const frame = (t: number) => {
      if (t - lastRenderTime >= FRAME_INTERVAL_MS) {
        lastRenderTime = t;
        program.uniforms.uTime.value = t * 0.001;
        renderer.render({ scene: mesh });
      }
      raf = requestAnimationFrame(frame);
    };
    const play = () => {
      if (!raf && !reduceMotion.matches && inView && !document.hidden) {
        raf = requestAnimationFrame(frame);
      }
    };
    const pause = () => {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    };
    const renderStill = () => {
      program.uniforms.uTime.value = 8.0;
      renderer.render({ scene: mesh });
    };

    if (reduceMotion.matches) renderStill();
    else play();

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
      pause();
      io.disconnect();
      ro.disconnect();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
      reduceMotion.removeEventListener?.("change", onReduceChange);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, []);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
