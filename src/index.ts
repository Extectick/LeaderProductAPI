// src/index.ts
import path from 'path';
import http from 'http';
import dotenv from 'dotenv';
import './env';
import express from 'express';
import { PrismaClient } from '@prisma/client';
import morgan from 'morgan';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import { Server as SocketIOServer } from 'socket.io';

// Routers
import authRouter from './routes/auth';
import usersRouter from './routes/users';
import qrRouter from './routes/qr';
import passwordResetRouter from './routes/passwordReset';
import appealsRouter from './routes/appeals';
import { connectRedis, disconnectRedis, getRedis, redisKeys } from './lib/redis';
import { cacheByUrl } from './middleware/cache';
// Swagger
import { swaggerSpec } from './swagger/swagger';

const ENV = process.env.NODE_ENV;

// ---- Load env by NODE_ENV ----
const envFile =
  ENV === 'production' ? '.env.production' :
  ENV === 'test'       ? '.env.test' :
                         '.env.dev';

// Error handler
import { errorHandler } from './middleware/errorHandler';

// S3 (MinIO) connectivity check
import { s3 } from './storage/minio';
import { HeadBucketCommand, ListBucketsCommand } from '@aws-sdk/client-s3';



dotenv.config({ path: path.resolve(process.cwd(), envFile) });

if (!process.env.DATABASE_URL) {
  throw new Error(`DATABASE_URL is missing (loaded ${envFile}).`);
}

const S3_BUCKET   = process.env.S3_BUCKET;
const S3_ENDPOINT = process.env.S3_ENDPOINT;
const STRICT_STARTUP = process.env.STRICT_STARTUP === '1';

const app = express();
const server = http.createServer(app);
const prisma = new PrismaClient();

const port = Number(process.env.PORT) || 3000;

// ---- CORS ----
const corsOrigins = ['http://localhost:8081', 'http://192.168.30.54:8081'];
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || corsOrigins.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
  })
);

// ---- Common middlewares ----
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.resolve(process.cwd(), 'uploads')));

// ---- Swagger ----
app.get('/docs.json', (_req, res) => res.json(swaggerSpec));
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// ---- Routes ----
app.use('/auth', authRouter);
app.use('/users', usersRouter);
app.use('/qr', qrRouter);
app.use('/password-reset', passwordResetRouter);
app.use('/appeals', cacheByUrl(15), appealsRouter);

// ---- Errors ----
app.use(errorHandler);

// --------------------
// Connectivity checks
// --------------------
async function checkDatabase() {
  try {
    // подключаемся и делаем простейший запрос
    await prisma.$connect();
    const r = await prisma.$queryRawUnsafe<{ result: number }[]>('SELECT 1+1 AS result');
    return { ok: true, result: r?.[0]?.result ?? 2 };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

async function checkRedis() {
  try {
    const client = getRedis();
    if (!client.isOpen) await client.connect();
    const pong = await client.ping();
    return { ok: pong === 'PONG' };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

async function checkS3() {
  if (!S3_ENDPOINT || !S3_BUCKET) {
    return { ok: false, error: 'S3_ENDPOINT or S3_BUCKET not set', endpoint: S3_ENDPOINT, bucket: S3_BUCKET };
  }
  try {
    // проверяем креды и доступность API
    await s3.send(new ListBucketsCommand({}));
    // проверяем, что бакет существует и доступен
    await s3.send(new HeadBucketCommand({ Bucket: S3_BUCKET }));
    return { ok: true, endpoint: S3_ENDPOINT, bucket: S3_BUCKET };
  } catch (e: any) {
    return { ok: false, endpoint: S3_ENDPOINT, bucket: S3_BUCKET, error: e?.message || String(e) };
  }
}

async function startupChecks() {
  console.log(`[startup] ENV file loaded: ${envFile}`);
  const [db, s3status, redis] = await Promise.all([checkDatabase(), checkS3(), checkRedis()]);

  if (db.ok)  console.log('[startup] DB connection: OK');
  else        console.error('[startup] DB connection: FAIL ->', db.error);

  if (s3status.ok) console.log('[startup] S3 (MinIO) connection: OK', { endpoint: s3status.endpoint, bucket: s3status.bucket });
  else             console.error('[startup] S3 (MinIO) connection: FAIL ->', s3status.error);

  if (redis.ok) console.log('[startup] Redis connection: OK');
  else          console.error('[startup] Redis connection: FAIL ->', redis.error);

  const allOk = db.ok && s3status.ok && redis.ok;
  if (!allOk && STRICT_STARTUP) {
    console.error('[startup] STRICT_STARTUP=1 -> exiting due to failed connectivity checks');
    process.exit(1);
  }
  return { db, s3: s3status, redis, ok: allOk };
}

// ---- Health endpoints ----
app.get('/health', async (_req, res) => {
  const [db, s3status] = await Promise.all([checkDatabase(), checkS3()]);
  const ok = db.ok && s3status.ok;
  return res.status(ok ? 200 : 500).json({
    ok,
    env: ENV || 'dev',
    timestamp: new Date().toISOString(),
    services: { db, s3: s3status },
  });
});

// (оставим корень тоже как health, чтобы не ломать привычку)
app.get('/', async (_req, res) => {
  const [db, s3status] = await Promise.all([checkDatabase(), checkS3()]);
  const ok = db.ok && s3status.ok;
  return res.status(ok ? 200 : 500).json({
    message: 'Server is running',
    ok,
    docs: `/docs`,
    services: { db, s3: s3status },
  });
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
  socket.on('join', (room: string) => { if (room) socket.join(room); });
  socket.on('leave', (room: string) => { if (room) socket.leave(room); });
});

// ---- Start ----
if (ENV !== 'test') {
  (async () => {
    await startupChecks(); // не падаем, если STRICT_STARTUP != 1
    await connectRedis();
    server.listen(port, () => {
      console.log(`Server is running on http://localhost:${port}`);
      console.log(`Docs:   http://localhost:${port}/docs`);
    });
  })();
}

// ---- Graceful shutdown ----
process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down...');
  await prisma.$disconnect().catch(() => {});
  await disconnectRedis().catch(() => {});
  server.close(() => process.exit(0));
});
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down...');
  await prisma.$disconnect().catch(() => {});
  await disconnectRedis().catch(() => {});
  server.close(() => process.exit(0));
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

export default app;
