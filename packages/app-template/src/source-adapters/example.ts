/**
 * External data access belongs in source-adapters so a follow-up repair turn
 * can update an upstream integration without touching the app's UI.
 */
export async function loadExampleSource(): Promise<never> {
  throw new Error("Replace this adapter with the app's platform-backed source.");
}
