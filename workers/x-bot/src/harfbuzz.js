// Stands in for `harfbuzzjs` (wrangler.jsonc `alias`), which satori imports
// for text shaping. The package's index.js starts emscripten with no options,
// so in workerd it takes the Node path (workerd has a `process` global) and
// then reads, fetches and compiles hb.wasm from bytes, all of which fail.
// This starts the same module on the browser path with the wasm bundled as a
// compiled module.
import createHarfBuzz from "../node_modules/harfbuzzjs/hb.js";
import hbjs from "../node_modules/harfbuzzjs/hbjs.js";
import hbWasm from "../node_modules/harfbuzzjs/hb.wasm";

// emscripten detects its environment synchronously when the factory is
// called, so the globals are only swapped for that call.
const startHarfBuzz = () => {
  const saved = { process: globalThis.process, location: globalThis.location };
  globalThis.process = undefined;
  globalThis.location = { href: "https://x-bot.invalid/" };
  try {
    return createHarfBuzz({
      instantiateWasm(imports, receiveInstance) {
        void WebAssembly.instantiate(hbWasm, imports).then((wasm) =>
          receiveInstance(wasm, hbWasm),
        );
        return {};
      },
    });
  } finally {
    globalThis.process = saved.process;
    globalThis.location = saved.location;
  }
};

export default startHarfBuzz().then(hbjs);
