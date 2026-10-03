// Wrangler bundles .wasm imports as compiled modules; Workers cannot compile
// WebAssembly from bytes at runtime. (.woff Data modules are declared in the
// generated worker-configuration.d.ts.)
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
