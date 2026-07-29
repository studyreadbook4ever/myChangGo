# syntax=docker/dockerfile:1.7

FROM node:24.18.0-bookworm-slim AS build
WORKDIR /workspace

COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/client/package.json packages/client/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/node/package.json packages/node/package.json
COPY packages/cloudflare/package.json packages/cloudflare/package.json
COPY examples/live-race/package.json examples/live-race/package.json
RUN npm ci

COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY examples/live-race ./examples/live-race
RUN npm run build
RUN npm prune --omit=dev

FROM node:24.18.0-bookworm-slim AS relayplay
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/packages/core/package.json ./packages/core/package.json
COPY --from=build /workspace/packages/core/dist ./packages/core/dist
COPY --from=build /workspace/packages/server/package.json ./packages/server/package.json
COPY --from=build /workspace/packages/server/dist ./packages/server/dist
COPY --from=build /workspace/packages/node/package.json ./packages/node/package.json
COPY --from=build /workspace/packages/node/dist ./packages/node/dist
COPY --from=build /workspace/packages/node/node_modules ./packages/node/node_modules
COPY --from=build /workspace/examples/live-race/dist-node ./examples/live-race/dist-node

RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "examples/live-race/dist-node/node/index.js"]

FROM caddy:2.11.3-alpine AS web
COPY deploy/on-prem/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /workspace/examples/live-race/dist /srv
