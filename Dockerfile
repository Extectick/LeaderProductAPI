# syntax=docker/dockerfile:1.7

# Shared native runtime for Prisma, bcrypt and sharp.
FROM node:24-alpine AS base
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_FACTOR=2 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000 \
    PRISMA_CLI_BINARY_TARGETS=linux-musl-openssl-3.0.x
RUN apk add --no-cache openssl libc6-compat libstdc++

# Build dependencies are cached only by package-lock.json. Prisma generation
# is explicit below, so schema/source changes no longer invalidate npm ci.
FROM base AS build-dependencies
ENV NODE_ENV=development \
    PRISMA_SKIP_POSTINSTALL_GENERATE=true
COPY package*.json ./
RUN --mount=type=cache,id=leader-api-npm,target=/root/.npm,sharing=shared \
    npm ci --include=dev --prefer-offline

# Production dependencies use an independent npm cache and can be installed in
# parallel with the build dependency tree. This is faster than copying the full
# tree and running a costly npm prune in the runtime stage.
FROM base AS production-dependencies
ENV NODE_ENV=production \
    PRISMA_SKIP_POSTINSTALL_GENERATE=true
COPY package*.json ./
RUN --mount=type=cache,id=leader-api-npm-prod,target=/root/.npm,sharing=shared \
    npm ci --omit=dev --prefer-offline

FROM build-dependencies AS builder
COPY prisma.config.js ./
COPY prisma ./prisma
COPY tsconfig.json ./
RUN npx prisma generate
COPY src ./src
RUN --mount=type=cache,id=leader-api-tsc,target=/app/.tsbuild,sharing=locked \
    echo "[build] compiling TypeScript" \
 && npm run build -- --incremental \
      --tsBuildInfoFile /app/.tsbuild/tsconfig.tsbuildinfo \
      --outDir /app/.tsbuild/dist \
 && find /app/.tsbuild/dist -type f -name '*.js' -exec sh -c \
      'for output do relative=${output#/app/.tsbuild/dist/}; source=/app/src/${relative%.js}.ts; [ -f "$source" ] || rm -f "$output"; done' sh {} + \
 && cp -a /app/.tsbuild/dist ./dist
# Static debug UI is not emitted by tsc.
RUN mkdir -p dist/middleware && cp -r src/middleware/debug-ui dist/middleware/

# Development target: dependencies and Prisma are built once; source files are
# mounted by docker-compose.dev.yml and nodemon restarts only the Node process.
FROM builder AS development
ENV NODE_ENV=development
COPY scripts ./scripts
CMD ["sh", "-c", "node scripts/init-db.js && npm run dev:docker"]

# Merge the generated Prisma client into the clean production dependency tree.
# The final image receives node_modules once, as one compact layer.
FROM production-dependencies AS runtime-dependencies
COPY --link --from=builder /app/node_modules/@prisma/client ./node_modules/@prisma/client
COPY --link --from=builder /app/node_modules/.prisma ./node_modules/.prisma

FROM base AS runner
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps

RUN addgroup -S -g 10001 app \
 && adduser -S -D -H -u 10001 -G app app \
 && chown app:app /app

COPY --link --chown=10001:10001 --from=runtime-dependencies /app/node_modules ./node_modules
COPY --link --chown=10001:10001 --from=builder /app/dist ./dist
COPY --link --chown=10001:10001 prisma ./prisma
COPY --link --chown=10001:10001 package*.json ./
COPY --link --chown=10001:10001 prisma.config.js ./
COPY --link --chown=10001:10001 scripts ./scripts

USER app
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://localhost:3000/ || exit 1

CMD ["sh", "-c", "node scripts/init-db.js && node dist/index.js"]
