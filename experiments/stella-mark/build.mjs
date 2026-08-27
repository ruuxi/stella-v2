import { readFileSync, writeFileSync } from "node:fs";

const files = ["geometry.js", "shapes.js", "eyes.js", "stella-mark.js"];
const src = files
  .map((f) => readFileSync(f, "utf8"))
  .join("\n")
  .replace(/^\s*import\s+[^;]*?from\s*["'][^"']+["'];\s*$/gm, "")
  .replace(/^export\s+\{[^}]*\};\s*$/gm, "")
  .replace(/^export\s+/gm, "");

const shell = readFileSync("demo.template.html", "utf8");
writeFileSync("demo.html", shell.replace("/*__STELLA_MARK__*/", src));
console.log("demo.html written");
