declare module "react-refresh/runtime" {
  const RefreshRuntime: {
    injectIntoGlobalHook(globalObject: Window): void;
    register(type: unknown, id: string): void;
    createSignatureFunctionForTransform(): (...args: unknown[]) => unknown;
    isLikelyComponentType(value: unknown): boolean;
    performReactRefresh(): unknown;
  };
  export default RefreshRuntime;
}
