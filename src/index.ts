import path from 'path';
import dotenv from 'dotenv';

import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import morgan from 'morgan';

import authRouter from './routes/auth';
import usersRouter from './routes/users';
import qrRouter from './routes/qr';
import passwordResetRouter from './routes/passwordReset';
import appealsRouter from './routes/appeals';
import cors from 'cors';
import { errorHandler } from './middleware/errorHandler';

const envFile =
  process.env.NODE_ENV === 'production'
    ? '.env.production'
    : '.env.dev';

dotenv.config({ path: path.resolve(process.cwd(), envFile) });

const app = express();

// Создаем HTTP-сервер и Socket.IO сервер
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: ['http://localhost:8081', 'http://192.168.30.54:8081', '*'],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true,
  },
});

// Сохраняем экземпляр io в приложении, чтобы использовать его в роутерах
app.set('io', io);

if (!process.env.DATABASE_URL) {
  throw new Error(`DATABASE_URL is missing (loaded ${envFile}).`);
}
const prisma = new PrismaClient();

const port = process.env.PORT || 3000;

app.use(cors({
  origin: ['http://localhost:8081', 'http://192.168.30.54:8081', '*'],
  credentials: true,
}));
app.use(morgan('dev'));
app.use(express.json());

// Подключаем роутеры
app.use('/auth', authRouter);
app.use('/users', usersRouter);
app.use('/qr', qrRouter);
app.use('/password-reset', passwordResetRouter);
app.use('/appeals', appealsRouter);

// Общий обработчик ошибок
app.use(errorHandler);

// Тестовый роут для проверки подключения к БД
app.get('/', async (req, res) => {
  try {
    const result = await prisma.$queryRaw`SELECT 1+1 AS result`;
    res.json({ message: 'Server is running', dbTest: result });
  } catch (error) {
    res.status(500).json({ error: 'Database connection failed', details: error });
  }
});

// Настраиваем обработчики подключений WebSocket
io.on('connection', (socket) => {
  console.log('WebSocket подключен:', socket.id);

  // Клиент может подписаться на комнату (например, department:ID, user:ID, appeal:ID)
  socket.on('subscribe', ({ room }) => {
    if (room) {
      socket.join(room);
    }
  });

  socket.on('disconnect', () => {
    console.log('WebSocket отключен:', socket.id);
  });
});

// Запуск сервера
server.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});

export default app;
