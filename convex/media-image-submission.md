# Durable `image_gen` submission boundary

Only idempotency-keyed Fal image capabilities use this outbox. Video, audio,
music, and 3D retain their existing submission behavior.

Reservation, encrypted-payload attachment, and scheduling
`submitReservedImageJob` happen in one Convex mutation. The action decrypts
before claiming, then uses `claimImageSubmission` as the final durable CAS
before provider POST. Pending rows can be rescheduled. Dispatching or unknown
rows must never be submitted again.

Fal assigns `request_id` in the POST response and has no documented client
submission idempotency key or lookup by client key. Response loss after POST is
therefore irreducibly ambiguous: Stella waits for the job-ID webhook and
never repeats the provider request. An abandoned dispatch claim is classified
unknown after two minutes. It remains reconcilable for three hours: Fal allows
up to one hour of inference and may retry webhooks for two hours. After that
envelope the public job status becomes terminal `unknown`, not an ordinary
provider failure. Late events are audit-only and cannot mutate it.

Webhook dedup identity, the allowed terminal CAS, connector scheduling, and
billing eligibility commit in one Convex mutation. A transaction crash rolls
all of them back so Fal can retry. Terminal states (`succeeded`, `failed`,
`canceled`, `unknown`) are immutable. Duplicate, late, and opposite webhooks
append an ignored-event audit entry without changing status or output and can
never trigger billing.

The encrypted submission payload is removed after submission settlement,
cancellation, terminal webhook transition, or unknown classification. A
provably unsubmitted pending row is abandoned and cleaned after 24 hours.
