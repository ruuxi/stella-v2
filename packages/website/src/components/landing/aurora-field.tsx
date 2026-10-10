"use client";

import { useEffect, useRef } from "react";
import { Mesh, Program, Renderer, Triangle } from "ogl";
import { shouldRunAuroraShader } from "@/lib/device-perf";

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
  uniform vec2 uPointer;
  uniform float uLift;
  uniform float uDark;

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

  vec3 palette(float t) {
    vec3 cyan   = vec3(0.00, 0.86, 1.00);
    vec3 blue   = vec3(0.10, 0.45, 1.00);
    vec3 violet = vec3(0.47, 0.26, 1.00);
    vec3 rose   = vec3(1.00, 0.30, 0.76);
    vec3 c = mix(cyan, blue, smoothstep(0.0, 0.35, t));
    c = mix(c, violet, smoothstep(0.35, 0.68, t));
    c = mix(c, rose, smoothstep(0.68, 1.0, t));
    return c;
  }

  void main() {
    vec2 uv = vUv;
    vec2 centered = vec2((uv.x - 0.5) * uAspect, uv.y);
    vec2 pointer = vec2((uPointer.x - 0.5) * uAspect, uPointer.y);

    float horizon = 0.08 + uLift * 0.5;
    float dome = length(vec2(centered.x * 0.62, (uv.y - horizon + 0.42) * 1.15));
    float mask = smoothstep(0.98, 0.34, dome);
    if (mask <= 0.001) {
      gl_FragColor = vec4(0.0);
      return;
    }

    float t = uTime * 0.07;
    float pull = exp(-length(centered - pointer) * 2.4) * 0.35;
    vec2 p = vec2(centered.x * 1.9, uv.y * 0.75);
    p += (pointer - centered) * pull;

    vec2 q = vec2(fbm(p + vec2(0.0, -t)), fbm(p + vec2(5.2, 1.3 - t * 0.6)));
    vec2 r = vec2(
      fbm(p + 2.2 * q + vec2(1.7, 9.2) + t * 0.4),
      fbm(p + 2.2 * q + vec2(8.3, 2.8) - t * 0.3)
    );
    float f = fbm(p + 2.6 * r);

    float rays = smoothstep(0.25, 0.85, f);
    rays = max(pow(rays, 1.2), 0.28);

    float hue = clamp(0.5 + centered.x * 0.38 + (r.y - 0.5) * 0.55 + (uv.y - horizon) * 0.4, 0.0, 1.0);
    vec3 col = palette(hue);
    col = mix(col, vec3(1.0), (1.0 - uDark) * smoothstep(0.55, 0.15, dome) * 0.18);

    float alpha = mask * rays * mix(1.25, 1.6, uDark);
    alpha = clamp(alpha, 0.0, 0.97);
    gl_FragColor = vec4(col, alpha);
  }
`;

export function AuroraField({
  className,
  dark = false,
  liftRef,
}: {
  className?: string;
  dark?: boolean;
  liftRef?: { current: number };
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !shouldRunAuroraShader()) return;

    let renderer: Renderer;
    let program: Program;
    let mesh: Mesh;
    try {
      renderer = new Renderer({
        canvas,
        alpha: true,
        premultipliedAlpha: false,
        dpr: Math.min(window.devicePixelRatio || 1, 1) * 0.6,
      });
      const gl = renderer.gl;
      gl.clearColor(0, 0, 0, 0);
      program = new Program(gl, {
        vertex,
        fragment,
        transparent: true,
        uniforms: {
          uTime: { value: 0 },
          uAspect: { value: 1 },
          uPointer: { value: [0.5, 0.2] },
          uLift: { value: 0 },
          uDark: { value: dark ? 1 : 0 },
        },
      });
      if (
        !gl.getProgramParameter(program.program, gl.LINK_STATUS) ||
        !program.uniformLocations
      ) {
        return;
      }
      mesh = new Mesh(gl, { geometry: new Triangle(gl), program });
    } catch {
      return;
    }

    canvas.dataset.webgl = "on";
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const pointer = { x: 0.5, y: 0.2, tx: 0.5, ty: 0.2 };
    let raf = 0;
    let last = -100;
    let inView = true;
    let disposed = false;

    const resize = () => {
      const rect = canvas.parentElement?.getBoundingClientRect();
      const w = rect?.width || window.innerWidth;
      const h = rect?.height || window.innerHeight;
      renderer.setSize(w, h);
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      program.uniforms.uAspect.value = w / Math.max(1, h);
    };

    const draw = (now: number) => {
      pointer.x += (pointer.tx - pointer.x) * 0.05;
      pointer.y += (pointer.ty - pointer.y) * 0.05;
      program.uniforms.uTime.value = reduce ? 6 : now * 0.001;
      program.uniforms.uPointer.value = [pointer.x, pointer.y];
      program.uniforms.uLift.value = liftRef?.current ?? 0;
      renderer.render({ scene: mesh });
    };

    const loop = (now: number) => {
      raf = 0;
      if (disposed || !inView || document.hidden) return;
      if (now - last >= 1000 / 30) {
        last = now;
        draw(now);
      }
      raf = requestAnimationFrame(loop);
    };
    const play = () => {
      if (!raf && !disposed && inView && !document.hidden && !reduce) {
        raf = requestAnimationFrame(loop);
      }
    };

    resize();
    draw(6000);
    play();

    const ro = new ResizeObserver(() => {
      resize();
      if (reduce) draw(6000);
    });
    if (canvas.parentElement) ro.observe(canvas.parentElement);
    const io = new IntersectionObserver((entries) => {
      inView = entries[0]?.isIntersecting ?? true;
      if (inView) play();
    });
    io.observe(canvas);
    const onVisibility = () => play();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      try {
        mesh.geometry.remove();
        program.remove();
      } catch {}
      delete canvas.dataset.webgl;
    };
  }, [dark, liftRef]);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
