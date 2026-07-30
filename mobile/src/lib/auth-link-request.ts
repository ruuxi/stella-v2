export async function buildMagicLinkRequest(args: {
  email: string;
  anonymous: boolean;
  authResolved: boolean;
  getToken: () => Promise<string>;
}): Promise<{
  headers: Record<string, string>;
  body: string;
}> {
  if (!args.authResolved) {
    throw new Error("Still checking your current Stella session. Try again.");
  }
  const payload: { email: string; requireAnonymousOwner?: boolean } = {
    email: args.email,
  };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (args.anonymous) {
    // Fail closed: sending an unbound link here would sign in successfully
    // while abandoning the anonymous owner's cloud history.
    const token = (await args.getToken()).trim();
    if (!token) throw new Error("You need to sign in again.");
    headers.Authorization = `Bearer ${token}`;
    payload.requireAnonymousOwner = true;
  }

  return { headers, body: JSON.stringify(payload) };
}
