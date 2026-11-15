# Multi-arch: builds unchanged on ARM64 (e.g. UGREEN DH4300 Plus) and x86-64.
# No native modules, so no compiler toolchain is needed.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    TZ=Europe/Lisbon \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY config ./config
RUN mkdir -p data logs && chown -R node:node /app
USER node
VOLUME ["/app/data", "/app/logs"]
CMD ["node", "dist/index.js"]
