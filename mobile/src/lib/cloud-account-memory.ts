export type AccountScopedDisposable = {
  accountScope: string;
  dispose(): void;
};

export function disposeAccountScopedResources<
  T extends AccountScopedDisposable,
>(resources: Map<string, T>, accountScope: string): void {
  for (const [key, resource] of resources) {
    if (resource.accountScope !== accountScope) continue;
    resource.dispose();
    resources.delete(key);
  }
}

export function withoutAccountScope<T extends { accountScope: string }>(
  values: readonly T[],
  accountScope: string,
): readonly T[] {
  return values.filter((value) => value.accountScope !== accountScope);
}
