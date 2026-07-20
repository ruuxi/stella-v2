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
otherwise fails with `SUBMISSION_OUTCOME_UNKNOWN`. This prefers a visible
failure over a duplicate billable generation. An abandoned dispatch claim is
classified unknown after two minutes; the unknown grace is 15 minutes.

Terminal states are immutable. Duplicate, late, and opposite webhooks append
an ignored-event audit entry without changing job status or output.
