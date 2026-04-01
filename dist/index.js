"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.prisma = void 0;
// src/index.ts
const path_1 = __importDefault(require("path"));
const http_1 = __importDefault(require("http"));
// import dotenv from 'dotenv';
require("./env"); // ❌ убираем, чтобы .env не грузился дважды
const express_1 = __importDefault(require("express"));
const morgan_1 = __importDefault(require("morgan"));
const cors_1 = __importDefault(require("cors"));
const swagger_ui_express_1 = __importDefault(require("swagger-ui-express"));
const socket_io_1 = require("socket.io");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const client_1 = __importDefault(require("./prisma/client"));
exports.prisma = client_1.default;
// Routers
const auth_1 = __importDefault(require("./routes/auth"));
const users_1 = __importDefault(require("./routes/users"));
const qr_1 = __importDefault(require("./routes/qr"));
const passwordReset_1 = __importDefault(require("./routes/passwordReset"));
const appeals_1 = __importDefault(require("./routes/appeals"));
const departments_1 = __importDefault(require("./routes/departments"));
const tracking_1 = __importDefault(require("./routes/tracking"));
const updates_1 = __importDefault(require("./routes/updates"));
const files_1 = __importDefault(require("./routes/files"));
const services_1 = __importDefault(require("./routes/services"));
const stockBalances_1 = __importDefault(require("./routes/stockBalances"));
const notifications_1 = __importDefault(require("./routes/notifications"));
const home_1 = __importDefault(require("./routes/home"));
const onec_routes_1 = __importDefault(require("./modules/onec/onec.routes"));
const marketplace_routes_1 = __importDefault(require("./modules/marketplace/marketplace.routes"));
const scheduledJobsService_1 = require("./services/scheduledJobsService");
const redis_1 = require("./lib/redis");
const cache_1 = require("./middleware/cache");
const presenceService_1 = require("./services/presenceService");
const telegramBotService_1 = require("./services/telegramBotService");
const maxBotService_1 = require("./services/maxBotService");
// Swagger
const swagger_1 = require("./swagger/swagger");
const ENV = process.env.NODE_ENV;
// ---- Load env by NODE_ENV ----
const envFile = ENV === 'production' ? '.env.production' :
    ENV === 'test' ? '.env.test' :
        '.env.dev';
// Error handler
const errorHandler_1 = require("./middleware/errorHandler");
// S3 (MinIO) connectivity check
const minio_1 = require("./storage/minio");
const client_s3_1 = require("@aws-sdk/client-s3");
const requestDebug_1 = require("./middleware/requestDebug");
const kafkaRequestLogger_1 = require("./middleware/kafkaRequestLogger");
const kafka_1 = require("./lib/kafka");
// dotenv.config({ path: path.resolve(process.cwd(), envFile) });
if (!process.env.DATABASE_URL) {
    throw new Error(`DATABASE_URL is missing (loaded ${envFile}).`);
}
const S3_BUCKET = process.env.S3_BUCKET;
const S3_ENDPOINT = process.env.S3_ENDPOINT;
const STRICT_STARTUP = process.env.STRICT_STARTUP === '1';
const accessTokenSecret = process.env.ACCESS_TOKEN_SECRET || 'youraccesstokensecret';
const app = (0, express_1.default)();
const server = http_1.default.createServer(app);
// Отключаем ETag, чтобы исключить 304 без тела на API-ответах
app.set('etag', false);
const port = Number(process.env.PORT) || 3000;
// ---- CORS ----
// Разрешаем все origin, чтобы веб и мобильные клиенты работали из любой сети.
// Если понадобится ограничение по доменам, верните проверку и список разрешённых.
const corsOrigins = [];
// Ручной preflight, чтобы гарантировать заголовки даже если cors не сработал
app.use((req, res, next) => {
    const origin = req.headers.origin;
    res.header('Access-Control-Allow-Origin', origin || '*');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] ||
        'Content-Type, Authorization, X-Requested-With');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    next();
});
app.use((0, cors_1.default)({
    origin: true, // allow all origins
    credentials: true,
}));
// ---- Common middlewares ----
app.use((0, morgan_1.default)('dev'));
app.use(express_1.default.json({ limit: '1mb' }));
app.use(express_1.default.urlencoded({ extended: true, limit: '1mb' }));
app.use('/uploads', express_1.default.static(path_1.default.resolve(process.cwd(), 'uploads')));
app.use(kafkaRequestLogger_1.kafkaRequestLogger);
const allowDebugInProd = process.env.ALLOW_DEBUG_IN_PROD === '1';
if (process.env.DEBUG_REQUESTS === '1' && (process.env.NODE_ENV !== 'production' || allowDebugInProd)) {
    app.use(requestDebug_1.requestDebugMiddleware);
    (0, requestDebug_1.requestDebugRoutes)(app);
    console.log('[debug] Request dashboard enabled at /_debug/requests (and .json).');
}
// ---- Swagger ----
app.get('/docs.json', (_req, res) => res.json(swagger_1.swaggerSpec));
app.use('/docs', swagger_ui_express_1.default.serve, swagger_ui_express_1.default.setup(swagger_1.swaggerSpec));
// ---- Routes ----
app.use('/auth', auth_1.default);
app.use('/users', users_1.default);
app.use('/departments', departments_1.default);
app.use('/qr', qr_1.default);
app.use('/password-reset', passwordReset_1.default);
app.use('/tracking', tracking_1.default);
app.use('/services', services_1.default);
app.use('/stock-balances', stockBalances_1.default);
app.use('/home', home_1.default);
app.use('/updates', updates_1.default);
app.use('/update-files', files_1.default);
app.use('/files', files_1.default);
app.use('/notifications', notifications_1.default);
app.use('/api/1c', onec_routes_1.default);
app.use('/api/marketplace', marketplace_routes_1.default);
app.use('/appeals', (0, cache_1.cacheByUrl)(15, {
    include: /^\/appeals(\/\d+)?(\?.*)?$/i, // кэшируем список и детали
    exclude: /\/appeals\/\d+\/(messages|assign|status|watchers|claim|department)/i, // исключаем мутации
    varyByAuth: true,
    cacheStatuses: [200],
}), appeals_1.default);
// ---- Errors ----
app.use(errorHandler_1.errorHandler);
// --------------------
// Connectivity checks
// --------------------
async function checkDatabase() {
    try {
        await client_1.default.$connect();
        const r = await client_1.default.$queryRawUnsafe('SELECT 1+1 AS result');
        return { ok: true, result: r?.[0]?.result ?? 2 };
    }
    catch (e) {
        return { ok: false, error: e?.message || String(e) };
    }
}
// ВНИМАНИЕ: не вызываем connect() здесь, только ping(), если уже подключены
async function checkRedis() {
    try {
        const client = (0, redis_1.getRedis)();
        if (!client.isOpen) {
            return { ok: false, error: 'Redis is not connected' };
        }
        const pong = await client.ping();
        return { ok: pong === 'PONG' };
    }
    catch (e) {
        return { ok: false, error: e?.message || String(e) };
    }
}
async function checkS3() {
    if (!S3_ENDPOINT || !S3_BUCKET) {
        return { ok: false, error: 'S3_ENDPOINT or S3_BUCKET not set', endpoint: S3_ENDPOINT, bucket: S3_BUCKET };
    }
    try {
        await minio_1.s3.send(new client_s3_1.ListBucketsCommand({}));
        await minio_1.s3.send(new client_s3_1.HeadBucketCommand({ Bucket: S3_BUCKET }));
        return { ok: true, endpoint: S3_ENDPOINT, bucket: S3_BUCKET };
    }
    catch (e) {
        return { ok: false, endpoint: S3_ENDPOINT, bucket: S3_BUCKET, error: e?.message || String(e) };
    }
}
async function startupChecks() {
    console.log(`[startup] ENV file loaded: ${envFile}`);
    // Redis уже подключён к этому моменту, можно пинговать параллельно с DB/S3
    const [db, s3status, redis] = await Promise.all([checkDatabase(), checkS3(), checkRedis()]);
    if (db.ok)
        console.log('[startup] DB connection: OK');
    else
        console.error('[startup] DB connection: FAIL ->', db.error);
    if (s3status.ok)
        console.log('[startup] S3 (MinIO) connection: OK', { endpoint: s3status.endpoint, bucket: s3status.bucket });
    else
        console.error('[startup] S3 (MinIO) connection: FAIL ->', s3status.error);
    if (redis.ok)
        console.log('[startup] Redis connection: OK');
    else
        console.error('[startup] Redis connection: FAIL ->', redis.error);
    const allOk = db.ok && s3status.ok && redis.ok;
    if (!allOk && STRICT_STARTUP) {
        console.error('[startup] STRICT_STARTUP=1 -> exiting due to failed connectivity checks');
        process.exit(1);
    }
    return { db, s3: s3status, redis, ok: allOk };
}
// ---- Health endpoints ----
app.get('/health', async (_req, res) => {
    const [db, s3status, redis] = await Promise.all([checkDatabase(), checkS3(), checkRedis()]);
    const ok = db.ok && s3status.ok && redis.ok;
    return res.status(ok ? 200 : 500).json({
        ok,
        env: ENV || 'dev',
        timestamp: new Date().toISOString(),
        services: { db, s3: s3status, redis },
    });
});
// (оставим корень тоже как health)
app.get('/', async (_req, res) => {
    const [db, s3status, redis] = await Promise.all([checkDatabase(), checkS3(), checkRedis()]);
    const ok = db.ok && s3status.ok && redis.ok;
    return res.status(ok ? 200 : 500).json({
        message: 'Server is running',
        ok,
        docs: `/docs`,
        services: { db, s3: s3status, redis },
    });
});
// ---- Socket.IO ----
const io = new socket_io_1.Server(server, {
    cors: {
        origin: true,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        credentials: true,
    },
});
app.set('io', io);
const userSocketCounts = new Map();
const userFocusedSocketCounts = new Map();
const userPresenceRefreshTimers = new Map();
const PRESENCE_REFRESH_MS = Math.max(15000, Number(process.env.PRESENCE_REFRESH_MS || 30000));
function normalizePresenceUserIds(value) {
    const raw = Array.isArray(value)
        ? value
        : value?.userIds && Array.isArray(value.userIds)
            ? value.userIds
            : [];
    return Array.from(new Set(raw
        .map((item) => Number(item))
        .filter((id) => Number.isFinite(id) && id > 0)));
}
function emitPresenceChanged(userId, isOnline, lastSeenAt) {
    io.to(`presence:${userId}`).emit('presenceChanged', {
        userId,
        isOnline,
        lastSeenAt: lastSeenAt ? lastSeenAt.toISOString() : null,
    });
}
function startPresenceRefresh(userId) {
    if (userPresenceRefreshTimers.has(userId))
        return;
    const timer = setInterval(() => {
        void (0, presenceService_1.markUserOnline)(userId).catch((err) => {
            console.warn('[presence] refresh markUserOnline failed', err?.message || err);
        });
    }, PRESENCE_REFRESH_MS);
    userPresenceRefreshTimers.set(userId, timer);
}
function stopPresenceRefresh(userId) {
    const timer = userPresenceRefreshTimers.get(userId);
    if (!timer)
        return;
    clearInterval(timer);
    userPresenceRefreshTimers.delete(userId);
}
function incrementMapValue(map, userId) {
    const next = (map.get(userId) || 0) + 1;
    map.set(userId, next);
    return next;
}
function decrementMapValue(map, userId) {
    const next = Math.max(0, (map.get(userId) || 0) - 1);
    if (next > 0)
        map.set(userId, next);
    else
        map.delete(userId);
    return next;
}
function syncFocusedPresence(userId, prevFocusedCount, nextFocusedCount) {
    if (prevFocusedCount === 0 && nextFocusedCount === 1) {
        void (0, presenceService_1.markUserOnline)(userId)
            .catch((err) => {
            console.warn('[presence] markUserOnline failed', err?.message || err);
        })
            .finally(() => {
            emitPresenceChanged(userId, true, null);
        });
        startPresenceRefresh(userId);
        return;
    }
    if (prevFocusedCount > 0 && nextFocusedCount === 0) {
        stopPresenceRefresh(userId);
        void (0, presenceService_1.markUserOffline)(userId)
            .then((lastSeenAt) => emitPresenceChanged(userId, false, lastSeenAt))
            .catch((err) => {
            console.warn('[presence] markUserOffline failed', err?.message || err);
            emitPresenceChanged(userId, false, new Date());
        });
    }
}
function applyPresenceFocus(socket, userId, focused) {
    const normalized = !!focused;
    const prevFocused = socket?.data?.presenceFocused !== false;
    if (prevFocused === normalized)
        return;
    socket.data.presenceFocused = normalized;
    const prevFocusedCount = userFocusedSocketCounts.get(userId) || 0;
    const nextFocusedCount = normalized
        ? incrementMapValue(userFocusedSocketCounts, userId)
        : decrementMapValue(userFocusedSocketCounts, userId);
    syncFocusedPresence(userId, prevFocusedCount, nextFocusedCount);
}
io.use((socket, next) => {
    const authToken = (typeof socket.handshake.auth?.token === 'string' && socket.handshake.auth.token) ||
        (typeof socket.handshake.headers.authorization === 'string' &&
            socket.handshake.headers.authorization.split(' ')[1]);
    if (!authToken)
        return next(new Error('Unauthorized'));
    try {
        const payload = jsonwebtoken_1.default.verify(authToken, accessTokenSecret);
        socket.data.user = payload;
        next();
    }
    catch {
        next(new Error('Unauthorized'));
    }
});
io.on('connection', (socket) => {
    const userId = Number(socket.data?.user?.userId);
    if (Number.isFinite(userId) && userId > 0) {
        incrementMapValue(userSocketCounts, userId);
        socket.data.presenceFocused = true;
        const prevFocusedCount = userFocusedSocketCounts.get(userId) || 0;
        const nextFocusedCount = incrementMapValue(userFocusedSocketCounts, userId);
        syncFocusedPresence(userId, prevFocusedCount, nextFocusedCount);
    }
    socket.on('join', (room) => { if (room)
        socket.join(room); });
    socket.on('leave', (room) => { if (room)
        socket.leave(room); });
    socket.on('presence:focus', (payload) => {
        if (!Number.isFinite(userId) || userId <= 0)
            return;
        if (!payload || typeof payload !== 'object')
            return;
        if (typeof payload.focused !== 'boolean')
            return;
        applyPresenceFocus(socket, userId, payload.focused);
    });
    socket.on('presence:subscribe', (payload) => {
        const userIds = normalizePresenceUserIds(payload);
        userIds.forEach((id) => socket.join(`presence:${id}`));
    });
    socket.on('presence:unsubscribe', (payload) => {
        const userIds = normalizePresenceUserIds(payload);
        userIds.forEach((id) => socket.leave(`presence:${id}`));
    });
    socket.on('disconnect', () => {
        if (!Number.isFinite(userId) || userId <= 0)
            return;
        decrementMapValue(userSocketCounts, userId);
        const wasFocused = socket.data?.presenceFocused !== false;
        if (wasFocused) {
            const prevFocusedCount = userFocusedSocketCounts.get(userId) || 0;
            const nextFocusedCount = decrementMapValue(userFocusedSocketCounts, userId);
            syncFocusedPresence(userId, prevFocusedCount, nextFocusedCount);
        }
    });
});
// ---- Start ----
if (ENV !== 'test') {
    (async () => {
        // 1) Подключаемся к Redis один раз, терпеливо ждём до 15с, но не падаем, если недоступен
        try {
            await (0, redis_1.connectRedis)();
        }
        catch (e) {
            console.warn('[startup] Redis connect failed, continuing without cache:', e?.message || e);
        }
        // 2) Запускаем проверки сервисов (Redis уже подключен — только ping)
        await startupChecks();
        // 3) Стартуем HTTP-сервер (не блокируем старт внешними интеграциями)
        server.listen(port, () => {
            console.log(`Server is running on http://localhost:${port}`);
            console.log(`Docs:   http://localhost:${port}/docs`);
        });
        // 4) Запускаем планировщик фоновых задач (напоминания о непрочитанных, закрытии)
        (0, scheduledJobsService_1.startScheduledJobs)();
        // 5) Настраиваем получение Telegram updates (webhook/polling) уже после старта HTTP
        if ((0, telegramBotService_1.isTelegramBotConfigured)()) {
            void (async () => {
                try {
                    const transport = await (0, telegramBotService_1.initializeTelegramUpdates)();
                    if (transport.ok) {
                        console.log('[startup] Telegram updates: OK', {
                            mode: transport.mode,
                            url: transport.currentUrl,
                            pendingUpdates: transport.pendingUpdates,
                        });
                    }
                    else {
                        console.warn('[startup] Telegram updates: NOT READY', transport);
                    }
                }
                catch (e) {
                    console.warn('[startup] Telegram updates setup failed:', e?.message || e);
                }
            })();
        }
        else {
            console.warn('[startup] Telegram bot is not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_BOT_USERNAME)');
        }
        // 6) Настраиваем получение MAX updates (webhook/polling)
        if ((0, maxBotService_1.isMaxBotConfigured)()) {
            void (async () => {
                try {
                    const transport = await (0, maxBotService_1.initializeMaxUpdates)();
                    if (transport.ok) {
                        console.log('[startup] MAX updates: OK', {
                            mode: transport.mode,
                            url: transport.currentUrl,
                            pendingUpdates: transport.pendingUpdates,
                        });
                    }
                    else {
                        console.warn('[startup] MAX updates: NOT READY', transport);
                    }
                }
                catch (e) {
                    console.warn('[startup] MAX updates setup failed:', e?.message || e);
                }
            })();
        }
        else {
            console.warn('[startup] MAX bot is not configured (MAX_BOT_TOKEN / MAX_BOT_USERNAME)');
        }
    })();
}
// ---- Graceful shutdown ----
process.on('SIGINT', async () => {
    console.log('SIGINT received, shutting down...');
    (0, scheduledJobsService_1.stopScheduledJobs)();
    await (0, telegramBotService_1.stopTelegramUpdates)().catch(() => { });
    await (0, maxBotService_1.stopMaxUpdates)().catch(() => { });
    await client_1.default.$disconnect().catch(() => { });
    await (0, redis_1.disconnectRedis)().catch(() => { });
    await (0, kafka_1.disconnectKafka)().catch(() => { });
    server.close(() => process.exit(0));
});
process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down...');
    (0, scheduledJobsService_1.stopScheduledJobs)();
    await (0, telegramBotService_1.stopTelegramUpdates)().catch(() => { });
    await (0, maxBotService_1.stopMaxUpdates)().catch(() => { });
    await client_1.default.$disconnect().catch(() => { });
    await (0, redis_1.disconnectRedis)().catch(() => { });
    await (0, kafka_1.disconnectKafka)().catch(() => { });
    server.close(() => process.exit(0));
});
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
    // Игнорируем transient ошибки Redis, чтобы не падать при нестабильном соединении
    if (err?.name === 'SocketClosedUnexpectedlyError') {
        console.warn('Redis socket closed unexpectedly (ignored)', err?.message || err);
        return;
    }
    console.error('Uncaught Exception:', err);
});
exports.default = app;
