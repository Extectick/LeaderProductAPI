import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import app from '../index';

const prisma = new PrismaClient();

beforeAll(async () => {
  // Optionally run migrations or setup test DB here
});

beforeEach(async () => {
  // Clean up database before each test
  await prisma.refreshToken.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.role.deleteMany({});
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('Auth API Integration Tests', () => {
  let userRoleId: number;

  beforeEach(async () => {
    // Create default user role
    const userRole = await prisma.role.create({
      data: {
        name: 'user',
      },
    });

    // Check if permissions exist, create if not
    let readPermission = await prisma.permission.findUnique({ where: { name: 'read' } });
    if (!readPermission) {
      readPermission = await prisma.permission.create({ data: { name: 'read' } });
    }
    let writePermission = await prisma.permission.findUnique({ where: { name: 'write' } });
    if (!writePermission) {
      writePermission = await prisma.permission.create({ data: { name: 'write' } });
    }

    // Connect permissions to role
    await prisma.role.update({
      where: { id: userRole.id },
      data: {
        permissions: {
          connect: [
            { roleId_permissionId: { roleId: userRole.id, permissionId: readPermission.id } },
            { roleId_permissionId: { roleId: userRole.id, permissionId: writePermission.id } },
          ],
        },
      },
    });
    userRoleId = userRole.id;
  });

  describe('POST /register', () => {
    it('should register a new user successfully', async () => {
      const res = await request(app)
        .post('/register')
        .send({ email: 'test@example.com', password: 'password123' });
      expect(res.statusCode).toBe(201);
      expect(res.body.message).toBe('User registered. Please verify your email.');
    });

    it('should not register user with existing email', async () => {
      await prisma.user.create({
        data: {
          email: 'test@example.com',
          passwordHash: 'hashedpassword',
          roleId: userRoleId,
          isActive: true,
        },
      });
      const res = await request(app)
        .post('/register')
        .send({ email: 'test@example.com', password: 'password123' });
      expect(res.statusCode).toBe(409);
      expect(res.body.message).toBe('User already exists');
    });

    it('should return 400 if email or password missing', async () => {
      const res = await request(app).post('/register').send({ email: '', password: '' });
      expect(res.statusCode).toBe(400);
      expect(res.body.message).toBe('Email and password required');
    });
  });

  describe('POST /login', () => {
    beforeEach(async () => {
      const passwordHash = await require('bcryptjs').hash('password123', 10);
      await prisma.user.create({
        data: {
          email: 'login@example.com',
          passwordHash,
          roleId: userRoleId,
          isActive: true,
        },
      });
    });

    it('should login successfully with correct credentials', async () => {
      const res = await request(app)
        .post('/login')
        .send({ email: 'login@example.com', password: 'password123' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty('accessToken');
      expect(res.body).toHaveProperty('refreshToken');
    });

    it('should fail login with wrong password', async () => {
      const res = await request(app)
        .post('/login')
        .send({ email: 'login@example.com', password: 'wrongpassword' });
      expect(res.statusCode).toBe(401);
      expect(res.body.message).toBe('Invalid credentials');
    });

    it('should fail login if account not activated', async () => {
      await prisma.user.update({
        where: { email: 'login@example.com' },
        data: { isActive: false },
      });
      const res = await request(app)
        .post('/login')
        .send({ email: 'login@example.com', password: 'password123' });
      expect(res.statusCode).toBe(403);
      expect(res.body.message).toBe('Account not activated');
    });
  });

  describe('POST /logout', () => {
    let accessToken: string;
    let refreshToken: string;

    beforeEach(async () => {
      const passwordHash = await require('bcryptjs').hash('password123', 10);
      const user = await prisma.user.create({
        data: {
          email: 'logout@example.com',
          passwordHash,
          roleId: userRoleId,
          isActive: true,
        },
      });

      // Login to get tokens
      const res = await request(app)
        .post('/login')
        .send({ email: 'logout@example.com', password: 'password123' });
      accessToken = res.body.accessToken;
      refreshToken = res.body.refreshToken;
    });

    it('should logout successfully and revoke refresh token', async () => {
      const res = await request(app)
        .post('/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ refreshToken });
      expect(res.statusCode).toBe(200);
      expect(res.body.message).toBe('Logged out successfully');

      // Check that refresh token is revoked
      const tokenInDb = await prisma.refreshToken.findUnique({ where: { token: refreshToken } });
      expect(tokenInDb?.revoked).toBe(true);
    });

    it('should return 400 if refresh token missing', async () => {
      const res = await request(app)
        .post('/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({});
      expect(res.statusCode).toBe(400);
      expect(res.body.message).toBe('Refresh token required');
    });
  });

  // Additional tests for password reset and email verification can be added here once those endpoints are implemented
});
