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
# Deliberately excluded: LibreOffice (+501 MB) so there is no Office-to-PDF
# conversion, ffmpeg (+294 MB) so there is no transcoding or frame extraction,
# ghostscript (+53 MB) and tesseract OCR (+25 MB) so scanned PDFs stay opaque.
RUN DEBIAN_FRONTEND=noninteractive apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    poppler-utils \
    mediainfo \
    libicu70 \
    fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

COPY .image/package.json ./
COPY .image/packages ./packages
COPY .image/interior-seed.json ./interior-seed.json
RUN bun install --production

# The checked-in stella-office binaries are macOS-only and are filtered out of
# the image staging; fetch the matching Linux build instead. The package's own
# downloader owns the release URL and the platform-to-asset mapping.
RUN node packages/stella-office/scripts/download-native.js

RUN mkdir -p /workspace \
  && ln -s /opt/stella/node_modules /opt/stella/packages/app-template/node_modules \
  && mkdir -p /opt/stella/node_modules/@stella \
  && ln -s /opt/stella/packages/apps-sdk /opt/stella/node_modules/@stella/apps-sdk \
  && ln -s /opt/stella/node_modules/vite/bin/vite.js /usr/local/bin/vite \
  && ln -s /opt/stella/node_modules/.bin/claude /usr/local/bin/claude \
  && ln -s /opt/stella/node_modules/.bin/codex /usr/local/bin/codex

EXPOSE 5173
