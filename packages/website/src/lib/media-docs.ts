/**
 * Agent-facing docs for Stella's media API, served as plain text
 * (llms.txt-style) at https://stella.sh/docs/media. Audience: AI agents and
 * scripts, not human readers.
 *
 * The models come straight from `@stella/contracts/media-models`, the same
 * list the backend serves, so this page never needs editing when a model
 * changes. Each model's input and output are documented on its own page
 * (`docsUrl`); Stella passes them through untouched.
 */

import { MEDIA_MODELS } from "@stella/contracts/media-models";

export const renderMediaDocsOverview = (): string => `# Stella media API

Run Stella's media models (images, video, music, speech, transcription, 3D)
on the user's Stella account. Inside Stella, use the \`stella-media\` CLI
(\`stella-media models\`, \`stella-media generate --wait --request '<json>'\`);
the HTTP API below is what it calls.

## Models

${MEDIA_MODELS.map((model) => `- \`${model.id}\` (${model.kind}): ${model.does}\n  Input and output: ${model.docsUrl}`).join("\n")}

The current list is also served at \`GET <stella-api>/api/media/v1/models\`.

## Start a job

\`\`\`
POST <stella-api>/api/media/v1/generate
Content-Type: application/json
Authorization: Bearer <stella-session-token>
Idempotency-Key: <optional; a retry with the same key and body reattaches>

{ "model": "<model id>", "input": { ...the model's own input... } }
\`\`\`

\`<stella-api>\` is the Stella backend the user is signed in to; reuse their
session token. \`input\` is exactly what the model's page documents, with its
field names and values; Stella does not rename or fill in anything. A file can
be an http(s) URL or a \`data:<mime>;base64,...\` URI anywhere in \`input\` (the
whole body is limited to 24 MB); data URIs are stored and passed on as URLs.

Answer (202): \`{ "jobId": "...", "model": "...", "status": "queued" }\`.

## Watch it

\`GET <stella-api>/api/media/v1/job?jobId=<jobId>\` until \`status\` is
\`succeeded\`, \`failed\` or \`canceled\`. A succeeded job's \`output\` is the
model's own output, with every file \`url\` replaced by a signed copy Stella
keeps (valid for an hour from each read). A failed job's \`error.message\` is the
model's complaint, which says what to change in the input.

Cancel: \`DELETE <stella-api>/api/media/v1/job\` with the job's
\`Idempotency-Key\`.

## Errors

- 400: unknown model, or the model refused the input (the message says why).
- 401 \`auth_required\`: the user is signed out. Show them \`action\`, then retry.
- 402 \`CAPABILITY_REQUIRED\`: their plan does not include this kind of media.
- 429: their usage limit or the request rate is reached; \`retryAfterMs\` says when.
`;
