const percentEncode = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

const randomNonce = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
};

export type XOAuthCredentials = {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
};

export const createXOAuth1Header = async (
  method: string,
  rawUrl: string,
  credentials: XOAuthCredentials,
  overrides?: { nonce?: string; timestamp?: string },
): Promise<string> => {
  const url = new URL(rawUrl);
  const oauthParameters = new Map<string, string>([
    ["oauth_consumer_key", credentials.apiKey],
    ["oauth_nonce", overrides?.nonce ?? randomNonce()],
    ["oauth_signature_method", "HMAC-SHA1"],
    [
      "oauth_timestamp",
      overrides?.timestamp ?? String(Math.floor(Date.now() / 1000)),
    ],
    ["oauth_token", credentials.accessToken],
    ["oauth_version", "1.0"],
  ]);
  const signatureParameters: Array<[string, string]> = [
    ...url.searchParams.entries(),
    ...oauthParameters.entries(),
  ];
  signatureParameters.sort(([leftKey, leftValue], [rightKey, rightValue]) => {
    const keyOrder = percentEncode(leftKey).localeCompare(
      percentEncode(rightKey),
    );
    return (
      keyOrder ||
      percentEncode(leftValue).localeCompare(percentEncode(rightValue))
    );
  });
  const parameterString = signatureParameters
    .map(([key, value]) => `${percentEncode(key)}=${percentEncode(value)}`)
    .join("&");
  const baseUrl = `${url.protocol}//${url.host}${url.pathname}`;
  const signatureBase = [method.toUpperCase(), baseUrl, parameterString]
    .map(percentEncode)
    .join("&");
  const signingKey = `${percentEncode(credentials.apiSecret)}&${percentEncode(credentials.accessTokenSecret)}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingKey),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signature = bytesToBase64(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(signatureBase),
      ),
    ),
  );
  oauthParameters.set("oauth_signature", signature);

  return `OAuth ${Array.from(oauthParameters.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([keyName, value]) =>
        `${percentEncode(keyName)}=\"${percentEncode(value)}\"`,
    )
    .join(", ")}`;
};
