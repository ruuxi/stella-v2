"use client";

import { useEffect, useRef } from "react";
import { Camera, GLTFLoader, Mat4, Program, Renderer, Transform, Vec3, type Mesh } from "ogl";

const vertex = /* glsl */ `
  attribute vec3 position;
  attribute vec3 normal;
  attribute vec2 uv;
  uniform mat4 modelViewMatrix;
  uniform mat4 projectionMatrix;
  uniform mat3 normalMatrix;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vPos;
  void main() {
    vUv = uv;
    vNormal = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vPos = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

const fragment = /* glsl */ `
  precision highp float;
  uniform sampler2D tMap;
  uniform float uHasMap;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vPos;
  void main() {
    vec3 base = uHasMap > 0.5 ? texture2D(tMap, vUv).rgb : vec3(0.95, 0.9, 0.85);
    vec3 n = normalize(vNormal);
    if (!gl_FrontFacing) n = -n;
    vec3 v = normalize(-vPos);
    vec3 key = normalize(vec3(0.6, 0.8, 0.7));
    vec3 fill = normalize(vec3(-0.7, 0.2, 0.4));
    float diff = max(dot(n, key), 0.0);
    float diff2 = max(dot(n, fill), 0.0) * 0.35;
    float hemi = mix(0.45, 0.85, n.y * 0.5 + 0.5);
    vec3 h = normalize(key + v);
    float spec = pow(max(dot(n, h), 0.0), 90.0) * 0.9;
    float spec2 = pow(max(dot(n, normalize(fill + v)), 0.0), 40.0) * 0.25;
    float fres = pow(1.0 - max(dot(n, v), 0.0), 3.0);
    vec3 col = base * (hemi * 0.55 + diff * 0.65 + diff2);
    col += vec3(1.0) * (spec + spec2);
    col += vec3(0.75, 0.7, 1.0) * fres * 0.35;
    gl_FragColor = vec4(pow(col, vec3(0.95)), 1.0);
  }
`;

export function CatViewer({ active, className }: { active: boolean; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const activeRef = useRef(active);
  const kick = useRef<() => void>(() => {});

  useEffect(() => {
    activeRef.current = active;
    kick.current();
  }, [active]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let disposed = false;
    let raf = 0;
    let inView = false;
    const renderer = new Renderer({
      canvas,
      alpha: true,
      antialias: true,
      dpr: Math.min(window.devicePixelRatio || 1, 2),
    });
    const gl = renderer.gl;
    gl.clearColor(0, 0, 0, 0);
    const camera = new Camera(gl, { fov: 30 });
    camera.position.set(0, 0, 5);
    const scene = new Transform();
    const pivot = new Transform();
    pivot.setParent(scene);
    const state = { rot: 0.6, vel: 0, drag: false, lastX: 0, tilt: 0 };
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const resize = () => {
      const r = canvas.parentElement?.getBoundingClientRect();
      if (!r) return;
      renderer.setSize(r.width, r.height);
      camera.perspective({ aspect: r.width / Math.max(1, r.height) });
    };

    const frame = () => {
      raf = 0;
      if (disposed) return;
      if (!state.drag) {
        state.rot += state.vel;
        state.vel *= 0.94;
        if (!reduce && Math.abs(state.vel) < 0.004) state.rot += 0.004;
      }
      pivot.rotation.y = state.rot;
      pivot.rotation.x = state.tilt;
      if (canvas.dataset.ready !== "1") return;
      try {
        renderer.render({ scene, camera });
      } catch {
        canvas.dataset.failed = "1";
        canvas.dataset.ready = "0";
        return;
      }
      if (inView && activeRef.current) raf = requestAnimationFrame(frame);
    };
    const play = () => {
      if (!raf && inView && !disposed) raf = requestAnimationFrame(frame);
    };
    kick.current = play;

    GLTFLoader.load(gl, "/landing/cat.glb")
      .then((gltf) => {
        if (disposed) return;
        const roots: Transform[] = gltf.scene ?? [];
        roots.forEach((node) => node.setParent(pivot));
        pivot.updateMatrixWorld(true);
        const min = new Vec3(Infinity, Infinity, Infinity);
        const max = new Vec3(-Infinity, -Infinity, -Infinity);
        const corner = new Vec3();
        const meshes: Mesh[] = (gltf.meshes ?? []).flatMap((m: { primitives: Mesh[] }) => m.primitives);
        meshes.forEach((mesh) => {
          const attr = mesh.geometry.attributes.position;
          const data = attr.data as ArrayLike<number>;
          const div = attr.normalized
            ? data instanceof Int16Array
              ? 32767
              : data instanceof Uint16Array
                ? 65535
                : data instanceof Int8Array
                  ? 127
                  : data instanceof Uint8Array
                    ? 255
                    : 1
            : 1;
          const lo = [Infinity, Infinity, Infinity];
          const hi = [-Infinity, -Infinity, -Infinity];
          for (let i = 0; i < data.length; i += attr.size ?? 3) {
            for (let a = 0; a < 3; a += 1) {
              const v = data[i + a] / div;
              if (v < lo[a]) lo[a] = v;
              if (v > hi[a]) hi[a] = v;
            }
          }
          const world = mesh.worldMatrix as Mat4;
          for (let c = 0; c < 8; c += 1) {
            corner.set(c & 1 ? hi[0] : lo[0], c & 2 ? hi[1] : lo[1], c & 4 ? hi[2] : lo[2]);
            corner.applyMatrix4(world);
            min.set(Math.min(min.x, corner.x), Math.min(min.y, corner.y), Math.min(min.z, corner.z));
            max.set(Math.max(max.x, corner.x), Math.max(max.y, corner.y), Math.max(max.z, corner.z));
          }
          const material = (mesh.program as Program & { gltfMaterial?: { baseColorTexture?: { texture: unknown } } }).gltfMaterial;
          const texture = material?.baseColorTexture?.texture;
          mesh.program = new Program(gl, {
            vertex,
            fragment,
            cullFace: false,
            uniforms: {
              tMap: { value: texture ?? null },
              uHasMap: { value: texture ? 1 : 0 },
            },
          });
        });
        const linked = meshes.every((mesh) => (mesh.program as Program & { uniformLocations?: unknown }).uniformLocations);
        if (!linked || gl.isContextLost()) {
          canvas.dataset.failed = "1";
          return;
        }
        const size = Math.max(max.x - min.x, max.y - min.y, max.z - min.z) || 1;
        const center = new Vec3((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
        const s = 2.1 / size;
        roots.forEach((node) => {
          node.scale.multiply(s);
          node.position.set(
            (node.position.x - center.x) * s,
            (node.position.y - center.y) * s,
            (node.position.z - center.z) * s,
          );
        });
        canvas.dataset.ready = "1";
        resize();
        play();
      })
      .catch(() => {
        canvas.dataset.failed = "1";
      });

    const onDown = (e: PointerEvent) => {
      state.drag = true;
      state.lastX = e.clientX;
      canvas.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!state.drag) return;
      const dx = e.clientX - state.lastX;
      state.lastX = e.clientX;
      state.rot += dx * 0.01;
      state.vel = dx * 0.01;
      play();
    };
    const onUp = () => {
      state.drag = false;
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);

    const io = new IntersectionObserver(([entry]) => {
      inView = entry?.isIntersecting ?? false;
      if (inView) play();
    });
    io.observe(canvas);
    const ro = new ResizeObserver(() => {
      resize();
      play();
    });
    if (canvas.parentElement) ro.observe(canvas.parentElement);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
    };
  }, []);

  return <canvas ref={ref} className={className} aria-label="A ceramic cat, made by Stella. Drag to turn it." role="img" />;
}
