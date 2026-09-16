import express from 'express';
import { createHash, randomBytes } from 'crypto';
import prisma from '../prisma/client';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { checkUserStatus } from '../middleware/checkUserStatus';
import { authorizeServiceAccess } from '../middleware/serviceAccess';
import { rateLimit } from '../middleware/rateLimit';
import { errorResponse, ErrorCodes, successResponse } from '../utils/apiResponse';
import { sendPushToUser } from '../services/pushService';
import { resolveObjectUrl } from '../storage/minio';

const router = express.Router();
const TRACKING_TOKEN_PREFIX = 'lpt_';
const DAY_OFFSET_MINUTES = Number(process.env.TRACKING_DEFAULT_TIMEZONE_OFFSET_MINUTES || 360);
const MAX_DAY_POINTS = 5000;
const MAX_RENDER_POINTS = 600;
const LOCATION_REQUEST_TIMEOUT_MS = 30_000;
const LOCATION_REQUEST_COOLDOWN_MS = 60_000;

type ViewerScope = { mode: 'SELF' | 'DEPARTMENT' | 'ALL'; departmentIds: number[] };

function isTrackingV2Enabled() {
  if (process.env.NODE_ENV === 'production') return process.env.TRACKING_V2_ENABLED === 'true';
  return process.env.TRACKING_V2_ENABLED !== 'false';
}

function requireTrackingV2(_req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!isTrackingV2Enabled()) {
    return res.status(404).json(errorResponse('Геомаршруты v2 отключены', ErrorCodes.NOT_FOUND));
  }
  return next();
}

function hashCredential(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function issueCredential() {
  return `${TRACKING_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

function cleanText(value: unknown, maxLength = 200) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.slice(0, maxLength) : null;
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function booleanValue(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes'].includes(normalized)) return true;
  if (['0', 'false', 'no'].includes(normalized)) return false;
  return null;
}

function parseRecordedAt(value: unknown): Date | null {
  const raw = finiteNumber(value);
  if (raw !== null) {
    const millis = raw > 10_000_000_000 ? raw : raw * 1000;
    const parsed = new Date(millis);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function parseDayRange(value: unknown) {
  const day = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : new Date(Date.now() + DAY_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);
  const [year, month, date] = day.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, date) - DAY_OFFSET_MINUTES * 60_000);
  const end = new Date(start.getTime() + 24 * 60 * 60_000);
  return { day, start, end };
}

function parseEventCursor(value: unknown): { capturedAt: Date; id: string } | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { capturedAt?: string; id?: string };
    const capturedAt = decoded.capturedAt ? new Date(decoded.capturedAt) : null;
    return capturedAt && !Number.isNaN(capturedAt.getTime()) && decoded.id
      ? { capturedAt, id: decoded.id }
      : null;
  } catch {
    return null;
  }
}

function encodeEventCursor(event: { capturedAt: Date; id: string }) {
  return Buffer.from(JSON.stringify({ capturedAt: event.capturedAt.toISOString(), id: event.id })).toString('base64url');
}

function haversineMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const earthRadius = 6_371_000;
  const latitudeDelta = toRadians(b.latitude - a.latitude);
  const longitudeDelta = toRadians(b.longitude - a.longitude);
  const latitude1 = toRadians(a.latitude);
  const latitude2 = toRadians(b.latitude);
  const sinLat = Math.sin(latitudeDelta / 2);
  const sinLon = Math.sin(longitudeDelta / 2);
  const h = sinLat * sinLat + Math.cos(latitude1) * Math.cos(latitude2) * sinLon * sinLon;
  return 2 * earthRadius * Math.asin(Math.min(1, Math.sqrt(h)));
}

function perpendicularDistance(
  point: { latitude: number; longitude: number },
  start: { latitude: number; longitude: number },
  end: { latitude: number; longitude: number }
) {
  const dx = end.longitude - start.longitude;
  const dy = end.latitude - start.latitude;
  if (dx === 0 && dy === 0) return haversineMeters(point, start);
  const t = Math.max(0, Math.min(1, ((point.longitude - start.longitude) * dx + (point.latitude - start.latitude) * dy) / (dx * dx + dy * dy)));
  return haversineMeters(point, {
    latitude: start.latitude + t * dy,
    longitude: start.longitude + t * dx,
  });
}

function simplifyPoints<T extends { latitude: number; longitude: number }>(points: T[], toleranceMeters = 20): T[] {
  if (points.length <= 2) return points;
  let maxDistance = 0;
  let maxIndex = 0;
  for (let index = 1; index < points.length - 1; index += 1) {
    const distance = perpendicularDistance(points[index], points[0], points[points.length - 1]);
    if (distance > maxDistance) {
      maxDistance = distance;
      maxIndex = index;
    }
  }
  if (maxDistance <= toleranceMeters) return [points[0], points[points.length - 1]];
  return [
    ...simplifyPoints(points.slice(0, maxIndex + 1), toleranceMeters).slice(0, -1),
    ...simplifyPoints(points.slice(maxIndex), toleranceMeters),
  ];
}

function boundedPolyline<T extends { latitude: number; longitude: number }>(points: T[]): T[] {
  let tolerance = 12;
  let result = simplifyPoints(points, tolerance);
  while (result.length > MAX_RENDER_POINTS && tolerance < 1000) {
    tolerance *= 1.6;
    result = simplifyPoints(points, tolerance);
  }
  return result.length <= MAX_RENDER_POINTS
    ? result
    : result.filter((_point, index) => index % Math.ceil(result.length / MAX_RENDER_POINTS) === 0);
}

function calculateStops<T extends { latitude: number; longitude: number; recordedAt: Date }>(points: T[]) {
  const stops: Array<{ latitude: number; longitude: number; startedAt: string; endedAt: string; durationSeconds: number }> = [];
  let startIndex = 0;
  for (let index = 1; index <= points.length; index += 1) {
    const anchor = points[startIndex];
    const current = points[index];
    if (current && haversineMeters(anchor, current) <= 50) continue;
    const last = points[index - 1];
    if (anchor && last) {
      const durationSeconds = Math.max(0, Math.round((last.recordedAt.getTime() - anchor.recordedAt.getTime()) / 1000));
      if (durationSeconds >= 5 * 60) {
        const slice = points.slice(startIndex, index);
        stops.push({
          latitude: slice.reduce((sum, point) => sum + point.latitude, 0) / slice.length,
          longitude: slice.reduce((sum, point) => sum + point.longitude, 0) / slice.length,
          startedAt: anchor.recordedAt.toISOString(),
          endedAt: last.recordedAt.toISOString(),
          durationSeconds,
        });
      }
    }
    startIndex = index;
  }
  return stops;
}

async function getViewerScope(req: AuthRequest): Promise<ViewerScope> {
  const userId = req.user!.userId;
  const permissions = new Set(req.user?.permissions || []);
  const role = String(req.user?.role || '').toLowerCase();
  if (permissions.has('view_all_tracking') || role === 'admin') return { mode: 'ALL', departmentIds: [] };
  if (permissions.has('view_department_tracking') || role.includes('department_manager')) {
    const viewer = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        employeeProfile: { select: { departmentId: true, activeDepartmentId: true } },
        departmentRoles: { select: { departmentId: true } },
      },
    });
    const departmentIds = Array.from(new Set([
      viewer?.employeeProfile?.departmentId,
      viewer?.employeeProfile?.activeDepartmentId,
      ...(viewer?.departmentRoles || []).map((item) => item.departmentId),
    ].filter((value): value is number => typeof value === 'number')));
    return { mode: departmentIds.length ? 'DEPARTMENT' : 'SELF', departmentIds };
  }
  return { mode: 'SELF', departmentIds: [] };
}

async function canViewUser(req: AuthRequest, targetUserId: number) {
  if (req.user!.userId === targetUserId) return true;
  const scope = await getViewerScope(req);
  if (scope.mode === 'ALL') return true;
  if (scope.mode !== 'DEPARTMENT') return false;
  const target = await prisma.employeeProfile.findFirst({
    where: {
      userId: targetUserId,
      OR: [
        { departmentId: { in: scope.departmentIds } },
        { activeDepartmentId: { in: scope.departmentIds } },
        { departmentRoles: { some: { departmentId: { in: scope.departmentIds } } } },
      ],
    },
    select: { id: true },
  });
  return Boolean(target);
}

async function writeAudit(userId: number, action: string, targetUserId: number, details?: Record<string, unknown>) {
  await prisma.auditLog.create({
    data: {
      userId,
      action: 'OTHER',
      targetType: 'TRACKING_V2',
      targetId: targetUserId,
      details: JSON.stringify({ action, ...details }),
    },
  }).catch((error) => console.warn('[tracking-v2] audit failed', error));
}

router.post(
  '/device/bootstrap',
  requireTrackingV2,
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('tracking'),
  rateLimit({ windowSec: 60, limit: 20 }),
  async (req: AuthRequest, res) => {
    const userId = req.user!.userId;
    const body = req.body as any;
    const installId = cleanText(body?.installId, 160);
    if (!installId) {
      return res.status(400).json(errorResponse('Не передан идентификатор установки', ErrorCodes.VALIDATION_ERROR));
    }
    const existingCredential = cleanText(body?.credential, 200);
    const now = new Date();
    if (existingCredential) {
      const existing = await prisma.trackingDeviceToken.findFirst({
        where: { tokenHash: hashCredential(existingCredential), userId, installId, revokedAt: null },
      });
      if (existing) {
        await prisma.trackingDeviceToken.update({
          where: { id: existing.id },
          data: {
            lastBootstrapAt: now,
            trackingEnabled: true,
            platform: cleanText(body?.platform, 30) || existing.platform,
            appVersion: cleanText(body?.appVersion, 40) || existing.appVersion,
            deviceName: cleanText(body?.deviceName, 120) || existing.deviceName,
            expiresAt: null,
          },
        });
        return res.json(successResponse({
          credential: existingCredential,
          endpoint: '/tracking/native/osmand',
          reused: true,
        }, 'Устройство трекинга готово'));
      }
    }

    const credential = issueCredential();
    await prisma.$transaction(async (tx) => {
      await tx.trackingDeviceToken.updateMany({
        where: { userId, installId, revokedAt: null },
        data: { revokedAt: now, trackingEnabled: false },
      });
      await tx.trackingDeviceToken.create({
        data: {
          tokenHash: hashCredential(credential),
          userId,
          installId,
          deviceSessionId: cleanText(body?.deviceSessionId, 160),
          platform: cleanText(body?.platform, 30),
          appVersion: cleanText(body?.appVersion, 40),
          deviceName: cleanText(body?.deviceName, 120),
          issueReason: 'tracking_v2_bootstrap',
          lastBootstrapAt: now,
          trackingEnabled: true,
          expiresAt: null,
        },
      });
    });
    await writeAudit(userId, 'DEVICE_BOOTSTRAPPED', userId, { installId });
    return res.json(successResponse({
      credential,
      endpoint: '/tracking/native/osmand',
      reused: false,
    }, 'Устройство трекинга зарегистрировано'));
  }
);

router.delete(
  '/device/bootstrap',
  requireTrackingV2,
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('tracking'),
  rateLimit({ windowSec: 60, limit: 10 }),
  async (req: AuthRequest, res) => {
    const userId = req.user!.userId;
    const installId = cleanText((req.body as any)?.installId, 160);
    if (!installId) {
      return res.status(400).json(errorResponse('Не передан идентификатор установки', ErrorCodes.VALIDATION_ERROR));
    }
    const revokedAt = new Date();
    const result = await prisma.trackingDeviceToken.updateMany({
      where: { userId, installId, revokedAt: null },
      data: { revokedAt, trackingEnabled: false },
    });
    await writeAudit(userId, 'DEVICE_REVOKED', userId, { installId, count: result.count });
    return res.json(successResponse({ revoked: result.count }, 'Устройство трекинга отключено'));
  }
);

router.patch(
  '/device/status',
  requireTrackingV2,
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('tracking'),
  rateLimit({ windowSec: 60, limit: 30 }),
  async (req: AuthRequest, res) => {
    const userId = req.user!.userId;
    const body = req.body as any;
    const installId = cleanText(body?.installId, 160);
    const enabled = booleanValue(body?.enabled);
    if (!installId || enabled === null) {
      return res.status(400).json(errorResponse('Некорректное состояние устройства', ErrorCodes.VALIDATION_ERROR));
    }
    const result = await prisma.trackingDeviceToken.updateMany({
      where: { userId, installId, revokedAt: null },
      data: { trackingEnabled: enabled, lastBootstrapAt: new Date() },
    });
    return res.json(successResponse({ updated: result.count, enabled }, 'Состояние трекинга обновлено'));
  }
);

async function ingestTraccarPoint(req: express.Request, res: express.Response) {
  if (!isTrackingV2Enabled()) return res.sendStatus(404);
  const input = req.method === 'GET' ? req.query : req.body;
  const credential = cleanText(input?.id, 200);
  if (!credential) return res.status(401).send('missing device credential');
  const token = await prisma.trackingDeviceToken.findUnique({
    where: { tokenHash: hashCredential(credential) },
    include: { user: { select: { id: true, isActive: true, profileStatus: true } } },
  });
  if (!token) {
    return res.status(401).send('invalid device credential');
  }
  if (token.revokedAt || !token.trackingEnabled || !token.user?.isActive || token.user.profileStatus !== 'ACTIVE') {
    // The credential is known but no longer allowed to record data. A success
    // response drains Traccar's durable queue instead of producing an endless
    // retry loop after logout or an administrator revocation.
    return res.status(202).send('device disabled');
  }

  const now = new Date();
  const touchDevice = () => prisma.trackingDeviceToken.update({
    where: { id: token.id },
    data: { lastUsedAt: now },
  });
  const latitudeMissing = input?.lat === null || input?.lat === undefined
    || (typeof input.lat === 'string' && !input.lat.trim());
  const longitudeMissing = input?.lon === null || input?.lon === undefined
    || (typeof input.lon === 'string' && !input.lon.trim());

  // Traccar intentionally emits coordinate-less heartbeats while stop
  // detection has suspended GPS. They prove that the foreground service and
  // its scoped credential are alive, but they are not route points.
  if (latitudeMissing && longitudeMissing) {
    await touchDevice();
    return res.status(200).send('heartbeat');
  }

  const latitude = finiteNumber(input?.lat);
  const longitude = finiteNumber(input?.lon);
  const recordedAt = parseRecordedAt(input?.timestamp) || new Date();
  const valid = latitude !== null && longitude !== null
    && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
    && recordedAt.getTime() <= now.getTime() + 5 * 60_000
    && recordedAt.getTime() >= now.getTime() - 180 * 24 * 60 * 60_000;
  if (!valid) {
    // A 2xx response removes a permanently invalid position from Traccar's
    // durable queue instead of retrying it forever. The authenticated request
    // still refreshes device liveness for diagnostics.
    await touchDevice();
    return res.status(202).send('ignored invalid point');
  }

  const pointKey = createHash('sha256')
    .update(`${token.id}:${recordedAt.toISOString()}:${latitude!.toFixed(7)}:${longitude!.toFixed(7)}`)
    .digest('hex');
  const accuracy = finiteNumber(input?.accuracy);
  const speedKnots = finiteNumber(input?.speed);
  const source = cleanText(input?.alarm, 120)?.startsWith('lp:') ? 'LOCATION_REQUEST' : 'TRACCAR';

  let routePoint = await prisma.routePoint.findUnique({ where: { serverPointKey: pointKey } });
  if (!routePoint) {
    routePoint = await prisma.$transaction(async (tx) => {
      let route = await tx.userRoute.findFirst({
        where: { userId: token.userId, status: 'ACTIVE' },
        orderBy: { startedAt: 'desc' },
      });
      if (!route) {
        route = await tx.userRoute.create({
          data: { userId: token.userId, status: 'ACTIVE', startedAt: recordedAt },
        });
      } else if (recordedAt < route.startedAt) {
        route = await tx.userRoute.update({ where: { id: route.id }, data: { startedAt: recordedAt } });
      }
      try {
        return await tx.routePoint.create({
          data: {
            routeId: route.id,
            userId: token.userId,
            trackingDeviceTokenId: token.id,
            latitude: latitude!,
            longitude: longitude!,
            recordedAt,
            recordedTimezoneOffsetMinutes: DAY_OFFSET_MINUTES,
            eventType: speedKnots && speedKnots > 1.5 ? 'MOVE' : 'STOP',
            accuracy,
            speed: speedKnots === null ? null : speedKnots * 0.514444,
            heading: finiteNumber(input?.bearing),
            altitude: finiteNumber(input?.altitude),
            batteryLevel: finiteNumber(input?.batt),
            isCharging: booleanValue(input?.charge),
            source,
            clientPointId: `traccar:${pointKey}`,
            serverPointKey: pointKey,
          },
        });
      } catch (error: any) {
        if (error?.code !== 'P2002') throw error;
        return tx.routePoint.findUniqueOrThrow({ where: { serverPointKey: pointKey } });
      }
    });
  }

  await Promise.all([
    touchDevice(),
    prisma.trackingLocationRequest.updateMany({
      where: {
        targetUserId: token.userId,
        status: 'PENDING',
        requestedAt: { lte: recordedAt },
        expiresAt: { gte: now },
      },
      data: {
        status: 'SUCCEEDED',
        routePointId: routePoint.id,
        completedAt: now,
      },
    }),
    prisma.trackingLocationRequest.updateMany({
      where: { targetUserId: token.userId, status: 'PENDING', expiresAt: { lt: now } },
      data: { status: 'TIMED_OUT', completedAt: now, failureReason: 'LOCATION_TIMEOUT' },
    }),
  ]);
  return res.status(200).send('ok');
}

router.post('/native/osmand', rateLimit({ windowSec: 60, limit: 600 }), ingestTraccarPoint);
router.get('/native/osmand', rateLimit({ windowSec: 60, limit: 600 }), ingestTraccarPoint);

router.delete('/native/device', rateLimit({ windowSec: 60, limit: 20 }), async (req, res) => {
  if (!isTrackingV2Enabled()) return res.sendStatus(404);
  const credential = cleanText((req.body as any)?.credential, 200);
  if (!credential) return res.status(400).json(errorResponse('Не передан ключ устройства', ErrorCodes.VALIDATION_ERROR));
  const revokedAt = new Date();
  const result = await prisma.trackingDeviceToken.updateMany({
    where: { tokenHash: hashCredential(credential), revokedAt: null },
    data: { revokedAt, trackingEnabled: false },
  });
  // Do not reveal whether a credential existed. Repeated cleanup attempts stay
  // idempotent and may safely be retried after an offline logout.
  return res.json(successResponse({ revoked: true, changed: result.count > 0 }, 'Устройство отключено'));
});

router.use(requireTrackingV2, authenticateToken, checkUserStatus, authorizeServiceAccess('tracking'));

router.get('/users', rateLimit({ windowSec: 60, limit: 120 }), async (req: AuthRequest, res) => {
  const scope = await getViewerScope(req);
  const query = cleanText((req.query as any).q, 120);
  const selfOnly = (req.query as any).self === 'true';
  const offset = Math.max(0, Math.floor(finiteNumber((req.query as any).offset) ?? 0));
  const departmentFilter = scope.mode === 'DEPARTMENT'
    ? {
        OR: [
          { id: req.user!.userId },
          { employeeProfile: { departmentId: { in: scope.departmentIds } } },
          { employeeProfile: { activeDepartmentId: { in: scope.departmentIds } } },
          { departmentRoles: { some: { departmentId: { in: scope.departmentIds } } } },
        ],
      }
    : {};
  const users = await prisma.user.findMany({
    where: {
      isActive: true,
      deletedAt: null,
      profileStatus: 'ACTIVE',
      employeeProfile: { is: { status: 'ACTIVE' } },
      // Keep visibility and search in separate AND clauses: search must never
      // replace the department OR and expose employees outside the viewer scope.
      AND: [
        selfOnly || scope.mode === 'SELF' ? { id: req.user!.userId } : departmentFilter,
        ...(query ? query.split(/\s+/).map((word) => {
          const contains = { contains: word, mode: 'insensitive' as const };
          return { OR: [
            { firstName: contains }, { lastName: contains }, { middleName: contains },
            { email: contains },
            { employeeProfile: { department: { name: contains } } },
            { employeeProfile: { activeDepartment: { name: contains } } },
            { role: { OR: [{ name: contains }, { displayName: contains }] } },
            { departmentRoles: { some: { OR: [
              { department: { name: contains } },
              { role: { OR: [{ name: contains }, { displayName: contains }] } },
            ] } } },
            { employeeProfile: { departmentRoles: { some: {
              role: { OR: [{ name: contains }, { displayName: contains }] },
            } } } },
          ] };
        }) : []),
      ],
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      middleName: true,
      email: true,
      avatarUrl: true,
      role: { select: { id: true, name: true, displayName: true } },
      departmentRoles: { select: { role: { select: { id: true, name: true, displayName: true } } } },
      employeeProfile: {
        select: {
          avatarUrl: true,
          departmentRoles: { select: { role: { select: { id: true, name: true, displayName: true } } } },
          department: { select: { id: true, name: true } },
          activeDepartment: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
    skip: selfOnly ? 0 : offset,
    take: selfOnly ? 1 : 100,
  });
  const tokens = users.length ? await prisma.trackingDeviceToken.findMany({
    where: { userId: { in: users.map((user) => user.id) }, revokedAt: null },
    orderBy: [{ lastUsedAt: 'desc' }, { createdAt: 'desc' }],
  }) : [];
  const deviceByUser = new Map<number, typeof tokens[number]>();
  tokens.forEach((token) => { if (!deviceByUser.has(token.userId)) deviceByUser.set(token.userId, token); });
  const now = Date.now();
  return res.json(successResponse(await Promise.all(users.map(async (user) => {
    const device = deviceByUser.get(user.id);
    const lastUploadAt = device?.lastUsedAt?.toISOString() ?? null;
    return {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      middleName: user.middleName,
      email: user.email,
      avatarUrl: await resolveObjectUrl(user.employeeProfile?.avatarUrl || user.avatarUrl).catch(() => null),
      role: user.role,
      roles: Array.from(new Map([
        user.role,
        ...user.departmentRoles.map((item) => item.role),
        ...(user.employeeProfile?.departmentRoles || []).map((item) => item.role),
      ].map((role) => [role.id, role])).values()),
      department: user.employeeProfile?.activeDepartment || user.employeeProfile?.department || null,
      tracking: device ? {
        enabled: device.trackingEnabled,
        lastUploadAt,
        stale: !device.lastUsedAt || now - device.lastUsedAt.getTime() > 15 * 60_000,
      } : null,
    };
  })), 'Пользователи геомаршрутов получены'));
});

router.get('/users/:userId/live', rateLimit({ windowSec: 60, limit: 180 }), async (req: AuthRequest, res) => {
  const targetUserId = Number((req.params as any).userId);
  if (!Number.isInteger(targetUserId) || !(await canViewUser(req, targetUserId))) {
    return res.status(403).json(errorResponse('Нет доступа к маршруту пользователя', ErrorCodes.FORBIDDEN));
  }
  const [point, device] = await Promise.all([
    prisma.routePoint.findFirst({ where: { userId: targetUserId }, orderBy: { recordedAt: 'desc' } }),
    prisma.trackingDeviceToken.findFirst({ where: { userId: targetUserId, revokedAt: null }, orderBy: [{ lastUsedAt: 'desc' }, { createdAt: 'desc' }] }),
  ]);
  const ageSeconds = point ? Math.max(0, Math.round((Date.now() - point.recordedAt.getTime()) / 1000)) : null;
  return res.json(successResponse({
    point: point ? {
      id: point.id,
      latitude: point.latitude,
      longitude: point.longitude,
      recordedAt: point.recordedAt.toISOString(),
      accuracy: point.accuracy,
      batteryLevel: point.batteryLevel,
      isCharging: point.isCharging,
      source: point.source,
      ageSeconds,
    } : null,
    device: device ? {
      enabled: device.trackingEnabled,
      lastUploadAt: device.lastUsedAt?.toISOString() ?? null,
      stale: !device.lastUsedAt || Date.now() - device.lastUsedAt.getTime() > 15 * 60_000,
      platform: device.platform,
      appVersion: device.appVersion,
      deviceName: device.deviceName,
    } : null,
  }, 'Текущее состояние геопозиции получено'));
});

router.get('/users/:userId/day', rateLimit({ windowSec: 60, limit: 90 }), async (req: AuthRequest, res) => {
  const targetUserId = Number((req.params as any).userId);
  if (!Number.isInteger(targetUserId) || !(await canViewUser(req, targetUserId))) {
    return res.status(403).json(errorResponse('Нет доступа к маршруту пользователя', ErrorCodes.FORBIDDEN));
  }
  const { day, start, end } = parseDayRange((req.query as any).date);
  const eventCursor = parseEventCursor((req.query as any).eventCursor);
  const requestedEventLimit = finiteNumber((req.query as any).eventLimit);
  const eventLimit = Math.max(20, Math.min(200, Math.round(requestedEventLimit ?? 100)));
  const [points, geoEventsPage, distinctOrders] = await Promise.all([
    prisma.routePoint.findMany({
      where: {
        userId: targetUserId,
        recordedAt: { gte: start, lt: end },
        OR: [{ accuracy: null }, { accuracy: { lte: 150 } }],
      },
      orderBy: { recordedAt: 'asc' },
      take: MAX_DAY_POINTS,
    }),
    prisma.orderGeoEvent.findMany({
      where: {
        userId: targetUserId,
        capturedAt: { gte: start, lt: end },
        ...(eventCursor ? {
          OR: [
            { capturedAt: { gt: eventCursor.capturedAt } },
            { capturedAt: eventCursor.capturedAt, id: { gt: eventCursor.id } },
          ],
        } : {}),
      },
      orderBy: [{ capturedAt: 'asc' }, { id: 'asc' }],
      take: eventLimit + 1,
      include: {
        order: {
          select: {
            guid: true,
            number1c: true,
            date1c: true,
            totalAmount: true,
            counterparty: { select: { name: true } },
          },
        },
      },
    }),
    prisma.orderGeoEvent.findMany({
      where: { userId: targetUserId, capturedAt: { gte: start, lt: end } },
      distinct: ['orderId'],
      select: { orderId: true },
    }),
  ]);
  const hasMoreOrderEvents = geoEventsPage.length > eventLimit;
  const geoEvents = hasMoreOrderEvents ? geoEventsPage.slice(0, eventLimit) : geoEventsPage;
  let distanceMeters = 0;
  let movingSeconds = 0;
  for (let index = 1; index < points.length; index += 1) {
    const segment = haversineMeters(points[index - 1], points[index]);
    if (segment <= 5000) {
      distanceMeters += segment;
      const elapsedSeconds = Math.max(0, (points[index].recordedAt.getTime() - points[index - 1].recordedAt.getTime()) / 1000);
      if (segment >= 15 && elapsedSeconds <= 10 * 60) movingSeconds += elapsedSeconds;
    }
  }
  const polyline = boundedPolyline(points).map((point) => ({
    id: point.id,
    latitude: point.latitude,
    longitude: point.longitude,
    recordedAt: point.recordedAt.toISOString(),
    accuracy: point.accuracy,
    speed: point.speed,
    batteryLevel: point.batteryLevel,
  }));
  const stops = calculateStops(points);
  await writeAudit(req.user!.userId, 'DAY_VIEWED', targetUserId, { day });
  return res.json(successResponse({
    day,
    timezoneOffsetMinutes: DAY_OFFSET_MINUTES,
    summary: {
      pointsCount: points.length,
      distanceMeters: Math.round(distanceMeters),
      movingSeconds: Math.round(movingSeconds),
      startedAt: points[0]?.recordedAt.toISOString() ?? null,
      endedAt: points[points.length - 1]?.recordedAt.toISOString() ?? null,
      stopsCount: stops.length,
      ordersCount: distinctOrders.length,
      truncated: points.length >= MAX_DAY_POINTS,
    },
    polyline,
    stops,
    orderEventsNextCursor: hasMoreOrderEvents && geoEvents.length
      ? encodeEventCursor(geoEvents[geoEvents.length - 1])
      : null,
    orderEvents: geoEvents.map((event) => ({
      id: event.id,
      eventType: event.eventType,
      status: event.status,
      capturedAt: event.capturedAt.toISOString(),
      latitude: event.latitude,
      longitude: event.longitude,
      accuracy: event.accuracy,
      failureReason: event.failureReason,
      order: {
        guid: event.order.guid,
        number: event.order.number1c,
        date: event.order.date1c?.toISOString() ?? null,
        totalAmount: event.order.totalAmount?.toString() ?? null,
        counterpartyName: event.order.counterparty.name,
      },
    })),
  }, 'Дневной геомаршрут получен'));
});

router.post('/users/:userId/location-requests', rateLimit({ windowSec: 60, limit: 30 }), async (req: AuthRequest, res) => {
  const targetUserId = Number((req.params as any).userId);
  if (!Number.isInteger(targetUserId) || !(await canViewUser(req, targetUserId))) {
    return res.status(403).json(errorResponse('Нет доступа к пользователю', ErrorCodes.FORBIDDEN));
  }
  const permissions = new Set(req.user?.permissions || []);
  const role = String(req.user?.role || '').toLowerCase();
  if (targetUserId !== req.user!.userId && !permissions.has('request_tracking_location') && role !== 'admin') {
    return res.status(403).json(errorResponse('Нет права запрашивать геопозицию', ErrorCodes.FORBIDDEN));
  }
  const now = new Date();
  await prisma.trackingLocationRequest.updateMany({
    where: { targetUserId, status: 'PENDING', expiresAt: { lt: now } },
    data: { status: 'TIMED_OUT', completedAt: now, failureReason: 'LOCATION_TIMEOUT' },
  });
  const recent = await prisma.trackingLocationRequest.findFirst({
    where: { targetUserId, requestedAt: { gte: new Date(now.getTime() - LOCATION_REQUEST_COOLDOWN_MS) } },
    orderBy: { requestedAt: 'desc' },
  });
  if (recent?.status === 'PENDING') {
    return res.status(202).json(successResponse(recent, 'Запрос геопозиции уже выполняется'));
  }
  if (recent) {
    return res.status(429).json(errorResponse('Повторный запрос можно сделать через минуту', ErrorCodes.TOO_MANY_REQUESTS));
  }
  const [device, lastPoint] = await Promise.all([
    prisma.trackingDeviceToken.findFirst({
      where: { userId: targetUserId, revokedAt: null, trackingEnabled: true },
      orderBy: [{ lastUsedAt: 'desc' }, { createdAt: 'desc' }],
    }),
    prisma.routePoint.findFirst({ where: { userId: targetUserId }, orderBy: { recordedAt: 'desc' } }),
  ]);
  if (!device) {
    return res.status(409).json(errorResponse('На устройстве сотрудника отслеживание не включено', ErrorCodes.CONFLICT));
  }
  const request = await prisma.trackingLocationRequest.create({
    data: {
      targetUserId,
      requestedByUserId: req.user!.userId,
      trackingDeviceTokenId: device.id,
      expiresAt: new Date(now.getTime() + LOCATION_REQUEST_TIMEOUT_MS),
    },
  });
  const push = await sendPushToUser(targetUserId, {
    data: {
      type: 'TRACKING_LOCATION_REQUEST',
      requestId: request.id,
      expiresAt: request.expiresAt.toISOString(),
    },
    dataOnly: true,
    priority: 'high',
    ttl: Math.ceil(LOCATION_REQUEST_TIMEOUT_MS / 1000),
  });
  await writeAudit(req.user!.userId, 'LOCATION_REQUESTED', targetUserId, { requestId: request.id, push });
  return res.status(202).json(successResponse({
    id: request.id,
    status: request.status,
    requestedAt: request.requestedAt.toISOString(),
    expiresAt: request.expiresAt.toISOString(),
    lastKnown: lastPoint ? {
      latitude: lastPoint.latitude,
      longitude: lastPoint.longitude,
      recordedAt: lastPoint.recordedAt.toISOString(),
      accuracy: lastPoint.accuracy,
    } : null,
  }, 'Запрос геопозиции отправлен'));
});

router.get('/location-requests/:requestId', rateLimit({ windowSec: 60, limit: 180 }), async (req: AuthRequest, res) => {
  const request = await prisma.trackingLocationRequest.findUnique({
    where: { id: (req.params as any).requestId },
    include: { routePoint: true },
  });
  if (!request || !(await canViewUser(req, request.targetUserId))) {
    return res.status(404).json(errorResponse('Запрос геопозиции не найден', ErrorCodes.NOT_FOUND));
  }
  if (request.status === 'PENDING' && request.expiresAt < new Date()) {
    await prisma.trackingLocationRequest.update({
      where: { id: request.id },
      data: { status: 'TIMED_OUT', completedAt: new Date(), failureReason: 'LOCATION_TIMEOUT' },
    });
    request.status = 'TIMED_OUT';
  }
  return res.json(successResponse({
    id: request.id,
    status: request.status,
    requestedAt: request.requestedAt.toISOString(),
    expiresAt: request.expiresAt.toISOString(),
    completedAt: request.completedAt?.toISOString() ?? null,
    failureReason: request.failureReason,
    point: request.routePoint ? {
      id: request.routePoint.id,
      latitude: request.routePoint.latitude,
      longitude: request.routePoint.longitude,
      recordedAt: request.routePoint.recordedAt.toISOString(),
      accuracy: request.routePoint.accuracy,
      batteryLevel: request.routePoint.batteryLevel,
    } : null,
  }, 'Состояние запроса геопозиции получено'));
});

export default router;
