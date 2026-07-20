# Durable `image_gen` submission boundary

Only idempotency-keyed Fal image capabilities use this outbox. Video, audio,
music, and 3D retain their existing submission behavior.

The encrypted request is split into bounded, owner- and operation-scoped
database chunks. A manifest row exists before the first chunk, every chunk is
written transactionally with that ownership metadata, and only a complete
manifest can be attached to a media job. This removes the untracked
`_storage.store` crash window: account purge and cleanup can enumerate partial,
complete, attached, and abandoned payloads after any process failure.

Reservation, manifest attachment, and scheduling `submitReservedImageJob`
happen in one Convex mutation. The action reconstructs and decrypts a complete
manifest before claiming, then uses `claimImageSubmission` as the final durable
CAS before provider POST. Pending rows can be rescheduled. Dispatching or
unknown rows must never be submitted again. Legacy jobs that already reference
Convex file storage remain readable and cleanable during migration; new
idempotency-keyed image submissions never create those blobs.

Idempotency-keyed managed image ingress is capped before JSON parsing.
`Content-Length` above 3 MiB is rejected without opening the body stream;
chunked/no-length uploads are read incrementally, canceled at the same hard cap,
and fail closed if interrupted. The pre-parse branch is selected from image_gen's
required idempotency header, not untrusted body fields; unkeyed legacy
video/audio/3D requests retain their prior shared-route ingress behavior.
Image edits accept at most four references. Inline references are at most 1 MiB
each and 2 MiB decoded in aggregate, with a 2,796,460-character combined data-URL
ceiling; remote URLs are at most 8 KiB. The desktop mirrors these checks and
normalizes larger trusted local/data-URL inputs before managed upload, but the
gateway never trusts the client to enforce them.

Encrypted manifests are capped at 4.5 MiB serialized. At the hard limits, the
dispatcher budget reserves two UTF-16 encrypted representations (18 MiB), three
UTF-16 plaintext/provider-body representations (18 MiB), ciphertext and
plaintext byte buffers (just over 6 MiB), and 8 MiB fixed runtime headroom:
50.125 MiB total, below Convex's 64 MiB action limit. Reconstruction drops
chunk-array references before decrypt/parse, revalidates the decrypted reference
envelope, and streams legacy file-storage payloads through the same encrypted cap.

Fal assigns `request_id` in the POST response and has no documented client
submission idempotency key or lookup by client key. Response loss after POST is
therefore irreducibly ambiguous: Stella waits for the job-ID webhook and
never repeats the provider request. An abandoned dispatch claim is classified
unknown after two minutes. It remains reconcilable for three hours and fifteen
minutes: Fal allows up to one hour of inference and may retry webhooks for two
hours, with a fifteen-minute scheduling margin. After that envelope the public
job status becomes terminal `unknown`, not an ordinary provider failure. Late
events are audit-only and cannot mutate it.

Webhook dedup identity, the allowed terminal CAS, connector scheduling, and
billing eligibility commit in one Convex mutation. A transaction crash rolls
all of them back so Fal can retry. Terminal states (`succeeded`, `failed`,
`canceled`, `unknown`) are immutable. Duplicate, late, and opposite webhooks
append an ignored-event audit entry without changing status or output and can
never trigger billing.

Encrypted manifest chunks are removed after submission settlement,
cancellation, terminal webhook transition, or unknown classification. An
incomplete upload is cleaned after one hour; a complete but unattached or
provably unsubmitted pending payload is abandoned and cleaned after 24 hours.
Cleanup retains the manifest pointer until every chunk deletion succeeds, so a
retry can resume instead of orphaning encrypted bytes.
