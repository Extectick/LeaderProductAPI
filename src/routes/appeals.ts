// src/routes/appeals.ts
import express from 'express';

import multer from 'multer';
import { Parser } from 'json2csv';
import {
  Prisma,
  AppealStatus,
  AppealPriority,
  AttachmentType,
  AppealMessageType,
} from '@prisma/client';
import prisma from '../prisma/client';
import { z } from 'zod';

import {
  authenticateToken,
  authorizePermissions,
  AuthRequest,
} from '../middleware/auth';
import { authorizeServiceAccess } from '../middleware/serviceAccess';
import { checkUserStatus } from '../middleware/checkUserStatus';
import {
  successResponse,
  errorResponse,
  ErrorCodes,
} from '../utils/apiResponse';

import {
  AppealCreateResponse,
  AppealListResponse,
  AppealDetailResponse,
  AppealAssignResponse,
  AppealStatusUpdateResponse,
  AppealAddMessageResponse,
  AppealMessagesResponse,
  AppealReadBulkResponse,
  AppealWatchersUpdateResponse,
  AppealDeleteMessageResponse,
  AppealEditMessageResponse,
  AppealClaimResponse,
  AppealDepartmentChangeResponse,
} from '../types/appealTypes';

import { Server as SocketIOServer } from 'socket.io';

// Схемы валидации
import {
  CreateAppealBodySchema,
  CreateAppealBody,
  ListQuerySchema,
  MessagesQuerySchema,
  IdParamSchema,
  MessageIdParamSchema,
  AssignBodySchema,
  StatusBodySchema,
  ChangeDepartmentBodySchema,
  AddMessageBodySchema,
  ReadBulkBodySchema,
  WatchersBodySchema,
  EditMessageBodySchema,
  ExportQuerySchema,
} from '../validation/appeals.schema';

// === импорт облачного хранилища (MinIO / S3-совместимое) ===
import { resolveObjectUrl, uploadMulterFile } from '../storage/minio';
import { cacheGet, cacheSet, cacheDel, cacheDelPrefix } from '../utils/cache';
import { randomUUID } from 'node:crypto';
import { sendPushToUser } from '../services/pushService';

// минимальный интерфейс БД, который есть и у PrismaClient, и у TransactionClient
type HasAppealAttachment = {
  appealAttachment: Prisma.AppealAttachmentDelegate<any>;
};

const userMiniSelect = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  avatarUrl: true,
  currentProfileType: true,
  role: { select: { id: true, name: true } },
  departmentRoles: {
    select: {
      departmentId: true,
      role: { select: { name: true } },
    },
  },
  employeeProfile: {
    select: {
      avatarUrl: true,
      department: { select: { id: true, name: true } },
    },
  },
  clientProfile: { select: { avatarUrl: true } },
  supplierProfile: { select: { avatarUrl: true } },
} as const;

type UserMiniRaw = Prisma.UserGetPayload<{ select: typeof userMiniSelect }>;

type MessageWithRelations = Prisma.AppealMessageGetPayload<{
  include: {
    attachments: true;
    reads: { select: { userId: true; readAt: true } };
    sender: { select: typeof userMiniSelect };
  };
}>;

const STATUS_LABELS: Record<AppealStatus, string> = {
  OPEN: 'Открыто',
  IN_PROGRESS: 'В работе',
  RESOLVED: 'Ожидание подтверждения',
  COMPLETED: 'Завершено',
  DECLINED: 'Отклонено',
};

function getUserDisplayName(user: UserMiniRaw | null) {
  if (!user) return 'Пользователь';
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return name || user.email || 'Пользователь';
}

function isAdminRole(user: UserMiniRaw | null) {
  return user?.role?.name === 'admin';
}

function isDepartmentManager(user: UserMiniRaw | null, departmentId?: number | null) {
  if (!user || !departmentId) return false;
  return (user.departmentRoles || []).some(
    (dr) => dr.departmentId === departmentId && dr.role?.name === 'department_manager'
  );
}

async function mapUserMini(user: UserMiniRaw | null) {
  if (!user) return null;
  const avatarKey =
    user.employeeProfile?.avatarUrl ??
    user.clientProfile?.avatarUrl ??
    user.supplierProfile?.avatarUrl ??
    user.avatarUrl ??
    null;
  const avatarUrl = await resolveObjectUrl(avatarKey ?? null);
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    avatarUrl,
    department: user.employeeProfile?.department ?? null,
    isAdmin: isAdminRole(user),
    isDepartmentManager: (user.departmentRoles || []).some(
      (dr) => dr.role?.name === 'department_manager'
    ),
  };
}

const router = express.Router();

// Храним файлы в памяти, чтобы получить file.buffer и отправить в MinIO
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50 MB на файл (измените под себя)
    files: 20,                  // макс. файлов за раз
  },
  // fileFilter: ...
});

/** Определение типа вложения по mime */
function detectAttachmentType(mime: string): AttachmentType {
  if (mime?.startsWith('image/')) return 'IMAGE';
  if (mime?.startsWith('audio/')) return 'AUDIO';
  return 'FILE';
}

/** Унифицированное сообщение Zod-ошибки */
function zodErrorMessage(e: z.ZodError) {
  const i = e.issues?.[0];
  if (!i) return 'Ошибка валидации';
  const where = i.path?.length ? ` [${i.path.join('.')}]` : '';
  return `${i.message}${where}`;
}

/** Вспомогательно: загрузка всех файлов сообщения в MinIO и создание записей в БД */
async function saveMulterFilesToAppealMessage(
  db: HasAppealAttachment,
  files: Express.Multer.File[] | undefined,
  messageId: number
) {
  const list = files ?? [];
  for (const file of list) {
    const stored = await uploadMulterFile(file, /*asAttachment*/ false);
    await db.appealAttachment.create({
      data: {
        messageId,
        fileUrl: stored.key,
        fileName: stored.fileName,
        fileType: detectAttachmentType(file.mimetype),
      },
    });
  }
}

async function mapAttachments(attachments: any[] | undefined) {
  const list = attachments ?? [];
  if (!list.length) return [];
  return Promise.all(
    list.map(async (att: any) => ({
      ...att,
      fileUrl: await resolveObjectUrl(att.fileUrl ?? null),
    }))
  );
}

/** Приведение сообщения к фронтовому виду с флагом прочтения */
async function mapMessageWithReads(
  message: MessageWithRelations,
  currentUserId: number
) {
  const readBy = (message.reads ?? []).map((r) => ({
    userId: r.userId,
    readAt: r.readAt,
  }));
  // Считаем собственные сообщения прочитанными для себя, чтобы они не попадали в unread
  const isOwn = message.senderId === currentUserId;
  return {
    id: message.id,
    appealId: message.appealId,
    senderId: message.senderId,
    text: message.text,
    type: message.type ?? AppealMessageType.USER,
    systemEvent: message.systemEvent ?? null,
    editedAt: message.editedAt,
    deleted: message.deleted,
    createdAt: message.createdAt,
    attachments: await mapAttachments(message.attachments),
    sender: await mapUserMini(message.sender),
    readBy,
    isRead: isOwn || readBy.some((r) => r.userId === currentUserId),
  };
}

async function mapMessageForRealtime(message: MessageWithRelations) {
  return {
    id: message.id,
    appealId: message.appealId,
    senderId: message.senderId,
    text: message.text,
    type: message.type ?? AppealMessageType.USER,
    systemEvent: message.systemEvent ?? null,
    editedAt: message.editedAt,
    deleted: message.deleted,
    createdAt: message.createdAt,
    attachments: await mapAttachments(message.attachments),
    sender: await mapUserMini(message.sender),
    readBy: (message.reads ?? []).map((r) => ({ userId: r.userId, readAt: r.readAt })),
  };
}

function encodeMessageCursor(createdAt: Date, id: number) {
  return `${createdAt.toISOString()}|${id}`;
}

function decodeMessageCursor(raw?: string | null) {
  if (!raw) return null;
  const [iso, idStr] = raw.split('|');
  if (!iso || !idStr) return null;
  const dt = new Date(iso);
  const id = Number(idStr);
  if (!Number.isFinite(id) || Number.isNaN(dt.getTime())) return null;
  return { createdAt: dt, id };
}

async function loadUserMini(userId: number) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: userMiniSelect,
  });
}

function buildMessageCursorWhere(opts: {
  appealId: number;
  parsedCursor?: { createdAt: Date; id: number } | null;
  direction: 'before' | 'after';
}): Prisma.AppealMessageWhereInput {
  const where: Prisma.AppealMessageWhereInput = {
    appealId: opts.appealId,
    deleted: false,
  };
  if (!opts.parsedCursor) return where;

  if (opts.direction === 'before') {
    where.OR = [
      { createdAt: { lt: opts.parsedCursor.createdAt } },
      { createdAt: opts.parsedCursor.createdAt, id: { lt: opts.parsedCursor.id } },
    ];
  } else {
    where.OR = [
      { createdAt: { gt: opts.parsedCursor.createdAt } },
      { createdAt: opts.parsedCursor.createdAt, id: { gt: opts.parsedCursor.id } },
    ];
  }
  return where;
}

async function emitAppealUpdated(opts: {
  io: SocketIOServer;
  appealId: number;
  userIds?: number[];
  toDepartmentId?: number | null;
  assigneeIds?: number[];
  lastMessage?: any | null;
}) {
  const appeal = await prisma.appeal.findUnique({
    where: { id: opts.appealId },
    include: {
      assignees: { select: { userId: true } },
      watchers: { select: { userId: true } },
      messages: {
        where: { deleted: false },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 1,
        include: {
          sender: { select: userMiniSelect },
          attachments: true,
          reads: { select: { userId: true, readAt: true } },
        },
      },
    },
  });
  if (!appeal) return;

  const assigneeIds = opts.assigneeIds ?? appeal.assignees.map((a) => a.userId);
  const lastMessage =
    opts.lastMessage ??
    (appeal.messages[0]
      ? await mapMessageForRealtime(appeal.messages[0] as MessageWithRelations)
      : null);
  const payload = {
    appealId: appeal.id,
    status: appeal.status,
    priority: appeal.priority,
    toDepartmentId: appeal.toDepartmentId,
    updatedAt: appeal.updatedAt,
    assigneeIds,
    lastMessage,
  };

  const toDepartmentId = opts.toDepartmentId ?? appeal.toDepartmentId;
  const userIds = Array.from(
    new Set([
      ...(opts.userIds || []),
      appeal.createdById,
      ...appeal.assignees.map((a) => a.userId),
      ...appeal.watchers.map((w) => w.userId),
    ])
  );

  opts.io.to(`appeal:${appeal.id}`).emit('appealUpdated', payload);
  if (toDepartmentId) {
    opts.io.to(`department:${toDepartmentId}`).emit('appealUpdated', payload);
  }
  userIds.forEach((uid) => opts.io.to(`user:${uid}`).emit('appealUpdated', payload));
}

async function createSystemMessage(opts: {
  appealId: number;
  actorId: number;
  text: string;
  systemEvent: Record<string, any>;
  io: SocketIOServer;
  toDepartmentId?: number | null;
  recipients?: number[];
}) {
  const message = await prisma.appealMessage.create({
    data: {
      appealId: opts.appealId,
      senderId: opts.actorId,
      text: opts.text,
      type: AppealMessageType.SYSTEM,
      systemEvent: opts.systemEvent,
    },
  });

  const fullMessage = await prisma.appealMessage.findUnique({
    where: { id: message.id },
    include: {
      sender: { select: userMiniSelect },
      attachments: true,
      reads: { select: { userId: true, readAt: true } },
    },
  });
  if (!fullMessage) return null;

  const mapped = await mapMessageWithReads(fullMessage as MessageWithRelations, opts.actorId);
  opts.io.to(`appeal:${opts.appealId}`).emit('messageAdded', mapped);
  if (opts.toDepartmentId) {
    opts.io.to(`department:${opts.toDepartmentId}`).emit('messageAdded', mapped);
  }
  const recipients = Array.from(new Set(opts.recipients || []));
  recipients.forEach((uid) => opts.io.to(`user:${uid}`).emit('messageAdded', mapped));
  return mapped;
}

async function sendPushToUsers(
  userIds: number[],
  title: string,
  body: string,
  data?: Record<string, any>
) {
  const uniq = Array.from(new Set(userIds));
  if (!uniq.length) return;
  await Promise.allSettled(
    uniq.map((userId) =>
      sendPushToUser(userId, {
        title,
        body,
        data,
        sound: 'default',
        channelId: 'appeal-message',
      })
    )
  );
}


// POST /appeals — создание обращения + первое сообщение + загрузка вложений в облако
/**
 * @openapi
 * /appeals:
 *   post:
 *     tags: [Appeals]
 *     summary: Создать новое обращение
 *     description: Создаёт обращение и первое сообщение; поддерживает загрузку вложений.
 *     security: [ { bearerAuth: [] } ]
 *     x-permissions: ["create_appeal"]
 */
router.post(
  '/',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['create_appeal']),
  upload.array('attachments'), // важно: именно массив "attachments"
  async (
    req: AuthRequest<{}, AppealCreateResponse, CreateAppealBody>,
    res: express.Response
  ) => {
    try {
      // 1) Валидация multipart-body (все поля приходят как строки)
      const parsed = CreateAppealBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json(
            errorResponse(
              zodErrorMessage(parsed.error),
              ErrorCodes.VALIDATION_ERROR
            )
          );
      }
      const { toDepartmentId, title, text, priority, deadline } = parsed.data;
      const normalizedText = text.trim();
      const normalizedTitle = title?.trim() || normalizedText;

      // 2) Проверяем существование отдела-получателя
      const targetDept = await prisma.department.findUnique({
        where: { id: toDepartmentId },
      });
      if (!targetDept) {
        return res
          .status(404)
          .json(
            errorResponse('Отдел-получатель не найден', ErrorCodes.NOT_FOUND)
          );
      }

      const userId = req.user!.userId;

      // 3) Профиль сотрудника (для fromDepartmentId)
      const employee = await prisma.employeeProfile.findUnique({
        where: { userId },
      });

      // 4) Следующий номер обращения
      const lastAppeal = await prisma.appeal.findFirst({
        orderBy: { number: 'desc' },
      });
      const nextNumber = lastAppeal ? lastAppeal.number + 1 : 1;

      // 5) Транзакция: создаём Appeal, первое сообщение и вложения
      const createdAppeal = await prisma.$transaction(async (tx) => {
        const appeal = await tx.appeal.create({
          data: {
            number: nextNumber,
            fromDepartmentId: employee?.departmentId ?? null,
            toDepartmentId,
            createdById: userId,
            status: AppealStatus.OPEN,
            priority: (priority as AppealPriority) ?? AppealPriority.MEDIUM,
            deadline: deadline ? new Date(deadline) : null,
            title: normalizedTitle,
          },
        });

        const message = await tx.appealMessage.create({
          data: {
            appealId: appeal.id,
            senderId: userId,
            text: normalizedText, // первый текст сообщения из формы
          },
        });

        // --- загрузка вложений в MinIO ---
        await saveMulterFilesToAppealMessage(
          tx as unknown as HasAppealAttachment,
          (req.files as Express.Multer.File[]) ?? [],
          message.id
        );
        // --- конец загрузки вложений ---

        return appeal;
      });

      // Инвалидация кэша списков/деталей, чтобы новое обращение появилось сразу
      await cacheDelPrefix('appeals:list:');
      await cacheDelPrefix('appeal:');

      // 6) WebSocket-уведомление отдела-получателя
      const io = req.app.get('io') as SocketIOServer;
      io.to(`department:${createdAppeal.toDepartmentId}`).emit('appealCreated', {
        id: createdAppeal.id,
        number: createdAppeal.number,
        status: createdAppeal.status,
        priority: createdAppeal.priority,
        title: createdAppeal.title,
      });

      // 7) Ответ
      return res.status(201).json(
        successResponse(
          {
            id: createdAppeal.id,
            number: createdAppeal.number,
            status: createdAppeal.status,
            priority: createdAppeal.priority,
            createdAt: createdAppeal.createdAt,
          },
          'Обращение создано'
        )
      );
    } catch (error) {
      console.error('Ошибка создания обращения:', error);
      return res
        .status(500)
        .json(
          errorResponse('Ошибка создания обращения', ErrorCodes.INTERNAL_ERROR)
        );
    }
  }
);


/**
 * @openapi
 * /appeals:
 *   get:
 *     tags: [Appeals]
 *     summary: Список обращений
 *     security: [ { bearerAuth: [] } ]
 *     x-permissions: ["view_appeal"]
 */
router.get(
  '/',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['view_appeal']),
  async (req: AuthRequest<{}, AppealListResponse>, res: express.Response) => {
    try {
      const parsed = ListQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res
          .status(400)
          .json(errorResponse(zodErrorMessage(parsed.error), ErrorCodes.VALIDATION_ERROR));
      }
      const { scope, limit, offset, status, priority } = parsed.data;

      const userId = req.user!.userId;

      let where: any = {};
      switch (scope) {
        case 'my':
          where.createdById = userId;
          break;
        case 'department': {
          const employee = await prisma.employeeProfile.findUnique({ where: { userId } });
          if (!employee?.departmentId) {
            return res
              .status(400)
              .json(errorResponse('У пользователя не указан отдел', ErrorCodes.VALIDATION_ERROR));
          }
          where.toDepartmentId = employee.departmentId;
          break;
        }
        case 'assigned':
          where.assignees = { some: { userId } };
          break;
      }

      if (status) where.status = status;
      if (priority) where.priority = priority;

      const cacheKey = `appeals:list:${userId}:${scope}:${status || ''}:${priority || ''}:${limit}:${offset}`;
      const cached = await cacheGet<{ data: any[]; meta: { total: number; limit: number; offset: number } }>(cacheKey);
      if (cached) {
        return res.json(successResponse(cached, 'Список обращений'));
      }

      const [total, appeals] = await prisma.$transaction([
        prisma.appeal.count({ where }),
        prisma.appeal.findMany({
          where,
          include: {
            fromDepartment: true,
            toDepartment: true,
            assignees: {
              include: {
                user: { select: userMiniSelect },
              },
            },
            messages: {
              where: { deleted: false },
              orderBy: { createdAt: 'desc' },
              take: 1,
              include: {
                attachments: true,
                reads: { select: { userId: true, readAt: true } },
                sender: {
                  select: userMiniSelect,
                },
              },
            },
            _count: {
              select: {
                messages: {
                  where: {
                    deleted: false,
                    senderId: { not: userId },
                    reads: { none: { userId } },
                  },
                },
              },
            },
          },
          orderBy: { updatedAt: 'desc' },
          skip: offset,
          take: limit,
        }),
      ]);

      const responseData = {
        data: await Promise.all(
          appeals.map(async (a: any) => {
            const { messages, _count, ...rest } = a;
            const lastMessage = messages?.[0]
              ? await mapMessageWithReads(messages[0] as MessageWithRelations, userId)
              : null;
            const assignees = await Promise.all(
              (a.assignees || []).map(async (as: any) => ({
                user: await mapUserMini(as.user as UserMiniRaw),
              }))
            );
            return {
              ...rest,
              assignees,
              lastMessage,
              unreadCount: _count?.messages ?? 0,
            };
          })
        ),
        meta: { total, limit, offset },
      };
      await cacheSet(cacheKey, responseData, 60);

      return res.json(successResponse(responseData, 'Список обращений'));
    } catch (error) {
      console.error('Ошибка получения списка обращений:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка получения списка обращений', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

/**
 * @openapi
 * /appeals/{id}:
 *   get:
 *     tags: [Appeals]
 *     summary: Детали обращения
 *     security: [ { bearerAuth: [] } ]
 *     x-permissions: ["view_appeal"]
 */
  router.get(
    '/:id',
    authenticateToken,
    checkUserStatus,
    authorizeServiceAccess('appeals'),
    authorizePermissions(['view_appeal']),
  async (req: AuthRequest<{ id: string }, AppealDetailResponse>, res: express.Response) => {
    try {
      const parsed = IdParamSchema.safeParse(req.params);
      if (!parsed.success) {
        return res
          .status(400)
          .json(errorResponse(zodErrorMessage(parsed.error), ErrorCodes.VALIDATION_ERROR));
      }
      const { id: appealId } = parsed.data;

      const appeal = await prisma.appeal.findUnique({
        where: { id: appealId },
        include: {
          fromDepartment: true,
          toDepartment: true,
          createdBy: { select: userMiniSelect },
          assignees: { include: { user: { select: userMiniSelect } } },
          watchers: { include: { user: { select: userMiniSelect } } },
          statusHistory: { orderBy: { changedAt: 'desc' }, include: { changedBy: { select: userMiniSelect } } },
          messages: {
            where: { deleted: false },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 30,
            include: {
              sender: { select: userMiniSelect },
              attachments: true,
              reads: { select: { userId: true, readAt: true } },
            },
          },
        },
      });

      if (!appeal) {
        return res.status(404).json(errorResponse('Обращение не найдено', ErrorCodes.NOT_FOUND));
      }

      const userId = req.user!.userId;
      const isCreator = appeal.createdById === userId;
      const isAssignee = appeal.assignees.some((a: any) => a.userId === userId);
      const employee = await prisma.employeeProfile.findFirst({
        where: { userId, departmentId: appeal.toDepartmentId },
      });

      if (!isCreator && !isAssignee && !employee) {
        return res
          .status(403)
          .json(errorResponse('Нет доступа к этому обращению', ErrorCodes.FORBIDDEN));
      }

      const mappedAppeal = {
        ...appeal,
        createdBy: await mapUserMini(appeal.createdBy as UserMiniRaw),
        assignees: await Promise.all(
          (appeal.assignees || []).map(async (as: any) => ({
            user: await mapUserMini(as.user as UserMiniRaw),
          }))
        ),
        watchers: await Promise.all(
          (appeal.watchers || []).map(async (w: any) => ({
            user: await mapUserMini(w.user as UserMiniRaw),
          }))
        ),
        statusHistory: await Promise.all(
          (appeal.statusHistory || []).map(async (h: any) => ({
            ...h,
            changedBy: await mapUserMini(h.changedBy as UserMiniRaw),
          }))
        ),
        messages: await Promise.all(
          [...appeal.messages].reverse().map((m) =>
            mapMessageWithReads(m as MessageWithRelations, userId)
          )
        ),
      };

      return res.json(successResponse(mappedAppeal, 'Детали обращения'));
    } catch (error) {
      console.error('Ошибка получения обращения:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка получения обращения', ErrorCodes.INTERNAL_ERROR));
      }
    }
  );

  /**
   * @openapi
   * /appeals/{id}/messages:
   *   get:
   *     tags: [Appeals]
   *     summary: Получить сообщения обращения (пагинация)
   *     security: [ { bearerAuth: [] } ]
   *     x-permissions: ["view_appeal"]
   */
  router.get(
    '/:id/messages',
    authenticateToken,
    checkUserStatus,
    authorizeServiceAccess('appeals'),
    authorizePermissions(['view_appeal']),
    async (req: AuthRequest<{ id: string }, AppealMessagesResponse>, res: express.Response) => {
      try {
        const p = IdParamSchema.safeParse(req.params);
        if (!p.success) {
          return res
            .status(400)
            .json(errorResponse(zodErrorMessage(p.error), ErrorCodes.VALIDATION_ERROR));
        }
        const q = MessagesQuerySchema.safeParse(req.query);
        if (!q.success) {
          return res
            .status(400)
            .json(errorResponse(zodErrorMessage(q.error), ErrorCodes.VALIDATION_ERROR));
        }

        const { id: appealId } = p.data;
        const {
          limit,
          cursor,
          direction = 'before',
          mode = 'page',
          anchor,
          before,
          after,
        } = q.data as {
          limit: number;
          cursor?: string;
          direction?: 'before' | 'after';
          mode?: 'page' | 'bootstrap';
          anchor?: 'first_unread' | 'last_unread';
          before?: number;
          after?: number;
        };
        const parsedCursor = decodeMessageCursor(cursor);
        if (cursor && !parsedCursor) {
          return res
            .status(400)
            .json(errorResponse('Некорректный cursor', ErrorCodes.VALIDATION_ERROR));
        }

        const appeal = await prisma.appeal.findUnique({
          where: { id: appealId },
          include: {
            assignees: { select: { userId: true } },
          },
        });
        if (!appeal) {
          return res.status(404).json(errorResponse('Обращение не найдено', ErrorCodes.NOT_FOUND));
        }

        const userId = req.user!.userId;
        const isCreator = appeal.createdById === userId;
        const isAssignee = appeal.assignees.some((a) => a.userId === userId);
        const employee = await prisma.employeeProfile.findFirst({
          where: { userId, departmentId: appeal.toDepartmentId },
        });

        if (!isCreator && !isAssignee && !employee) {
          return res
            .status(403)
            .json(errorResponse('Нет доступа к этому обращению', ErrorCodes.FORBIDDEN));
        }

        let ordered: any[] = [];
        let hasMoreBefore = false;
        let hasMoreAfter = false;
        let prevCursor: string | null = null;
        let nextCursor: string | null = null;
        let anchorMessageId: number | null = null;

        if (mode === 'bootstrap') {
          const beforeTake = before ?? 40;
          const afterTake = after ?? 20;
          let firstUnread: { id: number; createdAt: Date } | null = null;

          if (anchor === 'first_unread' || anchor === 'last_unread') {
            firstUnread = await prisma.appealMessage.findFirst({
              where: {
                appealId,
                deleted: false,
                senderId: { not: userId },
                reads: { none: { userId } },
              },
              orderBy:
                anchor === 'last_unread'
                  ? [{ createdAt: 'desc' }, { id: 'desc' }]
                  : [{ createdAt: 'asc' }, { id: 'asc' }],
              select: { id: true, createdAt: true },
            });
          }

          if (firstUnread) {
            anchorMessageId = firstUnread.id;
            const olderRaw = await prisma.appealMessage.findMany({
              where: {
                appealId,
                deleted: false,
                OR: [
                  { createdAt: { lt: firstUnread.createdAt } },
                  { createdAt: firstUnread.createdAt, id: { lt: firstUnread.id } },
                ],
              },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              take: beforeTake + 1,
              include: {
                sender: { select: userMiniSelect },
                attachments: true,
                reads: { select: { userId: true, readAt: true } },
              },
            });
            const olderPage = olderRaw.slice(0, beforeTake);
            hasMoreBefore = olderRaw.length > beforeTake;

            const newerRaw = await prisma.appealMessage.findMany({
              where: {
                appealId,
                deleted: false,
                OR: [
                  { createdAt: { gt: firstUnread.createdAt } },
                  { createdAt: firstUnread.createdAt, id: { gte: firstUnread.id } },
                ],
              },
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              take: afterTake + 2,
              include: {
                sender: { select: userMiniSelect },
                attachments: true,
                reads: { select: { userId: true, readAt: true } },
              },
            });
            const newerPage = newerRaw.slice(0, afterTake + 1);
            hasMoreAfter = newerRaw.length > afterTake + 1;

            ordered = [...olderPage.reverse(), ...newerPage];
          } else {
            const raw = await prisma.appealMessage.findMany({
              where: { appealId, deleted: false },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              take: limit + 1,
              include: {
                sender: { select: userMiniSelect },
                attachments: true,
                reads: { select: { userId: true, readAt: true } },
              },
            });
            hasMoreBefore = raw.length > limit;
            ordered = raw.slice(0, limit).reverse();
          }
        } else {
          const where = buildMessageCursorWhere({
            appealId,
            parsedCursor,
            direction,
          });
          const raw = await prisma.appealMessage.findMany({
            where,
            orderBy:
              direction === 'before'
                ? [{ createdAt: 'desc' }, { id: 'desc' }]
                : [{ createdAt: 'asc' }, { id: 'asc' }],
            take: limit + 1,
            include: {
              sender: { select: userMiniSelect },
              attachments: true,
              reads: { select: { userId: true, readAt: true } },
            },
          });

          const hasMore = raw.length > limit;
          const page = raw.slice(0, limit);
          ordered = direction === 'before' ? page.reverse() : page;
          if (direction === 'before') {
            hasMoreBefore = hasMore;
            hasMoreAfter = !!parsedCursor;
          } else {
            hasMoreAfter = hasMore;
            hasMoreBefore = !!parsedCursor;
          }
        }

        if (ordered.length) {
          prevCursor = encodeMessageCursor(ordered[0].createdAt as Date, ordered[0].id);
          nextCursor = encodeMessageCursor(
            ordered[ordered.length - 1].createdAt as Date,
            ordered[ordered.length - 1].id
          );
        }

        const mapped = await Promise.all(
          ordered.map((m) => mapMessageWithReads(m as MessageWithRelations, userId))
        );
        const compatHasMore = direction === 'after' ? hasMoreAfter : hasMoreBefore;
        const compatNextCursor = direction === 'after' ? nextCursor : prevCursor;

        return res.json(
          successResponse(
            {
              data: mapped,
              meta: {
                hasMore: compatHasMore,
                nextCursor: compatNextCursor,
                hasMoreBefore,
                prevCursor,
                hasMoreAfter,
                anchorMessageId,
              },
            },
            'Сообщения обращения'
          )
        );
      } catch (error) {
        console.error('Ошибка получения сообщений обращения:', error);
        return res
          .status(500)
          .json(errorResponse('Ошибка получения сообщений обращения', ErrorCodes.INTERNAL_ERROR));
      }
    }
  );

/**
 * @openapi
 * /appeals/{id}/assign:
 *   put:
 *     tags: [Appeals]
 *     summary: Назначить исполнителей обращению
 *     security: [ { bearerAuth: [] } ]
 *     x-permissions: ["assign_appeal"]
 */
router.put(
  '/:id/assign',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['assign_appeal']),
  async (
    req: AuthRequest<{ id: string }, AppealAssignResponse, unknown>,
    res: express.Response
  ) => {
    try {
      const p = IdParamSchema.safeParse(req.params);
      if (!p.success) {
        return res
          .status(400)
          .json(errorResponse(zodErrorMessage(p.error), ErrorCodes.VALIDATION_ERROR));
      }
      const b = AssignBodySchema.safeParse(req.body);
      if (!b.success) {
        return res
          .status(400)
          .json(errorResponse(zodErrorMessage(b.error), ErrorCodes.VALIDATION_ERROR));
      }
      const { id: appealId } = p.data;
      const { assigneeIds } = b.data as { assigneeIds: number[] };

      const appeal = await prisma.appeal.findUnique({
        where: { id: appealId },
        include: {
          assignees: { select: { userId: true } },
          watchers: { select: { userId: true } },
        },
      });
      if (!appeal) {
        return res
          .status(404)
          .json(errorResponse('Обращение не найдено', ErrorCodes.NOT_FOUND));
      }

      const actor = await loadUserMini(req.user!.userId);
      if (!actor) {
        return res
          .status(404)
          .json(errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND));
      }

      const canAssign = isAdminRole(actor) || isDepartmentManager(actor, appeal.toDepartmentId);
      if (!canAssign) {
        return res
          .status(403)
          .json(errorResponse('Нет прав на назначение исполнителей', ErrorCodes.FORBIDDEN));
      }

      const prevAssignees = (appeal.assignees || []).map((a) => a.userId);
      const nextAssignees = Array.from(new Set(assigneeIds || []));
      const prevSet = new Set(prevAssignees);
      const nextSet = new Set(nextAssignees);
      const added = nextAssignees.filter((id) => !prevSet.has(id));
      const removed = prevAssignees.filter((id) => !nextSet.has(id));

      const nextStatus =
        nextAssignees.length > 0
          ? AppealStatus.IN_PROGRESS
          : appeal.status === AppealStatus.IN_PROGRESS
          ? AppealStatus.OPEN
          : appeal.status;

      await prisma.$transaction(async (tx) => {
        await tx.appealAssignee.deleteMany({ where: { appealId } });
        if (nextAssignees.length) {
          await tx.appealAssignee.createMany({
            data: nextAssignees.map((uid) => ({ appealId, userId: uid })),
            skipDuplicates: true,
          });
        }
        if (nextStatus !== appeal.status) {
          await tx.appeal.update({
            where: { id: appealId },
            data: { status: nextStatus },
          });
          await tx.appealStatusHistory.create({
            data: {
              appealId,
              oldStatus: appeal.status,
              newStatus: nextStatus,
              changedById: req.user!.userId,
            },
          });
        }
      });
      await prisma.appeal.update({
        where: { id: appealId },
        data: { updatedAt: new Date() },
      });

      const io = req.app.get('io') as SocketIOServer;
      const watcherIds = (appeal.watchers || []).map((w) => w.userId);
      const affectedUserIds = Array.from(
        new Set([appeal.createdById, ...prevAssignees, ...nextAssignees, ...watcherIds])
      );

      if (added.length || removed.length) {
        const users = await prisma.user.findMany({
          where: { id: { in: Array.from(new Set([...added, ...removed])) } },
          select: userMiniSelect,
        });
        const nameById = new Map(users.map((u) => [u.id, getUserDisplayName(u)]));
        const addedNames = added.map((id) => nameById.get(id)).filter(Boolean).join(', ');
        const removedNames = removed.map((id) => nameById.get(id)).filter(Boolean).join(', ');
        const parts = [];
        if (addedNames) parts.push(`Добавлены: ${addedNames}`);
        if (removedNames) parts.push(`Удалены: ${removedNames}`);
        const text = parts.length ? `Исполнители обновлены. ${parts.join('. ')}.` : 'Исполнители обновлены.';
        await createSystemMessage({
          appealId,
          actorId: req.user!.userId,
          text,
          systemEvent: { type: 'assignees_changed', added, removed },
          io,
          toDepartmentId: appeal.toDepartmentId,
          recipients: affectedUserIds,
        });
      }

      if (nextStatus !== appeal.status) {
        await createSystemMessage({
          appealId,
          actorId: req.user!.userId,
          text: `Статус изменён: ${STATUS_LABELS[appeal.status]} → ${STATUS_LABELS[nextStatus]}.`,
          systemEvent: { type: 'status_changed', from: appeal.status, to: nextStatus },
          io,
          toDepartmentId: appeal.toDepartmentId,
          recipients: affectedUserIds,
        });
        io.to(`appeal:${appealId}`).emit('statusUpdated', { appealId, status: nextStatus });
      }

      for (const uid of added) {
        io.to(`user:${uid}`).emit('appealAssigned', { appealId, userId: uid });
      }
      io.to(`appeal:${appealId}`).emit('assigneesUpdated', {
        appealId,
        assigneeIds: nextAssignees,
      });
      await emitAppealUpdated({
        io,
        appealId,
        toDepartmentId: appeal.toDepartmentId,
        userIds: affectedUserIds,
        assigneeIds: nextAssignees,
      });

      await cacheDel(`appeal:${appealId}`);
      await cacheDelPrefix('appeals:list:');

      return res.json(
        successResponse({ id: appealId, status: nextStatus }, 'Исполнители назначены')
      );
    } catch (error) {
      console.error('Ошибка назначения исполнителей:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка назначения исполнителей', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

/**
 * @openapi
 * /appeals/{id}/claim:
 *   post:
 *     tags: [Appeals]
 *     summary: Взять обращение в работу
 *     security: [ { bearerAuth: [] } ]
 *     x-permissions: ["view_appeal"]
 */
router.post(
  '/:id/claim',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['view_appeal']),
  async (
    req: AuthRequest<{ id: string }, AppealClaimResponse>,
    res: express.Response
  ) => {
    try {
      const p = IdParamSchema.safeParse(req.params);
      if (!p.success) {
        return res
          .status(400)
          .json(errorResponse(zodErrorMessage(p.error), ErrorCodes.VALIDATION_ERROR));
      }

      const { id: appealId } = p.data;
      const appeal = await prisma.appeal.findUnique({
        where: { id: appealId },
        include: {
          assignees: { select: { userId: true } },
          watchers: { select: { userId: true } },
        },
      });
      if (!appeal) {
        return res
          .status(404)
          .json(errorResponse('Обращение не найдено', ErrorCodes.NOT_FOUND));
      }

      const userId = req.user!.userId;
      const employee = await prisma.employeeProfile.findUnique({ where: { userId } });
      if (!employee?.departmentId || employee.departmentId !== appeal.toDepartmentId) {
        return res
          .status(403)
          .json(errorResponse('Нет доступа к этому отделу', ErrorCodes.FORBIDDEN));
      }

      const prevAssignees = (appeal.assignees || []).map((a) => a.userId);
      const alreadyAssigned = prevAssignees.includes(userId);
      const nextAssignees = alreadyAssigned ? prevAssignees : [...prevAssignees, userId];

      const shouldChangeStatus = appeal.status !== AppealStatus.IN_PROGRESS;

      await prisma.$transaction(async (tx) => {
        if (!alreadyAssigned) {
          await tx.appealAssignee.create({
            data: { appealId, userId },
          });
        }
        if (shouldChangeStatus) {
          await tx.appeal.update({
            where: { id: appealId },
            data: { status: AppealStatus.IN_PROGRESS },
          });
          await tx.appealStatusHistory.create({
            data: {
              appealId,
              oldStatus: appeal.status,
              newStatus: AppealStatus.IN_PROGRESS,
              changedById: userId,
            },
          });
        }
      });
      await prisma.appeal.update({
        where: { id: appealId },
        data: { updatedAt: new Date() },
      });

      const io = req.app.get('io') as SocketIOServer;
      const recipients = Array.from(
        new Set([appeal.createdById, ...nextAssignees, ...appeal.watchers.map((w) => w.userId)])
      );

      if (!alreadyAssigned) {
        await createSystemMessage({
          appealId,
          actorId: userId,
          text: `Исполнитель взял обращение в работу: ${getUserDisplayName(await loadUserMini(userId))}.`,
          systemEvent: { type: 'assignees_changed', added: [userId], removed: [] },
          io,
          toDepartmentId: appeal.toDepartmentId,
          recipients,
        });
        io.to(`user:${userId}`).emit('appealAssigned', { appealId, userId });
        io.to(`appeal:${appealId}`).emit('assigneesUpdated', { appealId, assigneeIds: nextAssignees });
      }

      if (shouldChangeStatus) {
        await createSystemMessage({
          appealId,
          actorId: userId,
          text: `Статус изменён: ${STATUS_LABELS[appeal.status]} → ${STATUS_LABELS[AppealStatus.IN_PROGRESS]}.`,
          systemEvent: { type: 'status_changed', from: appeal.status, to: AppealStatus.IN_PROGRESS },
          io,
          toDepartmentId: appeal.toDepartmentId,
          recipients,
        });
        io.to(`appeal:${appealId}`).emit('statusUpdated', {
          appealId,
          status: AppealStatus.IN_PROGRESS,
        });
      }

      await emitAppealUpdated({
        io,
        appealId,
        toDepartmentId: appeal.toDepartmentId,
        userIds: recipients,
        assigneeIds: nextAssignees,
      });

      await cacheDel(`appeal:${appealId}`);
      await cacheDelPrefix('appeals:list:');

      return res.json(
        successResponse(
          { id: appealId, status: AppealStatus.IN_PROGRESS, assigneeIds: nextAssignees },
          'Обращение взято в работу'
        )
      );
    } catch (error) {
      console.error('Ошибка self-assign:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка назначения исполнителя', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

/**
 * @openapi
 * /appeals/{id}/department:
 *   put:
 *     tags: [Appeals]
 *     summary: Перевести обращение в другой отдел
 *     security: [ { bearerAuth: [] } ]
 *     x-permissions: ["assign_appeal"]
 */
router.put(
  '/:id/department',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['assign_appeal']),
  async (
    req: AuthRequest<{ id: string }, AppealDepartmentChangeResponse, unknown>,
    res: express.Response
  ) => {
    try {
      const p = IdParamSchema.safeParse(req.params);
      if (!p.success) {
        return res
          .status(400)
          .json(errorResponse(zodErrorMessage(p.error), ErrorCodes.VALIDATION_ERROR));
      }
      const b = ChangeDepartmentBodySchema.safeParse(req.body);
      if (!b.success) {
        return res
          .status(400)
          .json(errorResponse(zodErrorMessage(b.error), ErrorCodes.VALIDATION_ERROR));
      }

      const { id: appealId } = p.data;
      const { departmentId } = b.data as { departmentId: number };

      const appeal = await prisma.appeal.findUnique({
        where: { id: appealId },
        include: {
          assignees: { select: { userId: true } },
          watchers: { select: { userId: true } },
          toDepartment: true,
        },
      });
      if (!appeal) {
        return res
          .status(404)
          .json(errorResponse('Обращение не найдено', ErrorCodes.NOT_FOUND));
      }

      const actor = await loadUserMini(req.user!.userId);
      if (!actor) {
        return res
          .status(404)
          .json(errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND));
      }

      const canMove = isAdminRole(actor) || isDepartmentManager(actor, appeal.toDepartmentId);
      if (!canMove) {
        return res
          .status(403)
          .json(errorResponse('Нет прав на перевод отдела', ErrorCodes.FORBIDDEN));
      }

      if (appeal.toDepartmentId === departmentId) {
        return res.json(
          successResponse(
            { id: appealId, status: appeal.status, toDepartmentId: appeal.toDepartmentId },
            'Отдел не изменён'
          )
        );
      }

      const targetDept = await prisma.department.findUnique({ where: { id: departmentId } });
      if (!targetDept) {
        return res
          .status(404)
          .json(errorResponse('Отдел не найден', ErrorCodes.NOT_FOUND));
      }

      const prevAssignees = (appeal.assignees || []).map((a) => a.userId);
      const prevStatus = appeal.status;
      const nextStatus = AppealStatus.OPEN;

      await prisma.$transaction(async (tx) => {
        await tx.appealAssignee.deleteMany({ where: { appealId } });
        await tx.appeal.update({
          where: { id: appealId },
          data: { toDepartmentId: departmentId, status: nextStatus },
        });
        if (prevStatus !== nextStatus) {
          await tx.appealStatusHistory.create({
            data: {
              appealId,
              oldStatus: prevStatus,
              newStatus: nextStatus,
              changedById: req.user!.userId,
            },
          });
        }
      });

      const io = req.app.get('io') as SocketIOServer;
      const recipients = Array.from(
        new Set([appeal.createdById, ...prevAssignees, ...appeal.watchers.map((w) => w.userId)])
      );

      const deptChangeMessage = await createSystemMessage({
        appealId,
        actorId: req.user!.userId,
        text: `Отдел изменён: ${appeal.toDepartment?.name ?? `#${appeal.toDepartmentId}`} → ${targetDept.name}.`,
        systemEvent: {
          type: 'department_changed',
          fromDepartmentId: appeal.toDepartmentId,
          toDepartmentId: departmentId,
        },
        io,
        toDepartmentId: departmentId,
        recipients,
      });

      if (deptChangeMessage) {
        io.to(`department:${appeal.toDepartmentId}`).emit('messageAdded', deptChangeMessage);
      }

      if (prevAssignees.length) {
        await createSystemMessage({
          appealId,
          actorId: req.user!.userId,
          text: 'Исполнители сняты из-за смены отдела.',
          systemEvent: { type: 'assignees_changed', added: [], removed: prevAssignees },
          io,
          toDepartmentId: departmentId,
          recipients,
        });
      }

      if (prevStatus !== nextStatus) {
        await createSystemMessage({
          appealId,
          actorId: req.user!.userId,
          text: `Статус изменён: ${STATUS_LABELS[prevStatus]} → ${STATUS_LABELS[nextStatus]}.`,
          systemEvent: { type: 'status_changed', from: prevStatus, to: nextStatus },
          io,
          toDepartmentId: departmentId,
          recipients,
        });
        io.to(`appeal:${appealId}`).emit('statusUpdated', { appealId, status: nextStatus });
      }

      io.to(`appeal:${appealId}`).emit('assigneesUpdated', { appealId, assigneeIds: [] });
      io.to(`appeal:${appealId}`).emit('departmentChanged', {
        appealId,
        fromDepartmentId: appeal.toDepartmentId,
        toDepartmentId: departmentId,
      });
      io.to(`department:${appeal.toDepartmentId}`).emit('departmentChanged', {
        appealId,
        fromDepartmentId: appeal.toDepartmentId,
        toDepartmentId: departmentId,
      });
      io.to(`department:${departmentId}`).emit('departmentChanged', {
        appealId,
        fromDepartmentId: appeal.toDepartmentId,
        toDepartmentId: departmentId,
      });
      await emitAppealUpdated({
        io,
        appealId,
        toDepartmentId: departmentId,
        userIds: recipients,
        assigneeIds: [],
      });

      await cacheDel(`appeal:${appealId}`);
      await cacheDelPrefix('appeals:list:');

      return res.json(
        successResponse(
          { id: appealId, status: nextStatus, toDepartmentId: departmentId },
          'Отдел изменён'
        )
      );
    } catch (error) {
      console.error('Ошибка смены отдела:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка смены отдела', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

/**
 * @openapi
 * /appeals/{id}/status:
 *   put:
 *     tags: [Appeals]
 *     summary: Обновить статус обращения
 *     security: [ { bearerAuth: [] } ]
 *     x-permissions: ["view_appeal"]
 */
router.put(
  '/:id/status',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['view_appeal']),
  async (
    req: AuthRequest<{ id: string }, AppealStatusUpdateResponse, unknown>,
    res: express.Response
  ) => {
    try {
      const p = IdParamSchema.safeParse(req.params);
      if (!p.success) {
        return res
          .status(400)
          .json(errorResponse(zodErrorMessage(p.error), ErrorCodes.VALIDATION_ERROR));
      }
      const b = StatusBodySchema.safeParse(req.body);
      if (!b.success) {
        return res
          .status(400)
          .json(errorResponse(zodErrorMessage(b.error), ErrorCodes.VALIDATION_ERROR));
      }
      const { id: appealId } = p.data;
      const { status } = b.data as { status: AppealStatus };

      const appeal = await prisma.appeal.findUnique({
        where: { id: appealId },
        include: {
          assignees: { select: { userId: true } },
          watchers: { select: { userId: true } },
        },
      });
      if (!appeal) {
        return res
          .status(404)
          .json(errorResponse('Обращение не найдено', ErrorCodes.NOT_FOUND));
      }

      const actor = await loadUserMini(req.user!.userId);
      if (!actor) {
        return res
          .status(404)
          .json(errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND));
      }

      const userId = req.user!.userId;
      const isCreator = appeal.createdById === userId;
      const isAssignee = appeal.assignees.some((a: any) => a.userId === userId);
      const isAdmin = isAdminRole(actor);
      const isManager = isDepartmentManager(actor, appeal.toDepartmentId);
      const employee = await prisma.employeeProfile.findFirst({
        where: { userId, departmentId: appeal.toDepartmentId },
      });

      if (!isCreator && !isAssignee && !employee && !isAdmin) {
        return res
          .status(403)
          .json(errorResponse('Нет доступа к этому обращению', ErrorCodes.FORBIDDEN));
      }

      let allowed = false;
      if (isAdmin || isManager) {
        allowed = true;
      } else if (isCreator) {
        allowed =
          status === AppealStatus.COMPLETED ||
          (appeal.status === AppealStatus.RESOLVED && status === AppealStatus.IN_PROGRESS);
      } else if (isAssignee) {
        allowed = status === AppealStatus.RESOLVED;
      }

      if (!allowed) {
        return res
          .status(403)
          .json(errorResponse('Нет прав на смену статуса', ErrorCodes.FORBIDDEN));
      }

      if (status === appeal.status) {
        return res.json(
          successResponse({ id: appealId, status: appeal.status }, 'Статус не изменён')
        );
      }

      await prisma.appeal.update({
        where: { id: appealId },
        data: { status },
      });

      await prisma.appealStatusHistory.create({
        data: {
          appealId,
          oldStatus: appeal.status,
          newStatus: status,
          changedById: req.user!.userId,
        },
      });

      const io = req.app.get('io') as SocketIOServer;
      const recipients = Array.from(
        new Set([
          appeal.createdById,
          ...appeal.assignees.map((a: any) => a.userId),
          ...appeal.watchers.map((w: any) => w.userId),
        ])
      );

      await createSystemMessage({
        appealId,
        actorId: req.user!.userId,
        text: `Статус изменён: ${STATUS_LABELS[appeal.status]} → ${STATUS_LABELS[status]}.`,
        systemEvent: { type: 'status_changed', from: appeal.status, to: status },
        io,
        toDepartmentId: appeal.toDepartmentId,
        recipients,
      });

      io.to(`appeal:${appealId}`).emit('statusUpdated', { appealId, status });
      await emitAppealUpdated({
        io,
        appealId,
        toDepartmentId: appeal.toDepartmentId,
        userIds: recipients,
      });

      await cacheDel(`appeal:${appealId}`);
      await cacheDelPrefix('appeals:list:');

      return res.json(
        successResponse({ id: appealId, status }, 'Статус обновлён')
      );
    } catch (error) {
      console.error('Ошибка обновления статуса:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка обновления статуса', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

// POST /appeals/:id/messages — добавить сообщение (с файлами в облаке)
/**
 * @openapi
 * /appeals/{id}/messages:
 *   post:
 *     tags: [Appeals]
 *     summary: Добавить сообщение к обращению
 *     description: Можно отправить текст и/или файлы-вложения.
 *     security: [ { bearerAuth: [] } ]
 *     x-permissions: ["add_appeal_message"]
 */
router.post(
  '/:id/messages',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['add_appeal_message']),
  upload.array('attachments'),
  async (
    req: AuthRequest<{ id: string }, AppealAddMessageResponse, unknown>,
    res: express.Response
  ) => {
    // --- ЛОГИРОВАНИЕ ЗАПРОСА / ОТВЕТА ---
    const requestId = randomUUID();
    const startedAt = Date.now();

    const originalJson = res.json.bind(res);
    const originalStatus = res.status.bind(res);
    let responseStatus: number | undefined;

    res.status = (code: number) => {
      responseStatus = code;
      return originalStatus(code);
    };

    res.json = (data: any) => {
      if (responseStatus === undefined) responseStatus = res.statusCode || 200;
      const durationMs = Date.now() - startedAt;
      try {
        console.log('[APPEAL MESSAGE][RESPONSE]', {
          requestId,
          status: responseStatus,
          durationMs,
          data,
        });
      } catch {}
      return originalJson(data);
    };

    try {
      const files = (req.files as Express.Multer.File[]) ?? [];
      console.log('[APPEAL MESSAGE][REQUEST]', {
        requestId,
        method: req.method,
        path: req.originalUrl,
        params: req.params,
        body: req.body,
        userId: req.user?.userId,
        files: files.map((f) => ({
          originalname: f.originalname,
          mimetype: f.mimetype,
          size: f.size,
        })),
      });
    } catch {}
    // --- КОНЕЦ БЛОКА ЛОГИРОВАНИЯ ---

    try {
      // 1) Валидация параметров
      const p = IdParamSchema.safeParse(req.params);
      if (!p.success) {
        return res
          .status(400)
          .json(errorResponse(zodErrorMessage(p.error), ErrorCodes.VALIDATION_ERROR));
      }

      const b = AddMessageBodySchema.safeParse(req.body);
      if (!b.success) {
        return res
          .status(400)
          .json(errorResponse(zodErrorMessage(b.error), ErrorCodes.VALIDATION_ERROR));
      }

      const { id: appealId } = p.data;
      const { text } = b.data as { text?: string };

      // 2) Проверяем, что обращение существует
      const appeal = await prisma.appeal.findUnique({
        where: { id: appealId },
        include: {
          assignees: { select: { userId: true } },
          watchers: { select: { userId: true } },
        },
      });
      if (!appeal) {
        return res
          .status(404)
          .json(errorResponse('Обращение не найдено', ErrorCodes.NOT_FOUND));
      }

      // 3) Проверяем, что есть либо текст, либо файлы
      const files = (req.files as Express.Multer.File[]) ?? [];
      if (!text && files.length === 0) {
        return res
          .status(400)
          .json(errorResponse('Нужно отправить текст или вложения', ErrorCodes.VALIDATION_ERROR));
      }

      // 4) Создаём сообщение
      const message = await prisma.appealMessage.create({
        data: {
          appealId,
          senderId: req.user!.userId,
          text: text ?? null,
        },
      });

      // 5) Загружаем вложения в MinIO
      for (const file of files) {
        try {
          const { key, fileName } = await uploadMulterFile(file, false);
          await prisma.appealAttachment.create({
            data: {
              messageId: message.id,
              fileUrl: key,
              fileName,
              fileType: detectAttachmentType(file.mimetype),
            },
          });
        } catch (err) {
          console.error('[APPEAL MESSAGE] Не удалось сохранить вложение:', {
            requestId,
            file: {
              originalname: file.originalname,
              mimetype: file.mimetype,
              size: file.size,
            },
            error: err,
          });
        }
      }

      const fullMessage = await prisma.appealMessage.findUnique({
        where: { id: message.id },
        include: {
          attachments: true,
          reads: { select: { userId: true, readAt: true } },
          sender: {
            select: userMiniSelect,
          },
        },
      });

      const mappedMessage = fullMessage
        ? await mapMessageWithReads(fullMessage as MessageWithRelations, req.user!.userId)
        : {
            id: message.id,
            appealId,
            senderId: req.user!.userId,
            text: message.text,
            type: AppealMessageType.USER,
            systemEvent: null,
            createdAt: message.createdAt,
            attachments: [],
            readBy: [],
            isRead: true,
          };
      const mappedMessageWithAppeal: any = {
        ...mappedMessage,
        appealNumber: appeal.number,
      };

      // 6) Инвалидация кэша обращения + обновляем версию
      await cacheDel(`appeal:${appealId}`);
      await cacheDelPrefix('appeals:list:');
      await prisma.appeal.update({
        where: { id: appealId },
        data: { updatedAt: new Date() },
      });

      const recipients = new Set<number>();
      // отправителя тоже уведомляем, чтобы список у него обновился без ручного рефреша
      recipients.add(req.user!.userId);
      if (appeal.createdById !== req.user!.userId) {
        recipients.add(appeal.createdById);
      }
      const assignees = (appeal as any).assignees as { userId: number }[] | undefined;
      assignees?.forEach((a) => {
        if (a.userId !== req.user!.userId) recipients.add(a.userId);
      });
      const watchers = (appeal as any).watchers as { userId: number }[] | undefined;
      watchers?.forEach((w) => {
        if (w.userId !== req.user!.userId) recipients.add(w.userId);
      });

      // 7) Уведомляем всех подписчиков по WebSocket
      const io = req.app.get('io') as unknown as SocketIOServer;
      io.to(`appeal:${appealId}`).emit('messageAdded', mappedMessageWithAppeal);
      // Уведомляем участников персонально (чтобы список обращений получил событие)
      if (recipients.size) {
        for (const uid of recipients) {
          io.to(`user:${uid}`).emit('messageAdded', mappedMessageWithAppeal);
        }
      }
      // Уведомляем отдел-получатель (для вкладки "Задачи отдела")
        if (appeal.toDepartmentId) {
          io.to(`department:${appeal.toDepartmentId}`).emit('messageAdded', mappedMessageWithAppeal);
        }

        await emitAppealUpdated({
          io,
          appealId,
          toDepartmentId: appeal.toDepartmentId,
          userIds: Array.from(recipients),
          lastMessage: mappedMessageWithAppeal,
        });

        // 7.1) Отправляем пуши адресатам (без отправителя)
        const viewerUserIds = new Set<number>();
        try {
          const roomApi = (io as any).in?.(`appeal:${appealId}`);
          const sockets: any[] = roomApi?.fetchSockets ? await roomApi.fetchSockets() : [];
          sockets.forEach((s) => {
            const uid = Number(s?.data?.user?.userId);
            if (Number.isFinite(uid) && uid > 0) viewerUserIds.add(uid);
          });
        } catch (err: any) {
          console.warn('[push] failed to inspect appeal room sockets', err?.message || err);
        }

        const senderName = mappedMessageWithAppeal.sender
          ? [
              mappedMessageWithAppeal.sender.firstName,
              mappedMessageWithAppeal.sender.lastName,
            ]
              .filter(Boolean)
              .join(' ')
              .trim() || mappedMessageWithAppeal.sender.email || 'Пользователь'
          : 'Пользователь';
        const snippet = mappedMessageWithAppeal.text
          ? String(mappedMessageWithAppeal.text).trim().slice(0, 120)
          : '[Вложение]';
        const pushRecipients = Array.from(recipients).filter(
          (uid) => uid !== req.user!.userId && !viewerUserIds.has(uid)
        );
        if (pushRecipients.length) {
          await sendPushToUsers(
            pushRecipients,
            `Обращение #${appeal.number}`,
            `${senderName}: ${snippet}`,
            {
              type: 'APPEAL_MESSAGE',
              appealId,
              appealNumber: appeal.number,
              messageId: mappedMessageWithAppeal.id,
              senderName,
              senderAvatarUrl: mappedMessageWithAppeal.sender?.avatarUrl ?? null,
            }
          );
        }

      // 8) Отправляем ответ
      return res
        .status(201)
        .json(
          successResponse(
            { id: mappedMessage.id, createdAt: mappedMessage.createdAt },
            'Сообщение добавлено'
          )
        );
    } catch (error) {
      console.error('[APPEAL MESSAGE][ERROR]', { requestId, error });
      return res
        .status(500)
        .json(errorResponse('Ошибка добавления сообщения', ErrorCodes.INTERNAL_ERROR));
    }
  }
  );

  /**
   * @openapi
   * /appeals/{id}/messages/read-bulk:
   *   post:
   *     tags: [Appeals]
   *     summary: Пометить несколько сообщений прочитанными
   *     security: [ { bearerAuth: [] } ]
   *     x-permissions: ["view_appeal"]
   */
  router.post(
    '/:id/messages/read-bulk',
    authenticateToken,
    checkUserStatus,
    authorizeServiceAccess('appeals'),
    authorizePermissions(['view_appeal']),
    async (req: AuthRequest<{ id: string }, AppealReadBulkResponse>, res: express.Response) => {
      try {
        const p = IdParamSchema.safeParse(req.params);
        if (!p.success) {
          return res
            .status(400)
            .json(errorResponse(zodErrorMessage(p.error), ErrorCodes.VALIDATION_ERROR));
        }
        const b = ReadBulkBodySchema.safeParse(req.body);
        if (!b.success) {
          return res
            .status(400)
            .json(errorResponse(zodErrorMessage(b.error), ErrorCodes.VALIDATION_ERROR));
        }

        const { id: appealId } = p.data;
        const { messageIds } = b.data as { messageIds: number[] };
        const userId = req.user!.userId;

        const appeal = await prisma.appeal.findUnique({
          where: { id: appealId },
          include: { assignees: { select: { userId: true } } },
        });
        if (!appeal) {
          return res.status(404).json(errorResponse('Обращение не найдено', ErrorCodes.NOT_FOUND));
        }

        const isCreator = appeal.createdById === userId;
        const isAssignee = appeal.assignees.some((a) => a.userId === userId);
        const employee = await prisma.employeeProfile.findFirst({
          where: { userId, departmentId: appeal.toDepartmentId },
        });
        if (!isCreator && !isAssignee && !employee) {
          return res
            .status(403)
            .json(errorResponse('Нет доступа к этому обращению', ErrorCodes.FORBIDDEN));
        }

        const validIds = Array.from(new Set(messageIds)).filter((id) => Number.isFinite(id));
        if (!validIds.length) {
          return res
            .status(400)
            .json(errorResponse('Список messageIds пуст', ErrorCodes.VALIDATION_ERROR));
        }

        const readableMessages = await prisma.appealMessage.findMany({
          where: {
            id: { in: validIds },
            appealId,
            deleted: false,
            senderId: { not: userId },
          },
          select: { id: true, createdAt: true },
        });
        const acceptedIds = readableMessages.map((m) => m.id);
        let finalReadIds: number[] = [];

        if (readableMessages.length) {
          const boundary = readableMessages.reduce((max, cur) => {
            if (cur.createdAt > max.createdAt) return cur;
            if (cur.createdAt.getTime() === max.createdAt.getTime() && cur.id > max.id) return cur;
            return max;
          }, readableMessages[0]);

          const upToBoundary = await prisma.appealMessage.findMany({
            where: {
              appealId,
              deleted: false,
              senderId: { not: userId },
              reads: { none: { userId } },
              OR: [
                { createdAt: { lt: boundary.createdAt } },
                { createdAt: boundary.createdAt, id: { lte: boundary.id } },
              ],
            },
            select: { id: true },
          });
          finalReadIds = Array.from(new Set(upToBoundary.map((m) => m.id)));
        }

        const now = new Date();
        if (finalReadIds.length) {
          await prisma.appealMessageRead.createMany({
            data: finalReadIds.map((messageId) => ({ messageId, userId, readAt: now })),
            skipDuplicates: true,
          });
        }

        await cacheDel(`appeal:${appealId}`);
        await cacheDelPrefix('appeals:list:');

        const io = req.app.get('io') as SocketIOServer;
        if (finalReadIds.length) {
          io.to(`appeal:${appealId}`).emit('messageRead', {
            appealId,
            messageIds: finalReadIds,
            userId,
            readAt: now,
          });
        }

        return res.json(
          successResponse(
            { messageIds: finalReadIds, readAt: now },
            'Сообщения помечены прочитанными'
          )
        );
      } catch (error) {
        console.error('Ошибка bulk read сообщений:', error);
        return res
          .status(500)
          .json(errorResponse('Ошибка bulk read сообщений', ErrorCodes.INTERNAL_ERROR));
      }
    }
  );

  /**
   * @openapi
   * /appeals/{appealId}/messages/{messageId}/read:
   *   post:
 *     tags: [Appeals]
 *     summary: Пометить сообщение обращения прочитанным
 *     security: [ { bearerAuth: [] } ]
 *     x-permissions: ["view_appeal"]
 */
router.post(
  '/:appealId/messages/:messageId/read',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['view_appeal']),
  async (
    req: AuthRequest<{ appealId: string; messageId: string }>,
    res: express.Response
  ) => {
    try {
      const appealId = Number(req.params.appealId);
      const messageId = Number(req.params.messageId);
      if (Number.isNaN(appealId) || Number.isNaN(messageId)) {
        return res
          .status(400)
          .json(errorResponse('Некорректный идентификатор', ErrorCodes.VALIDATION_ERROR));
      }

      const message = await prisma.appealMessage.findFirst({
        where: { id: messageId, appealId, deleted: false },
        include: {
          appeal: {
            select: {
              id: true,
              createdById: true,
              toDepartmentId: true,
              assignees: { select: { userId: true } },
            },
          },
        },
      });

      if (!message) {
        return res.status(404).json(errorResponse('Сообщение не найдено', ErrorCodes.NOT_FOUND));
      }

      const userId = req.user!.userId;
      const appeal = message.appeal;
      const isCreator = appeal.createdById === userId;
      const isAssignee = appeal.assignees.some((a) => a.userId === userId);
      const employee = await prisma.employeeProfile.findFirst({
        where: { userId, departmentId: appeal.toDepartmentId },
      });

      if (!isCreator && !isAssignee && !employee) {
        return res
          .status(403)
          .json(errorResponse('Нет доступа к этому обращению', ErrorCodes.FORBIDDEN));
      }

      let finalReadIds: number[] = [];
      const now = new Date();
      if (message.senderId !== userId) {
        const upToBoundary = await prisma.appealMessage.findMany({
          where: {
            appealId,
            deleted: false,
            senderId: { not: userId },
            reads: { none: { userId } },
            OR: [
              { createdAt: { lt: message.createdAt } },
              { createdAt: message.createdAt, id: { lte: message.id } },
            ],
          },
          select: { id: true },
        });
        finalReadIds = Array.from(new Set(upToBoundary.map((m) => m.id)));
      }

      if (finalReadIds.length) {
        await prisma.appealMessageRead.createMany({
          data: finalReadIds.map((id) => ({ messageId: id, userId, readAt: now })),
          skipDuplicates: true,
        });
      }

      await cacheDel(`appeal:${appealId}`);
      await cacheDelPrefix('appeals:list:');

      const io = req.app.get('io') as SocketIOServer;
      io.to(`appeal:${appealId}`).emit('messageRead', {
        appealId,
        messageId,
        messageIds: finalReadIds,
        userId,
        readAt: now,
      });

      return res.json(
        successResponse(
          { appealId, messageId, messageIds: finalReadIds, readAt: now },
          'Сообщение помечено прочитанным'
        )
      );
    } catch (error) {
      console.error('Ошибка пометки прочитанного сообщения:', error);
      return res
        .status(500)
        .json(
          errorResponse('Ошибка пометки прочитанного сообщения', ErrorCodes.INTERNAL_ERROR)
        );
    }
  }
);


/**
 * @openapi
 * /appeals/{id}/watchers:
 *   put:
 *     tags: [Appeals]
 *     summary: Обновить список наблюдателей обращения
 *     security: [ { bearerAuth: [] } ]
 *     x-permissions: ["manage_appeal_watchers"]
 */
router.put(
  '/:id/watchers',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['manage_appeal_watchers']),
  async (
    req: AuthRequest<{ id: string }, AppealWatchersUpdateResponse, unknown>,
    res: express.Response
  ) => {
    try {
      const p = IdParamSchema.safeParse(req.params);
      if (!p.success) {
        return res
          .status(400)
          .json(errorResponse(zodErrorMessage(p.error), ErrorCodes.VALIDATION_ERROR));
      }
      const b = WatchersBodySchema.safeParse(req.body);
      if (!b.success) {
        return res
          .status(400)
          .json(errorResponse(zodErrorMessage(b.error), ErrorCodes.VALIDATION_ERROR));
      }
      const { id: appealId } = p.data;
      const { watcherIds } = b.data as { watcherIds: number[] };

      const appeal = await prisma.appeal.findUnique({ where: { id: appealId } });
      if (!appeal) {
        return res
          .status(404)
          .json(errorResponse('Обращение не найдено', ErrorCodes.NOT_FOUND));
      }

      await prisma.appealWatcher.deleteMany({ where: { appealId } });
      for (const uid of watcherIds) {
        await prisma.appealWatcher.create({ data: { appealId, userId: uid } });
      }

      const io = req.app.get('io') as SocketIOServer;
      io.to(`appeal:${appealId}`).emit('watchersUpdated', {
        appealId,
        watchers: watcherIds,
      });

      return res.json(
        successResponse({ id: appealId, watchers: watcherIds }, 'Список наблюдателей обновлён')
      );
    } catch (error) {
      console.error('Ошибка обновления наблюдателей:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка обновления наблюдателей', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

/**
 * @openapi
 * /appeals/messages/{messageId}:
 *   put:
 *     tags: [Appeals]
 *     summary: Редактировать сообщение обращения
 *     security: [ { bearerAuth: [] } ]
 *     x-permissions: ["edit_appeal_message"]
 */
router.put(
  '/messages/:messageId',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['edit_appeal_message']),
  async (
    req: AuthRequest<{ messageId: string }, AppealEditMessageResponse, unknown>,
    res: express.Response
  ) => {
    try {
      const p = MessageIdParamSchema.safeParse(req.params);
      if (!p.success) {
        return res
          .status(400)
          .json(errorResponse(zodErrorMessage(p.error), ErrorCodes.VALIDATION_ERROR));
      }
      const b = EditMessageBodySchema.safeParse(req.body);
      if (!b.success) {
        return res
          .status(400)
          .json(errorResponse(zodErrorMessage(b.error), ErrorCodes.VALIDATION_ERROR));
      }
      const { messageId } = p.data;
      const { text } = b.data as { text: string };

      const message = await prisma.appealMessage.findUnique({ where: { id: messageId } });
      if (!message) {
        return res
          .status(404)
          .json(errorResponse('Сообщение не найдено', ErrorCodes.NOT_FOUND));
      }
      if (message.senderId !== req.user!.userId) {
        return res
          .status(403)
          .json(errorResponse('Нельзя редактировать чужое сообщение', ErrorCodes.FORBIDDEN));
      }

      const updated = await prisma.appealMessage.update({
        where: { id: messageId },
        data: { text, editedAt: new Date() },
      });

      const io = req.app.get('io') as SocketIOServer;
      io.to(`appeal:${updated.appealId}`).emit('messageEdited', {
        appealId: updated.appealId,
        messageId: updated.id,
        editedAt: updated.editedAt!,
        text: updated.text,
      });

      return res.json(
        successResponse({ id: updated.id, editedAt: updated.editedAt! }, 'Сообщение изменено')
      );
    } catch (error) {
      console.error('Ошибка редактирования сообщения:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка редактирования сообщения', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

/**
 * @openapi
 * /appeals/messages/{messageId}:
 *   delete:
 *     tags: [Appeals]
 *     summary: Удалить сообщение обращения (soft-delete)
 *     security: [ { bearerAuth: [] } ]
 *     x-permissions: ["delete_appeal_message"]
 */
router.delete(
  '/messages/:messageId',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['delete_appeal_message']),
  async (
    req: AuthRequest<{ messageId: string }, AppealDeleteMessageResponse>,
    res: express.Response
  ) => {
    try {
      const p = MessageIdParamSchema.safeParse(req.params);
      if (!p.success) {
        return res
          .status(400)
          .json(errorResponse(zodErrorMessage(p.error), ErrorCodes.VALIDATION_ERROR));
      }
      const { messageId } = p.data;

      const message = await prisma.appealMessage.findUnique({ where: { id: messageId } });
      if (!message) {
        return res
          .status(404)
          .json(errorResponse('Сообщение не найдено', ErrorCodes.NOT_FOUND));
      }
      if (message.senderId !== req.user!.userId) {
        return res
          .status(403)
          .json(errorResponse('Нельзя удалить чужое сообщение', ErrorCodes.FORBIDDEN));
      }

      await prisma.appealMessage.update({
        where: { id: messageId },
        data: { deleted: true },
      });

      const io = req.app.get('io') as SocketIOServer;
      io.to(`appeal:${message.appealId}`).emit('messageDeleted', {
        appealId: message.appealId,
        messageId,
      });

      return res.json(successResponse({ id: messageId }, 'Сообщение удалено'));
    } catch (error) {
      console.error('Ошибка удаления сообщения:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка удаления сообщения', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

/**
 * @openapi
 * /appeals/export:
 *   get:
 *     tags: [Appeals]
 *     summary: Экспорт обращений в CSV
 *     description: Возвращает CSV-файл согласно фильтрам и области (scope).
 *     security: [ { bearerAuth: [] } ]
 *     x-permissions: ["export_appeals"]
 */
router.get(
  '/export',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['export_appeals']),
  async (req: AuthRequest, res: express.Response) => {
    try {
      const parsed = ExportQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res
          .status(400)
          .json(errorResponse(zodErrorMessage(parsed.error), ErrorCodes.VALIDATION_ERROR));
      }
      const { scope, status, priority, fromDate, toDate } = parsed.data;

      const userId = req.user!.userId;

      let where: any = {};
      switch (scope) {
        case 'my':
          where.createdById = userId;
          break;
        case 'department': {
          const employee = await prisma.employeeProfile.findUnique({ where: { userId } });
          if (!employee?.departmentId) {
            return res
              .status(400)
              .json(errorResponse('У пользователя не указан отдел', ErrorCodes.VALIDATION_ERROR));
          }
          where.toDepartmentId = employee.departmentId;
          break;
        }
        case 'assigned':
          where.assignees = { some: { userId } };
          break;
      }

      if (status) where.status = status;
      if (priority) where.priority = priority;

      if (fromDate || toDate) {
        where.createdAt = {};
        if (fromDate) where.createdAt.gte = new Date(fromDate);
        if (toDate) where.createdAt.lte = new Date(toDate);
      }

      const appeals = await prisma.appeal.findMany({
        where,
        select: {
          id: true,
          number: true,
          status: true,
          priority: true,
          createdAt: true,
          deadline: true,
          title: true,
          toDepartmentId: true,
          fromDepartmentId: true,
          createdById: true,
        },
        orderBy: { createdAt: 'desc' },
      });

      const fields = [
        { label: 'ID', value: 'id' },
        { label: 'Номер', value: 'number' },
        { label: 'Статус', value: 'status' },
        { label: 'Приоритет', value: 'priority' },
        { label: 'Дата создания', value: 'createdAt' },
        { label: 'Дедлайн', value: 'deadline' },
        { label: 'Заголовок', value: 'title' },
        { label: 'Отдел отправителя', value: 'fromDepartmentId' },
        { label: 'Отдел получателя', value: 'toDepartmentId' },
        { label: 'ID создателя', value: 'createdById' },
      ];

      const parser = new Parser({ fields });
      const csv = parser.parse(appeals);

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="appeals_${Date.now()}.csv"`);
      return res.send('\uFEFF' + csv);
    } catch (error) {
      console.error('Ошибка экспорта обращений:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка экспорта обращений', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

export default router;

