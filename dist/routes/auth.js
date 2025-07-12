"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const client_1 = require("@prisma/client");
const auth_1 = require("../middleware/auth");
const router = express_1.default.Router();
const prisma = new client_1.PrismaClient();
const accessTokenSecret = process.env.ACCESS_TOKEN_SECRET || 'youraccesstokensecret';
const refreshTokenSecret = process.env.REFRESH_TOKEN_SECRET || 'yourrefreshtokensecret';
const accessTokenLife = '15m';
const refreshTokenLife = '14d';
// Helper to generate tokens
function generateAccessToken(user) {
    return jsonwebtoken_1.default.sign({ userId: user.id, role: user.role.name, permissions: user.role.permissions.map((p) => p.name) }, accessTokenSecret, { expiresIn: accessTokenLife });
}
function generateRefreshToken(user) {
    return jsonwebtoken_1.default.sign({ userId: user.id }, refreshTokenSecret, { expiresIn: refreshTokenLife });
}
// Register endpoint (simplified, email verification to be implemented)
const mailService_1 = require("../services/mailService");
const crypto_1 = __importDefault(require("crypto"));
const MAX_VERIFICATION_ATTEMPTS = 5;
const RESEND_CODE_INTERVAL_MS = 30 * 1000; // 30 seconds
const VERIFICATION_CODE_EXPIRATION_MS = 60 * 60 * 1000; // 1 hour
const ACCOUNT_DELETION_DELAY_MS = 24 * 60 * 60 * 1000; // 24 hours
// Helper function to generate cryptographically secure 6-digit code
function generateVerificationCode() {
    return crypto_1.default.randomInt(100000, 1000000).toString();
}
// Helper function to send verification code email with resend interval check
async function sendVerificationCodeEmail(userId, email) {
    const existingVerification = await prisma.emailVerification.findFirst({
        where: { userId, used: false },
        orderBy: { createdAt: 'desc' },
    });
    if (existingVerification) {
        const now = new Date();
        // @ts-ignore
        if (existingVerification.lastSentAt && now.getTime() - existingVerification.lastSentAt.getTime() < RESEND_CODE_INTERVAL_MS) {
            throw new Error('Verification code was sent recently. Please wait before requesting a new code.');
        }
        // Update lastSentAt and resend the same code
        await prisma.emailVerification.update({
            where: { id: existingVerification.id },
            data: {
                // @ts-ignore
                lastSentAt: new Date(),
            },
        });
        await (0, mailService_1.sendVerificationEmail)(email, existingVerification.code);
        return;
    }
    // No existing code, create a new one
    const code = generateVerificationCode();
    await prisma.emailVerification.create({
        data: {
            userId,
            code,
            expiresAt: new Date(Date.now() + VERIFICATION_CODE_EXPIRATION_MS),
            used: false,
            // @ts-ignore
            attemptsCount: 0,
            // @ts-ignore
            lastSentAt: new Date(),
        },
    });
    await (0, mailService_1.sendVerificationEmail)(email, code);
}
router.post('/register', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password)
            return res.status(400).json({ message: 'Email and password required' });
        // Validate email format (simple regex)
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email))
            return res.status(400).json({ message: 'Invalid email format' });
        // Validate password length (min 6 chars)
        if (password.length < 6)
            return res.status(400).json({ message: 'Password must be at least 6 characters' });
        const existingUser = await prisma.user.findUnique({ where: { email } });
        if (existingUser)
            return res.status(409).json({ message: 'User already exists' });
        const passwordHash = await bcryptjs_1.default.hash(password, 10);
        const user = await prisma.user.create({
            data: {
                email,
                passwordHash,
                isActive: false, // will be activated after email verification
                role: { connect: { name: 'user' } },
            },
        });
        await sendVerificationCodeEmail(user.id, email);
        res.status(201).json({ message: 'User registered. Please verify your email.' });
    }
    catch (error) {
        if (error.message && error.message.includes('recently')) {
            return res.status(429).json({ message: error.message });
        }
        res.status(500).json({ message: 'Registration failed', error });
    }
});
// Login endpoint
router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password)
        return res.status(400).json({ message: 'Email and password required' });
    try {
        const user = await prisma.user.findUnique({
            where: { email },
            include: { role: { include: { permissions: true } } },
        });
        if (!user)
            return res.status(401).json({ message: 'Invalid credentials' });
        if (!user.isActive)
            return res.status(403).json({ message: 'Account not activated' });
        const validPassword = await bcryptjs_1.default.compare(password, user.passwordHash);
        if (!validPassword)
            return res.status(401).json({ message: 'Invalid credentials' });
        // TODO: check login attempts and block if necessary
        const accessToken = generateAccessToken(user);
        const refreshToken = generateRefreshToken(user);
        // Store refresh token in DB
        await prisma.refreshToken.create({
            data: {
                token: refreshToken,
                userId: user.id,
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
            },
        });
        res.json({ accessToken, refreshToken });
    }
    catch (error) {
        res.status(500).json({ message: 'Login failed', error });
    }
});
// Token refresh endpoint
router.post('/token', async (req, res) => {
    const { refreshToken } = req.body;
    if (!refreshToken)
        return res.status(400).json({ message: 'Refresh token required' });
    try {
        const storedToken = await prisma.refreshToken.findUnique({ where: { token: refreshToken } });
        if (!storedToken || storedToken.revoked || storedToken.expiresAt < new Date()) {
            return res.status(403).json({ message: 'Invalid or expired refresh token' });
        }
        jsonwebtoken_1.default.verify(refreshToken, refreshTokenSecret, async (err, payload) => {
            if (err)
                return res.status(403).json({ message: 'Invalid refresh token' });
            const user = await prisma.user.findUnique({
                where: { id: payload.userId },
                include: { role: { include: { permissions: true } } },
            });
            if (!user)
                return res.status(403).json({ message: 'User not found' });
            const newAccessToken = generateAccessToken(user);
            const newRefreshToken = generateRefreshToken(user);
            // Revoke old refresh token and store new one
            await prisma.refreshToken.update({
                where: { id: storedToken.id },
                data: { revoked: true },
            });
            await prisma.refreshToken.create({
                data: {
                    token: newRefreshToken,
                    userId: user.id,
                    expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
                },
            });
            res.json({ accessToken: newAccessToken, refreshToken: newRefreshToken });
        });
    }
    catch (error) {
        res.status(500).json({ message: 'Token refresh failed', error });
    }
});
// Logout endpoint (revoke refresh token)
router.post('/logout', auth_1.authenticateToken, async (req, res) => {
    const { refreshToken } = req.body;
    if (!refreshToken)
        return res.status(400).json({ message: 'Refresh token required' });
    try {
        await prisma.refreshToken.updateMany({
            where: { token: refreshToken, userId: req.user.userId },
            data: { revoked: true },
        });
        res.json({ message: 'Logged out successfully' });
    }
    catch (error) {
        res.status(500).json({ message: 'Logout failed', error });
    }
});
// Verify email and activate account endpoint
router.post('/verify', async (req, res) => {
    try {
        const { email, code } = req.body;
        if (!email || !code)
            return res.status(400).json({ message: 'Email and code are required' });
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user)
            return res.status(404).json({ message: 'User not found' });
        if (user.isActive)
            return res.status(400).json({ message: 'Account already activated' });
        const verification = await prisma.emailVerification.findFirst({
            where: { userId: user.id, code, used: false, expiresAt: { gt: new Date() } },
            orderBy: { createdAt: 'desc' },
        });
        if (!verification) {
            // Increment attemptsCount if possible
            const lastVerification = await prisma.emailVerification.findFirst({
                where: { userId: user.id, used: false },
                orderBy: { createdAt: 'desc' },
            });
            if (lastVerification) {
                const newAttempts = (lastVerification.attemptsCount || 0) + 1;
                if (newAttempts >= MAX_VERIFICATION_ATTEMPTS) {
                    return res.status(429).json({ message: 'Maximum verification attempts exceeded' });
                }
                await prisma.emailVerification.update({
                    where: { id: lastVerification.id },
                    data: { attemptsCount: newAttempts },
                });
            }
            return res.status(400).json({ message: 'Invalid or expired verification code' });
        }
        // Mark verification as used and activate user
        await prisma.emailVerification.update({
            where: { id: verification.id },
            data: { used: true },
        });
        await prisma.user.update({
            where: { id: user.id },
            data: { isActive: true },
        });
        // Generate tokens for automatic login
        const userWithRole = await prisma.user.findUnique({
            where: { id: user.id },
            include: { role: { include: { permissions: true } } },
        });
        if (!userWithRole)
            return res.status(500).json({ message: 'User data retrieval failed' });
        const accessToken = generateAccessToken(userWithRole);
        const refreshToken = generateRefreshToken(userWithRole);
        // Store refresh token in DB
        await prisma.refreshToken.create({
            data: {
                token: refreshToken,
                userId: user.id,
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
            },
        });
        res.json({ message: 'Account verified and activated', accessToken, refreshToken });
    }
    catch (error) {
        res.status(500).json({ message: 'Verification failed', error });
    }
});
exports.default = router;
