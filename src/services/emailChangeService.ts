import crypto from 'crypto';
import prisma from '../prisma/client';
import { sendVerificationEmail } from './mailService';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_CHANGE_CODE_TTL_MS = 10 * 60 * 1000;
const EMAIL_CHANGE_RESEND_COOLDOWN_SEC = 30;
const EMAIL_CHANGE_MAX_ATTEMPTS = 5;

function normalizeEmail(value: string) {
  return String(value || '').trim().toLowerCase();
}

function hashCode(code: string) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function isExpired(expiresAt: Date) {
  return expiresAt.getTime() <= Date.now();
}

function mapSession(session: {
  id: string;
  status: string;
  currentEmail: string | null;
  requestedEmail: string;
  attemptsCount: number;
  expiresAt: Date;
  verifiedAt: Date | null;
  lastSentAt: Date | null;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: session.id,
    status: session.status,
    currentEmail: session.currentEmail,
    requestedEmail: session.requestedEmail,
    attemptsCount: session.attemptsCount,
    expiresAt: session.expiresAt,
    verifiedAt: session.verifiedAt,
    lastSentAt: session.lastSentAt,
    failureReason: session.failureReason,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

export async function startEmailChangeSession(params: { userId: number; emailRaw: string }) {
  const requestedEmail = normalizeEmail(params.emailRaw);
  if (!EMAIL_RE.test(requestedEmail)) {
    throw new Error('EMAIL_CHANGE_INVALID_EMAIL');
  }

  const user = await prisma.user.findUnique({
    where: { id: params.userId },
    select: { id: true, email: true },
  });
  if (!user) {
    throw new Error('EMAIL_CHANGE_USER_NOT_FOUND');
  }

  const currentEmail = user.email ? normalizeEmail(user.email) : null;
  if (currentEmail && currentEmail === requestedEmail) {
    throw new Error('EMAIL_CHANGE_SAME_AS_CURRENT');
  }

  const conflict = await prisma.user.findFirst({
    where: {
      email: { equals: requestedEmail, mode: 'insensitive' },
      id: { not: params.userId },
    },
    select: { id: true },
  });
  if (conflict) {
    throw new Error('EMAIL_CHANGE_CONFLICT');
  }

  await prisma.emailChangeSession.updateMany({
    where: {
      userId: params.userId,
      status: 'PENDING',
    },
    data: {
      status: 'CANCELLED',
      failureReason: 'REPLACED_BY_NEW_REQUEST',
    },
  });

  const code = generateCode();
  const codeHash = hashCode(code);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + EMAIL_CHANGE_CODE_TTL_MS);

  const session = await prisma.emailChangeSession.create({
    data: {
      userId: params.userId,
      currentEmail: user.email,
      requestedEmail,
      codeHash,
      status: 'PENDING',
      attemptsCount: 0,
      expiresAt,
      lastSentAt: now,
    },
    select: {
      id: true,
      status: true,
      currentEmail: true,
      requestedEmail: true,
      attemptsCount: true,
      expiresAt: true,
      verifiedAt: true,
      lastSentAt: true,
      failureReason: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  await sendVerificationEmail(requestedEmail, code, 'emailChange');

  return {
    sessionId: session.id,
    requestedEmail: session.requestedEmail,
    expiresAt: session.expiresAt,
    resendCooldownSec: EMAIL_CHANGE_RESEND_COOLDOWN_SEC,
  };
}

export async function getEmailChangeSessionState(params: { userId: number; sessionId: string }) {
  const session = await prisma.emailChangeSession.findFirst({
    where: { id: params.sessionId, userId: params.userId },
    select: {
      id: true,
      status: true,
      currentEmail: true,
      requestedEmail: true,
      attemptsCount: true,
      expiresAt: true,
      verifiedAt: true,
      lastSentAt: true,
      failureReason: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!session) return null;

  if (session.status === 'PENDING' && isExpired(session.expiresAt)) {
    const expired = await prisma.emailChangeSession.update({
      where: { id: session.id },
      data: {
        status: 'EXPIRED',
        failureReason: 'SESSION_EXPIRED',
      },
      select: {
        id: true,
        status: true,
        currentEmail: true,
        requestedEmail: true,
        attemptsCount: true,
        expiresAt: true,
        verifiedAt: true,
        lastSentAt: true,
        failureReason: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return mapSession(expired);
  }

  return mapSession(session);
}

export async function resendEmailChangeCode(params: { userId: number; sessionId: string }) {
  const session = await prisma.emailChangeSession.findFirst({
    where: { id: params.sessionId, userId: params.userId },
    select: {
      id: true,
      status: true,
      requestedEmail: true,
      expiresAt: true,
      lastSentAt: true,
    },
  });
  if (!session) {
    throw new Error('EMAIL_CHANGE_SESSION_NOT_FOUND');
  }
  if (session.status !== 'PENDING') {
    throw new Error('EMAIL_CHANGE_SESSION_NOT_ACTIVE');
  }
  if (isExpired(session.expiresAt)) {
    await prisma.emailChangeSession.update({
      where: { id: session.id },
      data: {
        status: 'EXPIRED',
        failureReason: 'SESSION_EXPIRED',
      },
    });
    throw new Error('EMAIL_CHANGE_SESSION_EXPIRED');
  }

  const lastSentAtMs = session.lastSentAt?.getTime() ?? 0;
  const elapsedSec = (Date.now() - lastSentAtMs) / 1000;
  if (session.lastSentAt && elapsedSec < EMAIL_CHANGE_RESEND_COOLDOWN_SEC) {
    const retryAfterSec = Math.ceil(EMAIL_CHANGE_RESEND_COOLDOWN_SEC - elapsedSec);
    throw new Error(`EMAIL_CHANGE_RESEND_TOO_EARLY:${retryAfterSec}`);
  }

  const code = generateCode();
  const codeHash = hashCode(code);
  const now = new Date();

  const updated = await prisma.emailChangeSession.update({
    where: { id: session.id },
    data: {
      codeHash,
      lastSentAt: now,
      failureReason: null,
    },
    select: {
      id: true,
      status: true,
      currentEmail: true,
      requestedEmail: true,
      attemptsCount: true,
      expiresAt: true,
      verifiedAt: true,
      lastSentAt: true,
      failureReason: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  await sendVerificationEmail(updated.requestedEmail, code, 'emailChange');

  return {
    resent: true,
    resendCooldownSec: EMAIL_CHANGE_RESEND_COOLDOWN_SEC,
    session: mapSession(updated),
  };
}

export async function verifyEmailChangeSession(params: {
  userId: number;
  sessionId: string;
  codeRaw: string;
}) {
  const code = String(params.codeRaw || '').trim();
  if (!/^\d{6}$/.test(code)) {
    throw new Error('EMAIL_CHANGE_INVALID_CODE');
  }

  const session = await prisma.emailChangeSession.findFirst({
    where: { id: params.sessionId, userId: params.userId },
    select: {
      id: true,
      userId: true,
      status: true,
      requestedEmail: true,
      codeHash: true,
      attemptsCount: true,
      expiresAt: true,
    },
  });
  if (!session) {
    throw new Error('EMAIL_CHANGE_SESSION_NOT_FOUND');
  }
  if (session.status !== 'PENDING') {
    throw new Error('EMAIL_CHANGE_SESSION_NOT_ACTIVE');
  }
  if (isExpired(session.expiresAt)) {
    await prisma.emailChangeSession.update({
      where: { id: session.id },
      data: {
        status: 'EXPIRED',
        failureReason: 'SESSION_EXPIRED',
      },
    });
    throw new Error('EMAIL_CHANGE_SESSION_EXPIRED');
  }

  const incomingHash = hashCode(code);
  if (incomingHash !== session.codeHash) {
    const attemptsCount = session.attemptsCount + 1;
    const tooMany = attemptsCount >= EMAIL_CHANGE_MAX_ATTEMPTS;
    await prisma.emailChangeSession.update({
      where: { id: session.id },
      data: {
        attemptsCount,
        status: tooMany ? 'FAILED' : 'PENDING',
        failureReason: tooMany ? 'TOO_MANY_ATTEMPTS' : 'INVALID_CODE',
      },
    });
    throw new Error(tooMany ? 'EMAIL_CHANGE_TOO_MANY_ATTEMPTS' : 'EMAIL_CHANGE_INVALID_CODE');
  }

  const conflict = await prisma.user.findFirst({
    where: {
      email: { equals: session.requestedEmail, mode: 'insensitive' },
      id: { not: params.userId },
    },
    select: { id: true },
  });
  if (conflict) {
    await prisma.emailChangeSession.update({
      where: { id: session.id },
      data: {
        status: 'FAILED',
        failureReason: 'EMAIL_ALREADY_USED',
      },
    });
    throw new Error('EMAIL_CHANGE_CONFLICT');
  }

  const now = new Date();
  await prisma.$transaction([
    prisma.user.update({
      where: { id: params.userId },
      data: {
        email: session.requestedEmail,
      },
    }),
    prisma.emailChangeSession.update({
      where: { id: session.id },
      data: {
        status: 'VERIFIED',
        verifiedAt: now,
        failureReason: null,
      },
    }),
    prisma.emailChangeSession.updateMany({
      where: {
        userId: params.userId,
        status: 'PENDING',
        id: { not: session.id },
      },
      data: {
        status: 'CANCELLED',
        failureReason: 'REPLACED_BY_VERIFIED_REQUEST',
      },
    }),
  ]);

  const result = await prisma.emailChangeSession.findUnique({
    where: { id: session.id },
    select: {
      id: true,
      status: true,
      currentEmail: true,
      requestedEmail: true,
      attemptsCount: true,
      expiresAt: true,
      verifiedAt: true,
      lastSentAt: true,
      failureReason: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!result) {
    throw new Error('EMAIL_CHANGE_SESSION_NOT_FOUND');
  }

  return {
    verified: true,
    session: mapSession(result),
  };
}

export async function cancelEmailChangeSession(params: { userId: number; sessionId: string }) {
  const updated = await prisma.emailChangeSession.updateMany({
    where: {
      id: params.sessionId,
      userId: params.userId,
      status: 'PENDING',
    },
    data: {
      status: 'CANCELLED',
      failureReason: 'CANCELLED_BY_USER',
    },
  });
  return updated.count > 0;
}
