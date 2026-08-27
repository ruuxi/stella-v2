FROM docker.io/cloudflare/sandbox:0.12.4

USER root
WORKDIR /opt/stella

# Document and media capability stack. The base image is Ubuntu 22.04 and
# already ships git, jq, file, node and bun; these are the pieces it lacks.
#   poppler-utils      pdftotext / pdfinfo / pdftoppm / pdfimages / pdfseparate
#                      / pdfunite — every PDF text and page operation (+12.8 MB)
#   mediainfo          codec, duration and dimension probing for audio and video
#                      at 1/40th the size of ffmpeg (+7.2 MB)
#   libicu70           the OfficeCLI binary is a self-contained .NET build and
#                      refuses to start without ICU; already pulled in by the
#                      base image's libxml2, pinned here so it stays (+0 MB)
#   fonts-dejavu-core  pdftoppm renders blank glyphs for PDFs that do not embed
#                      their fonts; already present via libtk8.6 (+0 MB)
#   squashfs-tools     deterministic Stella-addressed workspace/native state
#                      archives, outside the SDK's opaque random backup ids
# Deliberately excluded: LibreOffice (+501 MB) so there is no Office-to-PDF
# conversion, ffmpeg (+294 MB) so there is no transcoding or frame extraction,
# ghostscript (+53 MB) and tesseract OCR (+25 MB) so scanned PDFs stay opaque.
RUN DEBIAN_FRONTEND=noninteractive apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    poppler-utils \
    mediainfo \
    libicu70 \
    fonts-dejavu-core \
    util-linux \
    squashfs-tools \
  && rm -rf /var/lib/apt/lists/*

COPY .image/package.json ./
COPY .image/packages ./packages
COPY .image/interior-seed.json ./interior-seed.json
RUN bun install --production

# The checked-in stella-office binaries are macOS-only and are filtered out of
# the image staging; fetch the matching Linux build instead. The package's own
# downloader owns the release URL and the platform-to-asset mapping.
RUN node packages/stella-office/scripts/download-native.js

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
  && ln -s /opt/stella/node_modules /opt/stella/packages/app-template/node_modules \
  && mkdir -p /opt/stella/node_modules/@stella \
  && ln -s /opt/stella/packages/apps-sdk /opt/stella/node_modules/@stella/apps-sdk \
  && ln -s /opt/stella/node_modules/vite/bin/vite.js /usr/local/bin/vite \
  && ln -s /opt/stella/node_modules/.bin/claude /usr/local/bin/claude \
  && ln -s /opt/stella/node_modules/.bin/codex /usr/local/bin/codex

EXPOSE 5173
