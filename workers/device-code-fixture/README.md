# Stella device-code acceptance fixture

This Worker exists only for the `basic-nightingale-118` acceptance deployment.
It is a controlled RFC 8628-like proof surface, not a provider abstraction and
not a production identity provider.

The default HTTP entrypoint exposes only `GET|HEAD|POST /activate`. The public
page accepts the short `user_code` and lets a human approve or deny it. It has
no JavaScript, uses a nonce-based CSP, rejects cross-origin form posts, applies
Cloudflare rate-limit bindings, and returns `Cache-Control: no-store` on every
response.

`DeviceCodeFixtureService` is a separate named Worker RPC entrypoint with no
`fetch` method. A Cloudflare service binding can call exactly three methods:

- `authorize({schemaVersion:1, requestId})`
- `status({schemaVersion:1, userCode, deviceCode})`
- `consume({schemaVersion:1, userCode, deviceCode, consumerId})`

Authorization lasts exactly five minutes. `consume` binds an approved grant to
the Gateway interaction's `consumerId`; an exact retry receives the same
approved result, while a different consumer receives `already_consumed`. It
never creates or returns an access or refresh token.
Creation stores the authorization and its expiry alarm in one Durable Object
transaction. The alarm also stores the expired state and its cleanup alarm in
one transaction, so neither durable state can exist without its required wakeup.
The 256-bit `deviceCode` is returned only over the named service binding and is
stored by this Worker only as a SHA-256 digest. It never appears in an HTTP URL,
HTML page, log call, or public response.

The browser gateway's **bn118 environment only** binds to:

```json
{
  "binding": "DEVICE_CODE_FIXTURE",
  "service": "stella-v2-device-code-fixture-basic-nightingale-118",
  "entrypoint": "DeviceCodeFixtureService"
}
```

The gateway calls `authorize` for `device_code.fixture_start`, encrypts the
returned private `deviceCode` in its Durable Object interaction record, and
projects only the verification URI, complete URI, and user code. On a `done`
decision it calls `status`, then idempotently consumes for that exact
interaction if approved, and removes the encrypted grant at every terminal
state. Abandoned grants are alarm-expired. Builder, Convex, the model
transcript, the client, logs, and evidence never receive the private field.

There is intentionally no dev or production configuration or deploy script.
`bun run deploy:bn118` is the sole deployment target.

Wrangler-generated binding declarations are committed in
`worker-configuration.d.ts`; `bun run typecheck` fails if they drift. `bun run
test:workerd` exercises approval, denial, status, exact-consumer replay,
persisted restart, and alarm execution in the real local Workers runtime.
