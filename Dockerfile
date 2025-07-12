# Этап сборки (builder)
FROM node:18-alpine as builder

# Устанавливаем системные зависимости + git для некоторых npm-пакетов
RUN apk add --no-cache openssl python3 make g++ git

WORKDIR /app

# 1. Копируем файлы зависимостей
COPY package.json package-lock.json ./
COPY prisma ./prisma/

# 2. Устанавливаем ВСЕ зависимости (включая devDependencies)
RUN npm install && \
    npm install --save-dev @types/nodemailer && \
    npm cache clean --force

# 3. Генерируем Prisma Client
RUN npx prisma generate

# 4. Копируем остальной код
COPY . .

# 5. Собираем проект
RUN npm run build

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