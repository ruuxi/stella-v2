import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { chromium } from "playwright";

// Extract rather than copy or approximate the shipping website noise shader.
const sourcePath = path.resolve("../website/src/components/aurora-canvas.tsx");
const source = await readFile(sourcePath, "utf8");
function shader(name: string): string {
  const match = source.match(new RegExp(`const ${name} = /\\* glsl \\*/ \\x60([\\s\\S]*?)\\x60;`));
  if (!match) throw new Error(`Could not locate canonical ${name} shader`);
  return match[1];
}
const vertex = shader("vertex"), fragment = shader("fragment");
const width = 6144, height = 1600;
const domainStart = 0.4, domainEnd = 1;
const uniforms = { uTime: 8, uAspect: width / height / (domainEnd - domainStart),
  uStrength: 1, uScale: height / 900 };
const directory = path.resolve("public/brand");
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: "chrome",
  args: ["--enable-webgl", "--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 500 } });
  const result = await page.evaluate(({ vertex, fragment, width, height, domainStart, domainEnd, uniforms }) => {
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: false,
      antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL unavailable; do not substitute a CSS gradient");
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!; gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "Shader compile failed");
      return shader;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment)); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "Shader link failed");
    gl.useProgram(program);
    const attribute = (name: string, values: number[]) => {
      const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(values), gl.STATIC_DRAW);
      const location = gl.getAttribLocation(program, name);
      gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    };
    attribute("position", [-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]);
    attribute("uv", [domainStart,0, domainEnd,0, domainStart,1,
      domainStart,1, domainEnd,0, domainEnd,1]);
    for (const [name, value] of Object.entries(uniforms)) gl.uniform1f(gl.getUniformLocation(program, name), value);
    gl.viewport(0, 0, width, height); gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.BLEND); gl.drawArrays(gl.TRIANGLES, 0, 6); gl.finish();
    const error = gl.getError(); if (error !== gl.NO_ERROR) throw new Error(`WebGL error ${error}`);
    return { png: canvas.toDataURL("image/png").split(",")[1], renderer: gl.getParameter(gl.RENDERER) as string };
  }, { vertex, fragment, width, height, domainStart, domainEnd, uniforms });
  const bytes = Buffer.from(result.png, "base64");
  const output = path.join(directory, "store-aura-panorama.png");
  await writeFile(output, bytes);
  await writeFile(path.join(directory, "store-aura-provenance.json"), JSON.stringify({
    source: "packages/website/src/components/aurora-canvas.tsx",
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    vertexSha256: createHash("sha256").update(vertex).digest("hex"),
    fragmentSha256: createHash("sha256").update(fragment).digest("hex"),
    shaderChanged: false, frozenTime: "Website reduced-motion still:8seconds",
    width, height, domain: { x: [domainStart, domainEnd], y: [0,1] }, uniforms,
    alpha: "Transparent straight-alpha shader output, composited over white by store layout",
    continuity: "One shared panorama; adjacent index/count segments, no per-slide shader reset",
    renderer: result.renderer, pngSha256: createHash("sha256").update(bytes).digest("hex"),
  }, null, 2) + "\n");
  console.log(`Rendered exact website aura: ${output}`);
} finally { await browser.close(); }
