// src/routes/appeals.ts
import express from 'express';

import multer from 'multer';
import { Parser } from 'json2csv';
import {
  PrismaClient,
  Prisma,
  AppealStatus,
  AppealPriority,
  AttachmentType,
} from '@prisma/client';
import { z } from 'zod';

import {
  authenticateToken,
  authorizePermissions,
  AuthRequest,
} from '../middleware/auth';
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
  AppealWatchersUpdateResponse,
  AppealDeleteMessageResponse,
  AppealEditMessageResponse,
} from '../types/appealTypes';

import { Server as SocketIOServer } from 'socket.io';

// Схемы валидации
import {
  CreateAppealBodySchema,
  CreateAppealBody,
  ListQuerySchema,
  IdParamSchema,
  MessageIdParamSchema,
  AssignBodySchema,
  StatusBodySchema,
  AddMessageBodySchema,
  WatchersBodySchema,
  EditMessageBodySchema,
  ExportQuerySchema,
} from '../validation/appeals.schema';

// === импорт облачного хранилища (MinIO / S3-совместимое) ===
import { uploadMulterFile } from '../storage/minio';
import { cacheGet, cacheSet, cacheDel } from '../utils/cache';

// минимальный интерфейс БД, который есть и у PrismaClient, и у TransactionClient
type HasAppealAttachment = {
  appealAttachment: Prisma.AppealAttachmentDelegate<any>;
};

const router = express.Router();
const prisma = new PrismaClient();

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
        fileUrl: stored.url,           // если бакет приватный — можно хранить stored.key
        fileName: stored.fileName,
        fileType: detectAttachmentType(file.mimetype),
      },
    });
  }
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
            title,
          },
        });

        const message = await tx.appealMessage.create({
          data: {
            appealId: appeal.id,
            senderId: userId,
            text, // первый текст сообщения из формы
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
                user: { select: { id: true, email: true, firstName: true, lastName: true } },
              },
            },
          },
          orderBy: { createdAt: 'desc' },
          skip: offset,
          take: limit,
        }),
      ]);

      const responseData = { data: appeals, meta: { total, limit, offset } };
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

      const cacheKey = `appeal:${appealId}`;
      let appeal = await cacheGet<any>(cacheKey);
      if (!appeal) {
        appeal = await prisma.appeal.findUnique({
          where: { id: appealId },
          include: {
            fromDepartment: true,
            toDepartment: true,
            createdBy: true,
            assignees: { include: { user: true } },
            watchers: { include: { user: true } },
            statusHistory: { orderBy: { changedAt: 'desc' }, include: { changedBy: true } },
            messages: {
              orderBy: { createdAt: 'asc' },
              include: { sender: true, attachments: true },
            },
          },
        });

        if (!appeal) {
          return res.status(404).json(errorResponse('Обращение не найдено', ErrorCodes.NOT_FOUND));
        }

        await cacheSet(cacheKey, appeal, 60);
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

      return res.json(successResponse(appeal, 'Детали обращения'));
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

      const appeal = await prisma.appeal.findUnique({ where: { id: appealId } });
      if (!appeal) {
        return res
          .status(404)
          .json(errorResponse('Обращение не найдено', ErrorCodes.NOT_FOUND));
      }

      await prisma.appealAssignee.deleteMany({ where: { appealId } });
      for (const uid of assigneeIds) {
        await prisma.appealAssignee.create({ data: { appealId, userId: uid } });
      }

      const updatedAppeal = await prisma.appeal.update({
        where: { id: appealId },
        data: { status: AppealStatus.IN_PROGRESS },
      });

      await prisma.appealStatusHistory.create({
        data: {
          appealId,
          oldStatus: appeal.status,
          newStatus: AppealStatus.IN_PROGRESS,
          changedById: req.user!.userId,
        },
      });

      const io = req.app.get('io') as SocketIOServer;
      for (const uid of assigneeIds) {
        io.to(`user:${uid}`).emit('appealAssigned', { appealId, userId: uid });
      }
      io.to(`appeal:${appealId}`).emit('statusUpdated', {
        appealId,
        status: AppealStatus.IN_PROGRESS,
      });

      return res.json(
        successResponse({ id: appealId, status: updatedAppeal.status }, 'Исполнители назначены')
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
 * /appeals/{id}/status:
 *   put:
 *     tags: [Appeals]
 *     summary: Обновить статус обращения
 *     security: [ { bearerAuth: [] } ]
 *     x-permissions: ["update_appeal_status"]
 */
router.put(
  '/:id/status',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['update_appeal_status']),
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

      const appeal = await prisma.appeal.findUnique({ where: { id: appealId } });
      if (!appeal) {
        return res
          .status(404)
          .json(errorResponse('Обращение не найдено', ErrorCodes.NOT_FOUND));
      }

      const updatedAppeal = await prisma.appeal.update({
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
      io.to(`appeal:${appealId}`).emit('statusUpdated', { appealId, status });

      return res.json(
        successResponse({ id: appealId, status: updatedAppeal.status }, 'Статус обновлён')
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
  authorizePermissions(['add_appeal_message']),
  upload.array('attachments'),
  async (
    req: AuthRequest<{ id: string }, AppealAddMessageResponse, unknown>,
    res: express.Response
  ) => {
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
      const appeal = await prisma.appeal.findUnique({ where: { id: appealId } });
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
        const { url, fileName } = await uploadMulterFile(file, false);
        await prisma.appealAttachment.create({
          data: {
            messageId: message.id,
            fileUrl: url,              // при приватном бакете можно хранить key
            fileName: fileName,
            fileType: detectAttachmentType(file.mimetype),
          },
        });
      }

      // 6) Инвалидация кэша обращения
      await cacheDel(`appeal:${appealId}`);

      // 7) Уведомляем всех подписчиков по WebSocket
      const io = req.app.get('io') as SocketIOServer;
      io.to(`appeal:${appealId}`).emit('messageAdded', {
        appealId,
        messageId: message.id,
        senderId: req.user!.userId,
        text: message.text,
        createdAt: message.createdAt,
      });

      // 8) Отправляем ответ
      return res
        .status(201)
        .json(successResponse({ id: message.id, createdAt: message.createdAt }, 'Сообщение добавлено'));
    } catch (error) {
      console.error('Ошибка добавления сообщения:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка добавления сообщения', ErrorCodes.INTERNAL_ERROR));
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
