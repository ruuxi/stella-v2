import { rpcErrorStatus, type BackendErrorCode } from "@stella/contracts/backend/protocol";

/** A JSON answer that no cache keeps. */
export const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** The `{ error }` envelope the HTTP routes answer failures with. */
export const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Response =>
  json({ error, ...extra }, status);

/** An RPC-shaped error (`RpcError`, `BackendError`) as `{ error }` with its RPC status. */
export const failRpcError = (
  error: { code: BackendErrorCode; message: string },
  extra: Record<string, unknown> = {},
): Response => fail(rpcErrorStatus(error.code), error.message, extra);
