"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const client_1 = require("@prisma/client");
const morgan_1 = __importDefault(require("morgan"));
const auth_1 = __importDefault(require("./routes/auth"));
const users_1 = __importDefault(require("./routes/users"));
const qr_1 = __importDefault(require("./routes/qr"));
const passwordReset_1 = __importDefault(require("./routes/passwordReset"));
const cors_1 = __importDefault(require("cors"));
const errorHandler_1 = require("./middleware/errorHandler");
const app = (0, express_1.default)();
app.use((0, cors_1.default)({
    origin: ['http://localhost:8081', 'http://192.168.30.54:8081', '*'],
    credentials: true,
}));
const databaseUrl = process.env.DATABASE_URL;
const prisma = new client_1.PrismaClient({
    datasources: {
        db: {
            url: databaseUrl,
        },
    },
});
const port = process.env.PORT || 3000;
app.use((0, morgan_1.default)('dev'));
app.use(express_1.default.json());
app.use('/auth', auth_1.default);
app.use('/users', users_1.default);
app.use('/qr', qr_1.default);
app.use('/password-reset', passwordReset_1.default);
// Подключаем обработчик ошибок
app.use(errorHandler_1.errorHandler);
app.get('/', async (req, res) => {
    try {
        // Simple test query to check DB connection
        const result = await prisma.$queryRaw `SELECT 1+1 AS result`;
        res.json({ message: 'Server is running', dbTest: result });
    }
    catch (error) {
        res.status(500).json({ error: 'Database connection failed', details: error });
    }
});
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
exports.default = app;
