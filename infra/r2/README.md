# Stella file bucket CORS

`stella-files-cors.json` records the live policy for the shared `stella-files`
bucket. Dev and production Convex were verified on 2026-09-10 to use this same
bucket and endpoint.

Apply from `workers/cloud-builder`:

```sh
bunx wrangler r2 bucket cors set stella-files --file ../../infra/r2/stella-files-cors.json --force
bunx wrangler r2 bucket cors list stella-files
```

The existing upload rules remain scoped to the website and standard development
origins. The GET/HEAD rule allows signed file reads from packaged Electron
(`file://`, whose serialized origin is `null`) and variable-port development
instances. R2 rejected a literal `null` origin with error 10040; the read-only
wildcard supports these clients without disabling Electron web security.
CORS does not provide object authorization: private files still require valid
signed URLs. This policy does not enable public bucket access.

Reference: https://developers.cloudflare.com/r2/buckets/cors/

Verification: after applying the policy, closing and reopening the previously
failed cloud canvas in the isolated development Electron app rendered its
expected contents. The same signed file returned HTTP 200 with valid CORS
headers for `null`, `https://stella.sh`, `http://localhost:57314`, and the
verification origin `http://127.0.0.1:62916`. Removing its signature returned
HTTP 400. This verifies the shared storage CORS fix; it does not substitute for
an end-to-end packaged-production run or testing every preview format.
