---
name: stella-media
description: Generate images, video, music, speech and 3D models, or transcribe audio, through Stella's media models. Use when the user asks for any generated media or a transcription. Don't call provider APIs directly — Stella handles auth, billing, and keeping the files.
---

# Generating media via Stella

`stella-media` (on PATH in Bash) runs Stella's media models on Stella's account, billed to the user's plan.

## 1. Pick a model

```bash
stella-media models
```

Each line is a model id, what it does, and its docs page. Read the docs page (`web` fetch it) before the first call to a model: it is the model's own input and output schema, and Stella passes your input to the model untouched.

## 2. Run it

```bash
stella-media generate --wait --request '{"model":"<id>","input":{ ...the model's own input... }}'
```

- `input` is exactly what the model's docs page describes, with the same field names and values.
- A local file goes in as a `file://` URL anywhere a URL goes (`"image_url": "file:///Users/me/photo.png"`); it is uploaded with the request. Public http(s) URLs work as they are.
- `--wait` waits for the result and saves every file it produced under `~/.stella/media/outputs/`, printing the paths. Video and 3D take minutes; if it is still running at the timeout, it prints the job id — check later with `stella-media status --job-id <id> --save`. Never resubmit a job that is still running.
- A failed job prints the model's own error, which says what to change in the input.

## Rules

- Your context's `# Media generation` section says whether the user can generate media. If it is off, don't try: tell the user what turns it on, as it says.
- Use Stella's models for generated media unless the task needs something they can't do. Calling providers directly bypasses the user's plan and Stella's copy of the files.
- Set the length and quality the user asked for; don't pick the most expensive options on your own (video bills per second, so set `duration` instead of leaving it to the model).
- **Signed out:** the error says to sign in. Stop, tell the Orchestrator to ask the user to sign in, and retry once they confirm. Don't loop.
- Still images in the chat are the Orchestrator's `image_gen`; use this skill for everything else, and for images when you need the files.
