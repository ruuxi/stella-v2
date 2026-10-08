FROM docker.io/oven/bun:1.4.2-debian@sha256:4f6e31d1a54d6a3dd312daef655fc998101b5043d52e12592ac293ef04b9bc73 AS bun-runtime
FROM docker.io/library/node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS node-runtime
FROM docker.io/cloudflare/sandbox:1.0.0@sha256:5bc187515bad0d9d486a4f1476f7d8ad39fe97c57965f044e4b0a0dcc93eac06 AS sandbox-tools

# The Sandbox Durable Object drives this container directly through
# `ctx.container`; nothing in the image serves a control plane. It keeps the
# Ubuntu 22.04 userland the 0.12 `cloudflare/sandbox` base provided, minus that
# base's command server, FUSE/s3fs mounts, and tunnel client, none of which the
# Durable Object uses.
FROM docker.io/library/ubuntu:22.04@sha256:b8b6ee6aa931ecd9d0d952abc34dc0e5f7c6a30c6bb71b079fe399fde0329c02

COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
# `Files` in @cloudflare/sandbox runs this helper for every file operation.
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

USER root
WORKDIR /opt/stella

# The userland the 0.12 base image shipped, which agents rely on:
#   ca-certificates curl wget procps git unzip zip jq file inotify-tools and
#   the shared libraries its toolchain linked against.
# Document and media capability stack on top of it:
#   poppler-utils      pdftotext / pdfinfo / pdftoppm / pdfimages / pdfseparate
#                      / pdfunite — every PDF text and page operation (+12.8 MB)
#   mediainfo          codec, duration and dimension probing for audio and video
#                      at 1/40th the size of ffmpeg (+7.2 MB)
#   libicu70           the OfficeCLI binary is a self-contained .NET build and
#                      refuses to start without ICU
#   fonts-dejavu-core  pdftoppm renders blank glyphs for PDFs that do not embed
#                      their fonts
#   squashfs-tools     deterministic Stella-addressed native state archives
#   tini               PID 1: reaps the daemons that `setsid --fork` orphans
# Deliberately excluded: LibreOffice (+501 MB) so there is no Office-to-PDF
# conversion, ffmpeg (+294 MB) so there is no transcoding or frame extraction,
# ghostscript (+53 MB) and tesseract OCR (+25 MB) so scanned PDFs stay opaque.
RUN DEBIAN_FRONTEND=noninteractive apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates curl wget procps git unzip zip jq file inotify-tools \
    libssl3 zlib1g libbz2-1.0 libreadline8 libsqlite3-0 libncursesw6 \
    libtinfo6 libxml2 libffi8 liblzma5 \
    poppler-utils \
    mediainfo \
    libicu70 \
    fonts-dejavu-core \
    util-linux \
    squashfs-tools \
    tini \
  && update-ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Third-party packages only. Stella's own code is not in the image: each
# container fetches the code bundle its Worker version names, checks its
# SHA-256 and installs it under /run/stella-code at start
# (bin/stella-code-install), so a deploy of Stella source leaves this image,
# and every snapshot taken from it, unchanged.
COPY .image/package.json ./
COPY .image/bun.lock ./bun.lock
COPY .image/image-build.json ./image-build.json
RUN node --input-type=commonjs -e \
      'const fs = require("node:fs"); const crypto = require("node:crypto"); const childProcess = require("node:child_process"); const metadata = JSON.parse(fs.readFileSync("image-build.json", "utf8")); const digest = `sha256:${crypto.createHash("sha256").update(fs.readFileSync("bun.lock")).digest("hex")}`; const bunVersion = childProcess.execFileSync("bun", ["--version"], { encoding: "utf8" }).trim(); if (metadata.dependencyLockSha256 !== digest) throw new Error("Sandbox image lock digest mismatch"); if (metadata.sandboxSdkVersion !== "1.0.0") throw new Error("Sandbox SDK and sandbox-tools image versions differ"); if (bunVersion !== "1.4.2") throw new Error("Sandbox image Bun version differs from the pinned lock runtime");' \
  && bun install --production --frozen-lockfile --linker isolated \
  # Claude Code ships glibc and musl native builds as optional packages; this
  # image is glibc, so the 258 MB musl binary is dead weight.
  && rm -rf node_modules/.bun/@anthropic-ai+claude-code-linux-x64-musl@* \
  # Bun's download cache (~700 MB) is only for installs; the image never
  # installs again.
  && rm -rf /root/.bun/install/cache

# The checked-in stella-office binaries are macOS-only and are filtered out of
# the image staging; fetch the matching Linux build instead. The package's own
# downloader owns the release URL and the platform-to-asset mapping.
COPY .image/packages ./packages
RUN node packages/stella-office/scripts/download-native.js

# The code bundle's installer and the executor entrypoint that runs it.
COPY --chmod=0755 .image/bin ./bin

# Native CLI resume authority is root-only. Model-authored shell commands run
# as stella-tools and cannot traverse its fixed directory. The tool identity
# still owns the intended workspace root. It may traverse `/workspace`, but
# cannot rename that root entry and replace the boundary anchor with a symlink.
RUN groupadd --system --gid 42424 stella-tools \
  && useradd --system --uid 42424 --gid stella-tools --no-create-home \
    --home-dir /nonexistent --shell /usr/sbin/nologin stella-tools \
  && test ! -L /home \
  && if [ -e /home/stella-native-state ] || [ -L /home/stella-native-state ]; then \
       test -d /home/stella-native-state && test ! -L /home/stella-native-state; \
     else mkdir /home/stella-native-state; fi \
  && chown root:root /home/stella-native-state \
  && chmod 0700 /home/stella-native-state \
  && if [ -e /home/stella-host-state ] || [ -L /home/stella-host-state ]; then \
       test -d /home/stella-host-state && test ! -L /home/stella-host-state; \
     else mkdir /home/stella-host-state; fi \
  && chown root:root /home/stella-host-state \
  && chmod 0700 /home/stella-host-state \
  && if [ -e /workspace ] || [ -L /workspace ]; then \
       test -d /workspace && test ! -L /workspace; \
     else mkdir /workspace; fi \
  && chown root:stella-tools /workspace \
  && chmod 0750 /workspace \
  && test "$(readlink -f /home/stella-native-state)" = /home/stella-native-state \
  && test "$(stat -c '%u:%g:%a' /home/stella-native-state)" = 0:0:700 \
  && test "$(readlink -f /home/stella-host-state)" = /home/stella-host-state \
  && test "$(stat -c '%u:%g:%a' /home/stella-host-state)" = 0:0:700 \
  && test "$(readlink -f /workspace)" = /workspace \
  && test "$(stat -c '%u:%g:%a' /workspace)" = 0:42424:750 \
  && test "$(readlink -f /usr/bin/setpriv)" = /usr/bin/setpriv \
  && test "$(stat -c '%u:%g:%a:%h' /usr/bin/setpriv)" = 0:0:755:1 \
  && test ! -e /opt/stella/node_modules/@stella \
  && test "$(stat -c '%u:%g:%a' /opt/stella/bin/stella-code-install)" = 0:0:755 \
  && test "$(stat -c '%u:%g:%a' /opt/stella/bin/stella-executor)" = 0:0:755 \
  && ln -s /opt/stella/node_modules/.bin/claude /usr/local/bin/claude

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
