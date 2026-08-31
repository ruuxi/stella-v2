# stella-office

Repo-local CLI wrapper, vendored OfficeCLI source, and binary layout for Stella's bundled Office document command.

Native binaries are **not** stored in Git. The wrapper pins an OfficeCLI version in `package.json`. Desktop packaging and local `stella-office:download` fetch that version from [OfficeCLI GitHub Releases](https://github.com/iOfficeAI/OfficeCLI/releases) and verify `SHA256SUMS`.

## Layout

- `bin/stella-office.js` — fixed wrapper path used by Stella runtime
- `bin/stella-office-<platform>-<arch>` — native binary downloaded for the current or packaged platform (gitignored)
- `scripts/` — maintainer helpers for syncing version and downloading or building the native binary
- `vendor/officecli/` — trimmed upstream OfficeCLI snapshot kept for local build/version provenance

## Vendored Scope

The vendored `OfficeCLI` tree is intentionally trimmed to the parts Stella still needs:

- keep `src/`, `schemas/`, `skills/`, `plugins/`, `build.sh`, `SKILL.md`, `README.md`, `LICENSE`, `NOTICE`, `THIRD-PARTY-NOTICES.txt`, and `officecli.slnx`
- `schemas/` is required: the native binary embeds help schemas from that tree
- remove large showcase/demo payloads like `assets/`, `examples/`, translated READMEs, installer scripts, npm/sdk packages, and GitHub workflow metadata

If the vendored source is refreshed from upstream later, re-apply this trimming unless Stella starts depending on those extra files again.

## Maintainer Commands

```bash
npm run version:sync
npm run copy:native
npm run build:native
npm run download:native
```

From the repo root:

```bash
bun run stella-office:download
bun run stella-office:download -- --platform darwin-arm64 --force
```

- `version:sync` reads the vendored OfficeCLI project version and updates `package.json`
- `copy:native` copies a locally built vendored OfficeCLI binary into the fixed `bin/` naming convention
- `build:native` runs the vendored OfficeCLI build script for the current platform, then copies the binary
- `download:native` / `stella-office:download` downloads the pinned GitHub release artifact into `bin/` and checks its SHA-256
