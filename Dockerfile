FROM node:18-alpine AS builder

WORKDIR /app

COPY package*.json ./
COPY prisma/schema.prisma ./prisma/schema.prisma
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

# Финализация образа
RUN npx prisma generate && \
    npm prune --production && \
    rm -rf /tmp/* /var/cache/apk/* /root/.npm /root/.cache

EXPOSE 3000

# Запуск с проверкой миграций
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
