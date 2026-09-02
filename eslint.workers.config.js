import tseslint from "typescript-eslint";

export default tseslint.config({
  files: [
    "workers/apps-host/src/**/*.ts",
    "workers/cloud-builder/src/**/*.ts",
    "workers/browser-gateway/src/**/*.ts",
    "workers/device-code-fixture/src/**/*.ts",
    "workers/model-gateway/src/**/*.ts",
    "packages/backend/workers/canvas-share/src/**/*.ts",
  ],
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      projectService: true,
      tsconfigRootDir: import.meta.dirname,
    },
  },
  plugins: {
    "@typescript-eslint": tseslint.plugin,
  },
  rules: {
    "@typescript-eslint/no-floating-promises": "error",
  },
});
