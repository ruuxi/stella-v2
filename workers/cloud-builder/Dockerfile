FROM docker.io/cloudflare/sandbox:0.12.4

USER root
WORKDIR /opt/stella

COPY .image/package.json ./
COPY .image/packages ./packages
RUN bun install --production

RUN mkdir -p /workspace

EXPOSE 5173
