export type CapturedCloudBrowserCookie = Readonly<{
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}>;

export function isCloudBrowserSessionCaptureAvailable(): boolean;
export function captureCloudBrowserCookies(
  url: string,
): Promise<readonly CapturedCloudBrowserCookie[]>;
