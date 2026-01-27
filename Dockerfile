# ---- build stage ----
  FROM node:20-alpine AS builder
  WORKDIR /app
  
  # схема нужна ДО npm ci (postinstall: prisma generate)
  COPY package*.json ./
  COPY prisma.config.js ./
  COPY prisma ./prisma
  RUN npm ci
  
  COPY tsconfig.json ./
  COPY src ./src
  
  # генерируем клиент и строим
  RUN npx prisma generate
  RUN npm run build
  # статические файлы debug-ui не попадают в dist при tsc
  RUN mkdir -p dist/middleware && cp -r src/middleware/debug-ui dist/middleware/
  
  # ---- runtime stage ----
  FROM node:20-alpine AS runner
  WORKDIR /app
  
  # зависимости для Prisma engines на Alpine (musl)
  RUN apk add --no-cache openssl libc6-compat libstdc++
  
  # копируем из этапа builder
  COPY --from=builder /app/node_modules ./node_modules
  COPY --from=builder /app/prisma ./prisma
  COPY --from=builder /app/dist ./dist
  COPY package*.json ./
  COPY prisma.config.js ./
  
  # оставляем только прод-зависимости (prisma у тебя в "dependencies", значит не удалится)
  RUN npm prune --production
  
  # создаём пользователя и выдаём права ОДИН РАЗ
  RUN addgroup -S app \
   && adduser -S -G app app \
   && mkdir -p /app/node_modules/prisma/engines /app/node_modules/.prisma \
   && chown -R app:app /app
  
  ENV NODE_ENV=production
  ENV NODE_OPTIONS=--enable-source-maps
  EXPOSE 3000
  
  # (опционально) healthcheck
  HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
    CMD wget -qO- http://localhost:3000/ || exit 1
  
  USER app
  
  # применяем миграции и запускаем API
  CMD sh -c "npx prisma migrate deploy && node dist/index.js"
  
