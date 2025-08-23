// src/index.ts
import path from 'path';
import http from 'http';
import dotenv from 'dotenv';
import express from 'express';
import { PrismaClient } from '@prisma/client';
import morgan from 'morgan';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import { Server as SocketIOServer } from 'socket.io';

import authRouter from './routes/auth';
import usersRouter from './routes/users';
import qrRouter from './routes/qr';
import passwordResetRouter from './routes/passwordReset';
import appealsRouter from './routes/appeals';
import { swaggerSpec } from './swagger/swagger';
import { errorHandler } from './middleware/errorHandler';

const ENV = process.env.NODE_ENV;

const envFile =
  ENV === 'production'
    ? '.env.production'
    : ENV === 'test'
    ? '.env.test'
    : '.env.dev';

dotenv.config({ path: path.resolve(process.cwd(), envFile) });

if (!process.env.DATABASE_URL) {
  throw new Error(`DATABASE_URL is missing (loaded ${envFile}).`);
}

const app = express();
const server = http.createServer(app);
const prisma = new PrismaClient();

const port = process.env.PORT || 3000;

// ---- CORS ----
const corsOrigins = ['http://localhost:8081', 'http://192.168.30.54:8081'];
app.use(
  cors({
    origin: (origin, cb) => {
      // Разрешаем запросы без Origin (например, Postman) и из перечисленных источников
      if (!origin || corsOrigins.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
  })
);

// ---- common middlewares ----
app.use(morgan('dev'));
app.use(express.json());

// Раздача статических файлов из /uploads (вложения)
app.use('/uploads', express.static(path.resolve(process.cwd(), 'uploads')));

// ---- Swagger ----
// JSON спецификация
app.get('/docs.json', (_req, res) => res.json(swaggerSpec));
// Интерактивная документация
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// ---- Routes ----
app.use('/auth', authRouter);
app.use('/users', usersRouter);
app.use('/qr', qrRouter);
app.use('/password-reset', passwordResetRouter);
app.use('/appeals', appealsRouter);

// ---- Errors ----
app.use(errorHandler);

// ---- Health ----
app.get('/', async (_req, res) => {
  try {
    const result = await prisma.$queryRaw`SELECT 1+1 AS result`;
    res.json({ message: 'Server is running', dbTest: result });
  } catch (error) {
    res.status(500).json({ error: 'Database connection failed', details: error });
  }
});

// ---- Socket.IO ----
const io = new SocketIOServer(server, {
  cors: {
    origin: corsOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
  },
});
app.set('io', io);

io.on('connection', (socket) => {
  // Можно логировать и подписывать на комнаты по вашему протоколу
  // console.log('socket connected', socket.id);
  socket.on('join', (room: string) => {
    if (room) socket.join(room);
  });
  socket.on('leave', (room: string) => {
    if (room) socket.leave(room);
  });
  socket.on('disconnect', () => {
    // console.log('socket disconnected', socket.id);
  });
});

// ---- Start (не слушаем порт в тестах) ----
if (ENV !== 'test') {
  server.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
    console.log(`Docs: http://localhost:${port}/docs`);
  });
}

export default app;
