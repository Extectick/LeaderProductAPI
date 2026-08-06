# syntax=docker/dockerfile:1.7
# ---- build stage ----
  FROM node:24-alpine AS builder
  WORKDIR /app
  ENV NPM_CONFIG_UPDATE_NOTIFIER=false
  ENV NPM_CONFIG_FUND=false
  ENV NPM_CONFIG_AUDIT=false
  ENV NPM_CONFIG_FETCH_RETRIES=5
  ENV NPM_CONFIG_FETCH_RETRY_FACTOR=2
  ENV NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000
  ENV NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000
  ENV PRISMA_CLI_BINARY_TARGETS=linux-musl-openssl-3.0.x
  
  # схема нужна ДО npm ci, чтобы Prisma packages видели конфигурацию проекта
  RUN apk add --no-cache openssl libc6-compat libstdc++
  COPY package*.json ./
  COPY prisma.config.js ./
  COPY scripts ./scripts
  COPY prisma ./prisma
  RUN --mount=type=cache,target=/root/.npm \
      for attempt in 1 2 3 4 5; do \
        npm ci --prefer-offline && break; \
        if [ "$attempt" = "5" ]; then exit 1; fi; \
        sleep 10; \
      done
  
  COPY tsconfig.json ./
  COPY src ./src
  
  # генерируем клиент и строим
  RUN for attempt in 1 2 3; do \
        npx prisma generate && break; \
        if [ "$attempt" = "3" ]; then exit 1; fi; \
        sleep 5; \
      done
  RUN npm run build
  # статические файлы debug-ui не попадают в dist при tsc
  RUN mkdir -p dist/middleware && cp -r src/middleware/debug-ui dist/middleware/
  
  # ---- runtime stage ----
  FROM node:24-alpine AS runner
  WORKDIR /app
  ENV NPM_CONFIG_UPDATE_NOTIFIER=false
  ENV NPM_CONFIG_FUND=false
  ENV NPM_CONFIG_AUDIT=false
  
  # зависимости для Prisma engines на Alpine (musl)
  RUN apk add --no-cache openssl libc6-compat libstdc++

  # Пользователь создаётся до COPY: --chown не требует многоминутного
  # рекурсивного прохода по node_modules при каждом изменении приложения.
  RUN addgroup -S app \
   && adduser -S -G app app \
   && mkdir -p /app/node_modules/prisma/engines /app/node_modules/.prisma \
   && chown app:app /app
  
  # копируем из этапа builder
  COPY --chown=app:app --from=builder /app/node_modules ./node_modules
  COPY --chown=app:app --from=builder /app/prisma ./prisma
  COPY --chown=app:app --from=builder /app/dist ./dist
  COPY --chown=app:app package*.json ./
  COPY --chown=app:app prisma.config.js ./
  COPY --chown=app:app scripts ./scripts
  RUN chown app:app /app/node_modules
  
  # оставляем только прод-зависимости (prisma у тебя в "dependencies", значит не удалится)
  USER app
  RUN npm prune --omit=dev
  
  ENV NODE_ENV=production
  ENV NODE_OPTIONS=--enable-source-maps
  EXPOSE 3000
  
  # (опционально) healthcheck
  HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
    CMD wget -qO- http://localhost:3000/ || exit 1
  
  # инициализируем БД (push/migrate) + seed при пустой базе и запускаем API
  CMD sh -c "node scripts/init-db.js && node dist/index.js"
  
