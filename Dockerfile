# Используем официальный образ Node.js на Alpine (легковесный)
FROM node:18-alpine

# Устанавливаем зависимости для Prisma и других нативных модулей
RUN apk add --no-cache openssl

# Создаем рабочую директорию
WORKDIR /app

# 1. Сначала копируем только файлы, необходимые для установки зависимостей
COPY package*.json ./
COPY prisma ./prisma/

# 2. Устанавливаем зависимости
RUN npm install --production && \
    npx prisma generate && \
    npm cache clean --force

# 3. Копируем остальной код
COPY . .

# 4. Собираем проект
RUN npm run build

# 5. Удаляем ненужные файлы (опционально)
RUN rm -rf src node_modules/prisma

# Открываем порт
EXPOSE 3000

# Запускаем приложение с миграциями
CMD ["sh", "-c", "npx prisma migrate deploy && npm start"]