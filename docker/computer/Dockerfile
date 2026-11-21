FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends chromium ca-certificates coreutils \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /workspace/.browser-profile /opt/qingzhou \
    && chown -R node:node /workspace
COPY idle.mjs /opt/qingzhou/idle.mjs
COPY browser-server.mjs browser-client.mjs /opt/qingzhou/
ENV HOME=/workspace
ENV CHROMIUM_USER_DATA_DIR=/workspace/.browser-profile
WORKDIR /workspace
USER 1000:1000
CMD ["node", "/opt/qingzhou/idle.mjs"]
