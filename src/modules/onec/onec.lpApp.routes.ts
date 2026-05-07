import express from 'express';
import { ZodError, z } from 'zod';
import { authenticateToken, authorizePermissions, type AuthRequest } from '../../middleware/auth';
import { checkUserStatus } from '../../middleware/checkUserStatus';
import { authorizeServiceAccess } from '../../middleware/serviceAccess';
import prisma from '../../prisma/client';
import { ErrorCodes, errorResponse, successResponse } from '../../utils/apiResponse';
import {
  getOnecLpAppTransportTask,
  getOnecLpAppTransportTasks,
  getOnecLpAppUsers,
  OnecLpAppConfigError,
  OnecLpAppHttpError,
  OnecLpAppNetworkError,
  pingOnecLpApp,
  postOnecLpAppRouteOrder,
  postOnecLpAppTransportTaskToLoading,
  type OnecLpAppQuery,
} from './onec.lpApp.client';

const router = express.Router();

const optionalString = z.preprocess((value) => {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === null) return undefined;
  const text = String(raw).trim();
  return text ? text : undefined;
}, z.string().optional());

const optionalInt = (min: number, max: number) =>
  z.preprocess((value) => {
    const raw = Array.isArray(value) ? value[0] : value;
    if (raw === undefined || raw === null || raw === '') return undefined;
    return raw;
  }, z.coerce.number().int().min(min).max(max).optional());

const transportTasksQuerySchema = z.object({
  driverGuid: optionalString,
  driverUserGuid: optionalString,
  driverPhysicalPersonGuid: optionalString,
  authorGuid: optionalString,
  status: optionalString,
  dateFrom: optionalString,
  dateTo: optionalString,
  limit: optionalInt(1, 500),
  offset: optionalInt(0, 1_000_000),
});

const routeOrderParamsSchema = z.object({
  taskGuid: z.string().trim().min(1),
});

const routeOrderBodySchema = z.object({
  driverGuid: optionalString,
  driverUserGuid: optionalString,
  driverPhysicalPersonGuid: optionalString,
  route: z.array(
    z.object({
      linkKey: z.string().trim().min(1),
      order: z.coerce.number().int().min(1),
    })
  ).min(1),
});

const coordinateSchema = z.coerce.number().finite();

const departurePointSettingsBodySchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('PRESET'),
    presetKey: z.enum(['omsk', 'novosibirsk']),
  }),
  z.object({
    source: z.literal('CUSTOM_MAP'),
    latitude: coordinateSchema.min(-90).max(90),
    longitude: coordinateSchema.min(-180).max(180),
    address: z.string().trim().max(500).optional(),
  }),
  z.object({
    source: z.literal('DEVICE_LOCATION'),
    latitude: coordinateSchema.min(-90).max(90),
    longitude: coordinateSchema.min(-180).max(180),
    address: z.string().trim().max(500).optional(),
  }),
]);

type TransportTasksQuery = z.infer<typeof transportTasksQuerySchema>;
type RouteOrderBody = z.infer<typeof routeOrderBodySchema>;
type DeparturePointSettingsBody = z.infer<typeof departurePointSettingsBodySchema>;
type DriverFilterInput = {
  driverGuid?: string;
  driverUserGuid?: string;
  driverPhysicalPersonGuid?: string;
};

const DEPARTURE_POINT_PRESETS = {
  omsk: {
    key: 'omsk',
    label: 'Омск',
    latitude: 55.030751,
    longitude: 73.358861,
    address: 'улица Вавилова, 242к3, Омск, 644034',
  },
  novosibirsk: {
    key: 'novosibirsk',
    label: 'Новосибирск',
    latitude: 55.103569,
    longitude: 82.93571,
    address: 'Игарская улица, 54к1, Новосибирск, 630020',
  },
} as const;

type DeparturePresetKey = keyof typeof DEPARTURE_POINT_PRESETS;

router.use(authenticateToken, checkUserStatus, authorizeServiceAccess('transport_tasks'));

function canManageTransportTasks(req: AuthRequest<any, any, any, any>) {
  const role = String(req.user?.role ?? '').toLowerCase();
  return (
    role === 'admin' ||
    role === 'administrator' ||
    Boolean(req.user?.permissions?.includes('manage_transport_tasks'))
  );
}

async function loadEmployeeOnecUserGuid(userId: number) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      employeeProfile: {
        select: {
          onecUserGuid: true,
        },
      },
    },
  });

  return user?.employeeProfile?.onecUserGuid?.trim() || null;
}

function asOnecQuery(query: TransportTasksQuery): OnecLpAppQuery {
  return {
    driverGuid: query.driverGuid,
    driverUserGuid: query.driverUserGuid,
    driverPhysicalPersonGuid: query.driverPhysicalPersonGuid,
    authorGuid: query.authorGuid,
    status: query.status,
    dateFrom: query.dateFrom,
    dateTo: query.dateTo,
    limit: query.limit,
    offset: query.offset,
  };
}

function hasDriverFilter(query: DriverFilterInput) {
  return Boolean(query.driverGuid || query.driverUserGuid || query.driverPhysicalPersonGuid);
}

async function buildRouteMutationPayload(
  req: AuthRequest<any, any, RouteOrderBody, any>,
  res: express.Response,
  body: RouteOrderBody
): Promise<RouteOrderBody | undefined> {
  const payload: RouteOrderBody = {
    route: body.route,
  };

  if (canManageTransportTasks(req) && hasDriverFilter(body)) {
    if (body.driverGuid) {
      payload.driverGuid = body.driverGuid;
    }
    if (body.driverUserGuid) {
      payload.driverUserGuid = body.driverUserGuid;
    }
    if (body.driverPhysicalPersonGuid) {
      payload.driverPhysicalPersonGuid = body.driverPhysicalPersonGuid;
    }
  } else {
    const driverUserGuid = await resolveDriverUserGuidForCurrentUser(req, res);
    if (!driverUserGuid) return undefined;
    payload.driverUserGuid = driverUserGuid;
  }

  return payload;
}

function normalizeOptionalAddress(value: string | undefined) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function mapDeparturePointSettings(row: {
  departureSource: string;
  presetKey: string | null;
  latitude: { toNumber: () => number } | number;
  longitude: { toNumber: () => number } | number;
  address: string | null;
  updatedAt: Date;
}) {
  const latitude =
    typeof row.latitude === 'number' ? row.latitude : row.latitude.toNumber();
  const longitude =
    typeof row.longitude === 'number' ? row.longitude : row.longitude.toNumber();

  return {
    source: row.departureSource,
    presetKey: row.presetKey,
    latitude,
    longitude,
    address: row.address,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function getDeparturePointPresets() {
  return Object.values(DEPARTURE_POINT_PRESETS);
}

function mapUpstreamStatus(error: OnecLpAppHttpError) {
  if (error.upstreamStatus === 400) {
    return { status: 400, code: ErrorCodes.VALIDATION_ERROR, message: error.message };
  }
  if (error.upstreamStatus === 404) {
    return { status: 404, code: ErrorCodes.NOT_FOUND, message: error.message };
  }
  if (error.upstreamStatus === 409) {
    return { status: 409, code: ErrorCodes.CONFLICT, message: error.message };
  }
  return { status: 502, code: ErrorCodes.INTERNAL_ERROR, message: 'Ошибка обмена с 1С' };
}

function handleLpAppError(res: express.Response, error: unknown, fallbackMessage: string) {
  if (error instanceof ZodError) {
    return res.status(400).json(errorResponse(error.message, ErrorCodes.VALIDATION_ERROR));
  }

  if (error instanceof OnecLpAppHttpError) {
    const mapped = mapUpstreamStatus(error);
    return res.status(mapped.status).json(
      errorResponse(mapped.message, mapped.code, {
        upstreamStatus: error.upstreamStatus,
        upstreamPayload: error.payload,
      })
    );
  }

  if (error instanceof OnecLpAppNetworkError || error instanceof OnecLpAppConfigError) {
    return res.status(502).json(
      errorResponse('Ошибка обмена с 1С', ErrorCodes.INTERNAL_ERROR, {
        reason: error.message,
      })
    );
  }

  console.error(fallbackMessage, error);
  return res.status(500).json(errorResponse(fallbackMessage, ErrorCodes.INTERNAL_ERROR));
}

async function resolveDriverUserGuidForCurrentUser(req: AuthRequest<any, any, any, any>, res: express.Response) {
  const driverUserGuid = await loadEmployeeOnecUserGuid(req.user!.userId);
  if (!driverUserGuid) {
    res
      .status(409)
      .json(errorResponse('Для пользователя не задан GUID пользователя 1С', ErrorCodes.CONFLICT));
    return null;
  }
  return driverUserGuid;
}

router.get('/ping', authorizePermissions(['view_transport_tasks']), async (_req: AuthRequest, res) => {
  try {
    const payload = await pingOnecLpApp();
    return res.json(successResponse(payload, '1С сервис доступен'));
  } catch (error) {
    return handleLpAppError(res, error, 'Ошибка проверки доступности 1С');
  }
});

router.get('/users', authorizePermissions(['manage_transport_tasks']), async (_req: AuthRequest, res) => {
  try {
    const payload = await getOnecLpAppUsers();
    return res.json(successResponse(payload, 'Пользователи 1С'));
  } catch (error) {
    return handleLpAppError(res, error, 'Ошибка получения пользователей 1С');
  }
});

router.get(
  '/departure-point-settings',
  authorizePermissions(['view_transport_tasks']),
  async (req: AuthRequest, res) => {
    try {
      const row = await prisma.userTransportTaskSettings.findUnique({
        where: { userId: req.user!.userId },
      });

      return res.json(
        successResponse(
          {
            presets: getDeparturePointPresets(),
            departurePoint: row ? mapDeparturePointSettings(row) : null,
            requiresInitialSelection: !row,
          },
          'Настройки точки отправления'
        )
      );
    } catch (error) {
      return handleLpAppError(res, error, 'Ошибка получения настроек точки отправления');
    }
  }
);

router.put(
  '/departure-point-settings',
  authorizePermissions(['view_transport_tasks']),
  async (req: AuthRequest<{}, unknown, DeparturePointSettingsBody>, res) => {
    const body = departurePointSettingsBodySchema.safeParse(req.body);
    if (!body.success) {
      return handleLpAppError(res, body.error, 'Ошибка тела запроса точки отправления');
    }

    try {
      const payload = body.data;
      const data =
        payload.source === 'PRESET'
          ? (() => {
              const preset = DEPARTURE_POINT_PRESETS[payload.presetKey as DeparturePresetKey];
              return {
                departureSource: payload.source,
                presetKey: preset.key,
                latitude: preset.latitude,
                longitude: preset.longitude,
                address: preset.address,
              };
            })()
          : {
              departureSource: payload.source,
              presetKey: null,
              latitude: payload.latitude,
              longitude: payload.longitude,
              address: normalizeOptionalAddress(payload.address),
            };

      const row = await prisma.userTransportTaskSettings.upsert({
        where: { userId: req.user!.userId },
        create: {
          userId: req.user!.userId,
          ...data,
        },
        update: data,
      });

      return res.json(
        successResponse(
          {
            presets: getDeparturePointPresets(),
            departurePoint: mapDeparturePointSettings(row),
            requiresInitialSelection: false,
          },
          'Точка отправления сохранена'
        )
      );
    } catch (error) {
      return handleLpAppError(res, error, 'Ошибка сохранения точки отправления');
    }
  }
);

router.get(
  '/transport-tasks',
  authorizePermissions(['view_transport_tasks']),
  async (req: AuthRequest<{}, unknown, unknown, Record<string, unknown>>, res) => {
    const parsed = transportTasksQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return handleLpAppError(res, parsed.error, 'Ошибка параметров заданий на перевозку');
    }

    try {
      const query = asOnecQuery(parsed.data);
      if (!canManageTransportTasks(req) || !hasDriverFilter(parsed.data)) {
        const driverUserGuid = await resolveDriverUserGuidForCurrentUser(req, res);
        if (!driverUserGuid) return undefined;
        query.driverUserGuid = driverUserGuid;
        delete query.driverGuid;
        delete query.driverPhysicalPersonGuid;
      }

      const payload = await getOnecLpAppTransportTasks(query);
      return res.json(successResponse(payload, 'Задания на перевозку'));
    } catch (error) {
      return handleLpAppError(res, error, 'Ошибка получения заданий на перевозку');
    }
  }
);

router.get(
  '/transport-tasks/:taskGuid',
  authorizePermissions(['view_transport_tasks']),
  async (req: AuthRequest<{ taskGuid: string }, unknown, unknown, Record<string, unknown>>, res) => {
    const params = routeOrderParamsSchema.safeParse(req.params);
    if (!params.success) {
      return handleLpAppError(res, params.error, 'Ошибка параметров задания на перевозку');
    }

    const parsed = transportTasksQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return handleLpAppError(res, parsed.error, 'Ошибка параметров задания на перевозку');
    }

    try {
      const query = asOnecQuery(parsed.data);
      if (!canManageTransportTasks(req) || !hasDriverFilter(parsed.data)) {
        const driverUserGuid = await resolveDriverUserGuidForCurrentUser(req, res);
        if (!driverUserGuid) return undefined;
        query.driverUserGuid = driverUserGuid;
        delete query.driverGuid;
        delete query.driverPhysicalPersonGuid;
      }

      const payload = await getOnecLpAppTransportTask(params.data.taskGuid, query);
      return res.json(successResponse(payload, 'Задание на перевозку'));
    } catch (error) {
      return handleLpAppError(res, error, 'Ошибка получения задания на перевозку');
    }
  }
);

router.post(
  '/transport-tasks/:taskGuid/route-order',
  authorizePermissions(['update_transport_route_order']),
  async (req: AuthRequest<{ taskGuid: string }, unknown, RouteOrderBody>, res) => {
    const params = routeOrderParamsSchema.safeParse(req.params);
    if (!params.success) {
      return handleLpAppError(res, params.error, 'Ошибка параметров маршрута');
    }

    const body = routeOrderBodySchema.safeParse(req.body);
    if (!body.success) {
      return handleLpAppError(res, body.error, 'Ошибка тела запроса маршрута');
    }

    try {
      const payload = await buildRouteMutationPayload(req, res, body.data);
      if (!payload) return undefined;

      const upstream = await postOnecLpAppRouteOrder(params.data.taskGuid, payload);
      return res.json(successResponse(upstream, 'Порядок маршрута сохранен'));
    } catch (error) {
      return handleLpAppError(res, error, 'Ошибка сохранения порядка маршрута');
    }
  }
);

router.post(
  '/transport-tasks/:taskGuid/to-loading',
  authorizePermissions(['update_transport_route_order']),
  async (req: AuthRequest<{ taskGuid: string }, unknown, RouteOrderBody>, res) => {
    const params = routeOrderParamsSchema.safeParse(req.params);
    if (!params.success) {
      return handleLpAppError(res, params.error, 'Ошибка параметров маршрута');
    }

    const body = routeOrderBodySchema.safeParse(req.body);
    if (!body.success) {
      return handleLpAppError(res, body.error, 'Ошибка тела запроса маршрута');
    }

    try {
      const payload = await buildRouteMutationPayload(req, res, body.data);
      if (!payload) return undefined;

      const upstream = await postOnecLpAppTransportTaskToLoading(params.data.taskGuid, payload);
      return res.json(successResponse(upstream, 'Задание передано к погрузке'));
    } catch (error) {
      return handleLpAppError(res, error, 'Ошибка передачи задания к погрузке');
    }
  }
);

export default router;
