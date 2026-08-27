// Inlines the ES modules into one self-contained demo page.
// The modules stay the deliverable; this is only so the demo can run from
// file:// and be published as a single artifact.
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
