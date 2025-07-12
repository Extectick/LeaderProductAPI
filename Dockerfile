# Используем официальный образ Node.js на Alpine (легковесный)
FROM node:18-alpine

# Создаем рабочую директорию
WORKDIR /app

# Копируем package.json и package-lock.json (или yarn.lock)
COPY package*.json ./

# Устанавливаем зависимости
RUN npm install

# Копируем остальные файлы проекта
COPY . .

# Собираем TypeScript в JavaScript
RUN npm run build

# Открываем порт, который использует ваше приложение
EXPOSE 3000

# Запускаем приложение
CMD ["npm", "start"]