"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const client_1 = require("@prisma/client");
const app = (0, express_1.default)();
const prisma = new client_1.PrismaClient();
const port = process.env.PORT || 3000;
app.use(express_1.default.json());
const auth_1 = __importDefault(require("./routes/auth"));
app.use('/', auth_1.default);
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
