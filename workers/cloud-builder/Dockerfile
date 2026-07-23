FROM docker.io/cloudflare/sandbox:0.12.4

USER root
WORKDIR /opt/stella

COPY .image/package.json ./
COPY .image/packages ./packages
RUN bun install --production

RUN mkdir -p /workspace \
  && ln -s /opt/stella/node_modules /opt/stella/packages/app-template/node_modules \
  && mkdir -p /opt/stella/node_modules/@stella \
  && ln -s /opt/stella/packages/apps-sdk /opt/stella/node_modules/@stella/apps-sdk \
  && ln -s "$(find /opt/stella/node_modules/.bun -path '*/vite/bin/vite.js' -print -quit)" /usr/local/bin/vite

EXPOSE 5173
