const TEST_ACCOUNTS_ENV = "STELLA_TEST_ACCOUNTS";

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export type TestAccountsEnabledResult =
  | { ok: true }
  | { ok: false; response: Response };

export const requireTestAccountsEnabled = (): TestAccountsEnabledResult => {
  if (process.env[TEST_ACCOUNTS_ENV]?.trim() === "1") return { ok: true };
  return {
    ok: false,
    response: jsonResponse(404, {
      error: "Test accounts disabled.",
      env: TEST_ACCOUNTS_ENV,
    }),
  };
};
