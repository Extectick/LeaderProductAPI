FROM node:18-alpine AS builder

WORKDIR /app

COPY package*.json ./
COPY prisma/schema.prisma ./prisma/schema.prisma
COPY src/prisma/seed.ts ./src/prisma/seed.ts
COPY .env ./
RUN npm install

COPY . .

# Компиляция TypeScript (если нужно)
RUN npm run build

# Установка ts-node глобально для запуска seed (если не компилируете seed)
RUN npm install -g ts-node typescript

ENV NODE_ENV=production

# Финальный образ (production)
FROM node:18-alpine

WORKDIR /app

# Устанавливаем runtime зависимости
RUN apk add --no-cache openssl

# Копируем только необходимое из builder stage
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json .
COPY --from=builder /app/.env .
COPY --from=builder /app/src/prisma/seed.ts ./src/prisma/seed.ts

# Финализация образа
RUN npx prisma generate && \
    npm prune --production && \
    rm -rf /tmp/* /var/cache/apk/* /root/.npm /root/.cache

# Установка ts-node для выполнения seed
RUN npm install -g ts-node typescript

EXPOSE 3000
EXPOSE 5555

# Запуск с проверкой миграций, выполнением seed, запуском prisma studio и основного приложения
# CMD ["sh", "-c", "npx prisma migrate deploy && npm run db:seed && npm run prisma:studio & node dist/index.js"]
CMD ["sh", "-c", "npm run prisma:studio & node dist/index.js"]
