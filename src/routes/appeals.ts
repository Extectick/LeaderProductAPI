import express from 'express';
import multer from 'multer';
import { Parser } from 'json2csv';
import {
  PrismaClient,
  AppealStatus,
  AppealPriority,
  AttachmentType,
} from '@prisma/client';
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

// Импортируем типы запросов и ответов для обращений
import {
  AppealCreateRequest,
  AppealCreateResponse,
  AppealListResponse,
  AppealDetailResponse,
  AppealAssignRequest,
  AppealAssignResponse,
  AppealStatusUpdateRequest,
  AppealStatusUpdateResponse,
  AppealAddMessageRequest,
  AppealAddMessageResponse,
  AppealWatchersUpdateResponse,
  AppealWatchersUpdateRequest,
  AppealDeleteMessageResponse,
  AppealEditMessageRequest,
  AppealEditMessageResponse,
  AppealExportQuery,
} from '../types/appealTypes';

import { Server as SocketIOServer } from 'socket.io';

const router = express.Router();
const prisma = new PrismaClient();

// Настройка Multer: файлы сохраняются в папку uploads/
const upload = multer({ dest: 'uploads/' });

/**
 * Функция для определения типа вложения на основе MIME-типов.
 */
function detectAttachmentType(mime: string): AttachmentType {
  if (mime.startsWith('image/')) return 'IMAGE';
  if (mime.startsWith('audio/')) return 'AUDIO';
  return 'FILE';
}

/**
 * POST /appeals — создание нового обращения
 */
router.post(
  '/',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['create_appeal']),
  upload.array('attachments'),
  async (
    req: AuthRequest<{}, AppealCreateResponse, AppealCreateRequest>,
    res: express.Response
  ) => {
    try {
      const userId = req.user!.userId;
      const {
        toDepartmentId,
        title,
        text,
        priority,
        deadline,
      } = req.body;

      if (!toDepartmentId) {
        return res.status(400).json(
          errorResponse(
            'Поле toDepartmentId обязательно',
            ErrorCodes.VALIDATION_ERROR
          )
        );
      }
      if (!text || text.trim() === '') {
        return res.status(400).json(
          errorResponse(
            'Поле text обязательно',
            ErrorCodes.VALIDATION_ERROR
          )
        );
      }

      const targetDept = await prisma.department.findUnique({
        where: { id: Number(toDepartmentId) },
      });
      if (!targetDept) {
        return res.status(404).json(
          errorResponse(
            'Отдел-получатель не найден',
            ErrorCodes.NOT_FOUND
          )
        );
      }

      const employee = await prisma.employeeProfile.findUnique({
        where: { userId },
      });

      const lastAppeal = await prisma.appeal.findFirst({
        orderBy: { number: 'desc' },
      });
      const nextNumber = lastAppeal ? lastAppeal.number + 1 : 1;

      const createdAppeal = await prisma.$transaction(async (tx) => {
        const appeal = await tx.appeal.create({
          data: {
            number: nextNumber,
            fromDepartmentId:
              employee?.departmentId ?? null,
            toDepartmentId: Number(toDepartmentId),
            createdById: userId,
            status: AppealStatus.OPEN,
            priority:
              (priority as AppealPriority) ??
              AppealPriority.MEDIUM,
            deadline: deadline
              ? new Date(deadline)
              : null,
            title,
          },
        });

        const message = await tx.appealMessage.create({
          data: {
            appealId: appeal.id,
            senderId: userId,
            text,
          },
        });

        const files =
          (req.files as Express.Multer.File[]) ?? [];
        for (const file of files) {
          await tx.appealAttachment.create({
            data: {
              messageId: message.id,
              fileUrl: file.path,
              fileName: file.originalname,
              fileType: detectAttachmentType(
                file.mimetype
              ),
            },
          });
        }

        return appeal;
      });

      // WebSocket: уведомляем отдел-получатель о новом обращении
      const io = req.app.get('io') as SocketIOServer;
      io.to(`department:${createdAppeal.toDepartmentId}`).emit(
        'appealCreated',
        {
          id: createdAppeal.id,
          number: createdAppeal.number,
          status: createdAppeal.status,
          priority: createdAppeal.priority,
          title: createdAppeal.title,
        }
      );

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
      return res.status(500).json(
        errorResponse(
          'Ошибка создания обращения',
          ErrorCodes.INTERNAL_ERROR
        )
      );
    }
  }
);

/**
 * GET /appeals — получение списка обращений
 */
router.get(
  '/',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['view_appeal']),
  async (
    req: AuthRequest<{}, AppealListResponse>,
    res: express.Response
  ) => {
    try {
      const userId = req.user!.userId;
      const query = req.query as { [key: string]: string | undefined };

      const scope = query.scope ?? 'my';
      const limit = parseInt(query.limit ?? '20', 10);
      const offset = parseInt(query.offset ?? '0', 10);

      let filter: any = {};

      switch (scope) {
        case 'my':
          filter = { createdById: userId };
          break;
        case 'department': {
          const employee = await prisma.employeeProfile.findUnique(
            {
              where: { userId },
            }
          );
          if (!employee?.departmentId) {
            return res.status(400).json(
              errorResponse(
                'У пользователя не указан отдел',
                ErrorCodes.VALIDATION_ERROR
              )
            );
          }
          filter = {
            toDepartmentId: employee.departmentId,
          };
          break;
        }
        case 'assigned':
          filter = {
            assignees: {
              some: { userId },
            },
          };
          break;
        default:
          filter = {
            OR: [
              { createdById: userId },
              {
                assignees: {
                  some: { userId },
                },
              },
            ],
          };
      }

      const [total, appeals] = await prisma.$transaction([
        prisma.appeal.count({ where: filter }),
        prisma.appeal.findMany({
          where: filter,
          include: {
            fromDepartment: true,
            toDepartment: true,
            assignees: {
              include: {
                user: {
                  select: {
                    id: true,
                    email: true,
                    firstName: true,
                    lastName: true,
                  },
                },
              },
            },
          },
          orderBy: { createdAt: 'desc' },
          skip: offset,
          take: limit,
        }),
      ]);

      return res.json(
        successResponse(
          {
            data: appeals,
            meta: {
              total,
              limit,
              offset,
            },
          },
          'Список обращений'
        )
      );
    } catch (error) {
      console.error(
        'Ошибка получения списка обращений:',
        error
      );
      return res.status(500).json(
        errorResponse(
          'Ошибка получения списка обращений',
          ErrorCodes.INTERNAL_ERROR
        )
      );
    }
  }
);

/**
 * GET /appeals/:id — получение подробностей обращения
 */
router.get(
  '/:id',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['view_appeal']),
  async (
    req: AuthRequest<
      { id: string },
      AppealDetailResponse
    >,
    res: express.Response
  ) => {
    try {
      const userId = req.user!.userId;
      const appealId = parseInt(req.params.id, 10);

      const appeal = await prisma.appeal.findUnique({
        where: { id: appealId },
        include: {
          fromDepartment: true,
          toDepartment: true,
          createdBy: true,
          assignees: { include: { user: true } },
          watchers: { include: { user: true } },
          statusHistory: {
            orderBy: { changedAt: 'desc' },
            include: { changedBy: true },
          },
          messages: {
            orderBy: { createdAt: 'asc' },
            include: {
              sender: true,
              attachments: true,
            },
          },
        },
      });

      if (!appeal) {
        return res.status(404).json(
          errorResponse(
            'Обращение не найдено',
            ErrorCodes.NOT_FOUND
          )
        );
      }

      const isCreator = appeal.createdById === userId;
      const isAssignee = appeal.assignees.some(
        (a) => a.userId === userId
      );
      const employee = await prisma.employeeProfile.findFirst({
        where: {
          userId,
          departmentId: appeal.toDepartmentId,
        },
      });

      if (!isCreator && !isAssignee && !employee) {
        return res.status(403).json(
          errorResponse(
            'Нет доступа к этому обращению',
            ErrorCodes.FORBIDDEN
          )
        );
      }

      return res.json(
        successResponse(
          appeal,
          'Детали обращения'
        )
      );
    } catch (error) {
      console.error('Ошибка получения обращения:', error);
      return res.status(500).json(
        errorResponse(
          'Ошибка получения обращения',
          ErrorCodes.INTERNAL_ERROR
        )
      );
    }
  }
);

/**
 * PUT /appeals/:id/assign — назначить исполнителей
 */
router.put(
  '/:id/assign',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['assign_appeal']),
  async (
    req: AuthRequest<
      { id: string },
      AppealAssignResponse,
      AppealAssignRequest
    >,
    res: express.Response
  ) => {
    try {
      const appealId = parseInt(req.params.id, 10);
      const { assigneeIds } = req.body;

      if (
        !assigneeIds ||
        !Array.isArray(assigneeIds) ||
        assigneeIds.length === 0
      ) {
        return res.status(400).json(
          errorResponse(
            'assigneeIds должен быть непустым массивом',
            ErrorCodes.VALIDATION_ERROR
          )
        );
      }

      const appeal = await prisma.appeal.findUnique({
        where: { id: appealId },
      });
      if (!appeal) {
        return res.status(404).json(
          errorResponse(
            'Обращение не найдено',
            ErrorCodes.NOT_FOUND
          )
        );
      }

      await prisma.appealAssignee.deleteMany({
        where: { appealId },
      });
      for (const uid of assigneeIds) {
        await prisma.appealAssignee.create({
          data: {
            appealId,
            userId: uid,
          },
        });
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

      // WebSocket: уведомляем назначенных исполнителей и участников обращения
      const io = req.app.get('io') as SocketIOServer;
      for (const uid of assigneeIds) {
        io.to(`user:${uid}`).emit('appealAssigned', {
          appealId,
          userId: uid,
        });
      }
      io.to(`appeal:${appealId}`).emit('statusUpdated', {
        appealId,
        status: AppealStatus.IN_PROGRESS,
      });

      return res.json(
        successResponse(
          {
            id: appealId,
            status: updatedAppeal.status,
          },
          'Исполнители назначены'
        )
      );
    } catch (error) {
      console.error(
        'Ошибка назначения исполнителей:',
        error
      );
      return res.status(500).json(
        errorResponse(
          'Ошибка назначения исполнителей',
          ErrorCodes.INTERNAL_ERROR
        )
      );
    }
  }
);

/**
 * PUT /appeals/:id/status — сменить статус обращения
 */
router.put(
  '/:id/status',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['update_appeal_status']),
  async (
    req: AuthRequest<
      { id: string },
      AppealStatusUpdateResponse,
      AppealStatusUpdateRequest
    >,
    res: express.Response
  ) => {
    try {
      const appealId = parseInt(req.params.id, 10);
      const { status } = req.body;

      if (
        !status ||
        !Object.values(AppealStatus).includes(status)
      ) {
        return res.status(400).json(
          errorResponse(
            'Неверный статус',
            ErrorCodes.VALIDATION_ERROR
          )
        );
      }

      const appeal = await prisma.appeal.findUnique({
        where: { id: appealId },
      });
      if (!appeal) {
        return res.status(404).json(
          errorResponse(
            'Обращение не найдено',
            ErrorCodes.NOT_FOUND
          )
        );
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

      // WebSocket: уведомляем участников обращения о смене статуса
      const io = req.app.get('io') as SocketIOServer;
      io.to(`appeal:${appealId}`).emit('statusUpdated', {
        appealId,
        status,
      });

      return res.json(
        successResponse(
          {
            id: appealId,
            status: updatedAppeal.status,
          },
          'Статус обновлён'
        )
      );
    } catch (error) {
      console.error(
        'Ошибка обновления статуса:',
        error
      );
      return res.status(500).json(
        errorResponse(
          'Ошибка обновления статуса',
          ErrorCodes.INTERNAL_ERROR
        )
      );
    }
  }
);

/**
 * POST /appeals/:id/messages — добавить сообщение
 */
router.post(
  '/:id/messages',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['add_appeal_message']),
  upload.array('attachments'),
  async (
    req: AuthRequest<
      { id: string },
      AppealAddMessageResponse,
      AppealAddMessageRequest
    >,
    res: express.Response
  ) => {
    try {
      const appealId = parseInt(req.params.id, 10);
      const { text } = req.body;

      const appeal = await prisma.appeal.findUnique({
        where: { id: appealId },
      });
      if (!appeal) {
        return res.status(404).json(
          errorResponse(
            'Обращение не найдено',
            ErrorCodes.NOT_FOUND
          )
        );
      }

      const files =
        (req.files as Express.Multer.File[]) ?? [];

      if (!text && files.length === 0) {
        return res.status(400).json(
          errorResponse(
            'Нужно отправить текст или вложения',
            ErrorCodes.VALIDATION_ERROR
          )
        );
      }

      const message = await prisma.appealMessage.create({
        data: {
          appealId,
          senderId: req.user!.userId,
          text: text ?? null,
        },
      });

      for (const file of files) {
        await prisma.appealAttachment.create({
          data: {
            messageId: message.id,
            fileUrl: file.path,
            fileName: file.originalname,
            fileType: detectAttachmentType(
              file.mimetype
            ),
          },
        });
      }

      // WebSocket: уведомляем всех участников обращения о новом сообщении
      const io = req.app.get('io') as SocketIOServer;
      io.to(`appeal:${appealId}`).emit('messageAdded', {
        appealId,
        messageId: message.id,
        senderId: req.user!.userId,
        text: message.text,
        createdAt: message.createdAt,
      });

      return res.status(201).json(
        successResponse(
          {
            id: message.id,
            createdAt: message.createdAt,
          },
          'Сообщение добавлено'
        )
      );
    } catch (error) {
      console.error(
        'Ошибка добавления сообщения:',
        error
      );
      return res.status(500).json(
        errorResponse(
          'Ошибка добавления сообщения',
          ErrorCodes.INTERNAL_ERROR
        )
      );
    }
  }
);

/**
 * PUT /appeals/:id/watchers — обновить список наблюдателей.
 */
router.put(
  '/:id/watchers',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['manage_appeal_watchers']),
  async (
    req: AuthRequest<
      { id: string },
      AppealWatchersUpdateResponse,
      AppealWatchersUpdateRequest
    >,
    res: express.Response
  ) => {
    try {
      const appealId = parseInt(req.params.id, 10);
      const { watcherIds } = req.body;

      if (
        !watcherIds ||
        !Array.isArray(watcherIds)
      ) {
        return res.status(400).json(
          errorResponse(
            'watcherIds должен быть массивом',
            ErrorCodes.VALIDATION_ERROR
          )
        );
      }

      const appeal = await prisma.appeal.findUnique({
        where: { id: appealId },
      });
      if (!appeal) {
        return res.status(404).json(
          errorResponse(
            'Обращение не найдено',
            ErrorCodes.NOT_FOUND
          )
        );
      }

      // TODO: Проверка прав (автор, руководитель или админ)

      await prisma.appealWatcher.deleteMany({
        where: { appealId },
      });

      for (const uid of watcherIds) {
        await prisma.appealWatcher.create({
          data: {
            appealId,
            userId: uid,
          },
        });
      }

      // WebSocket: уведомляем участников обращения об обновлении списка наблюдателей
      const io = req.app.get('io') as SocketIOServer;
      io.to(`appeal:${appealId}`).emit('watchersUpdated', {
        appealId,
        watchers: watcherIds,
      });

      return res.json(
        successResponse(
          {
            id: appealId,
            watchers: watcherIds,
          },
          'Список наблюдателей обновлён'
        )
      );
    } catch (error) {
      console.error(
        'Ошибка обновления наблюдателей:',
        error
      );
      return res.status(500).json(
        errorResponse(
          'Ошибка обновления наблюдателей',
          ErrorCodes.INTERNAL_ERROR
        )
      );
    }
  }
);

/**
 * PUT /appeals/messages/:messageId — отредактировать сообщение.
 */
router.put(
  '/messages/:messageId',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['edit_appeal_message']),
  async (
    req: AuthRequest<
      { messageId: string },
      AppealEditMessageResponse,
      AppealEditMessageRequest
    >,
    res: express.Response
  ) => {
    try {
      const messageId = parseInt(
        req.params.messageId,
        10
      );
      const { text } = req.body;

      if (!text || text.trim() === '') {
        return res.status(400).json(
          errorResponse(
            'Поле text обязательно',
            ErrorCodes.VALIDATION_ERROR
          )
        );
      }

      const message =
        await prisma.appealMessage.findUnique({
          where: { id: messageId },
        });
      if (!message) {
        return res.status(404).json(
          errorResponse(
            'Сообщение не найдено',
            ErrorCodes.NOT_FOUND
          )
        );
      }

      if (message.senderId !== req.user!.userId) {
        return res.status(403).json(
          errorResponse(
            'Нельзя редактировать чужое сообщение',
            ErrorCodes.FORBIDDEN
          )
        );
      }

      const updated = await prisma.appealMessage.update({
        where: { id: messageId },
        data: {
          text,
          editedAt: new Date(),
        },
      });

      // WebSocket: уведомляем участников обращения об изменении сообщения
      const io = req.app.get('io') as SocketIOServer;
      io.to(`appeal:${updated.appealId}`).emit('messageEdited', {
        appealId: updated.appealId,
        messageId: updated.id,
        editedAt: updated.editedAt,
        text: updated.text,
      });

      return res.json(
        successResponse(
          {
            id: updated.id,
            editedAt: updated.editedAt!,
          },
          'Сообщение изменено'
        )
      );
    } catch (error) {
      console.error(
        'Ошибка редактирования сообщения:',
        error
      );
      return res.status(500).json(
        errorResponse(
          'Ошибка редактирования сообщения',
          ErrorCodes.INTERNAL_ERROR
        )
      );
    }
  }
);

/**
 * DELETE /appeals/messages/:messageId — удалить сообщение.
 */
router.delete(
  '/messages/:messageId',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['delete_appeal_message']),
  async (
    req: AuthRequest<
      { messageId: string },
      AppealDeleteMessageResponse
    >,
    res: express.Response
  ) => {
    try {
      const messageId = parseInt(
        req.params.messageId,
        10
      );
      const message =
        await prisma.appealMessage.findUnique({
          where: { id: messageId },
        });
      if (!message) {
        return res.status(404).json(
          errorResponse(
            'Сообщение не найдено',
            ErrorCodes.NOT_FOUND
          )
        );
      }

      if (message.senderId !== req.user!.userId) {
        return res.status(403).json(
          errorResponse(
            'Нельзя удалить чужое сообщение',
            ErrorCodes.FORBIDDEN
          )
        );
      }

      await prisma.appealMessage.update({
        where: { id: messageId },
        data: { deleted: true },
      });

      // WebSocket: уведомляем участников обращения об удалении сообщения
      const io = req.app.get('io') as SocketIOServer;
      io.to(`appeal:${message.appealId}`).emit('messageDeleted', {
        appealId: message.appealId,
        messageId,
      });

      return res.json(
        successResponse(
          { id: messageId },
          'Сообщение удалено'
        )
      );
    } catch (error) {
      console.error(
        'Ошибка удаления сообщения:',
        error
      );
      return res.status(500).json(
        errorResponse(
          'Ошибка удаления сообщения',
          ErrorCodes.INTERNAL_ERROR
        )
      );
    }
  }
);

/**
 * GET /appeals/export — экспорт обращений в CSV.
 */
router.get(
  '/export',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['export_appeals']),
  async (req: AuthRequest, res: express.Response) => {
    try {
      const userId = req.user!.userId;
      const query = req.query as AppealExportQuery;

      const {
        scope = 'my',
        status,
        priority,
        fromDate,
        toDate,
      } = query;

      let filter: any = {};
      switch (scope) {
        case 'my':
          filter.createdById = userId;
          break;
        case 'department': {
          const employee = await prisma.employeeProfile.findUnique({
            where: { userId },
          });
          if (!employee?.departmentId) {
            return res.status(400).json(
              errorResponse(
                'У пользователя не указан отдел',
                ErrorCodes.VALIDATION_ERROR
              )
            );
          }
          filter.toDepartmentId = employee.departmentId;
          break;
        }
        case 'assigned':
          filter.assignees = {
            some: { userId },
          };
          break;
        default:
          filter.OR = [
            { createdById: userId },
            { assignees: { some: { userId } } },
          ];
      }

      if (status) {
        filter.status = status;
      }
      if (priority) {
        filter.priority = priority;
      }

      if (fromDate || toDate) {
        filter.createdAt = {};
        if (fromDate) {
          filter.createdAt.gte = new Date(fromDate);
        }
        if (toDate) {
          filter.createdAt.lte = new Date(toDate);
        }
      }

      const appeals = await prisma.appeal.findMany({
        where: filter,
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
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="appeals_${Date.now()}.csv"`
      );
      return res.send('\uFEFF' + csv);
    } catch (error) {
      console.error('Ошибка экспорта обращений:', error);
      return res.status(500).json(
        errorResponse(
          'Ошибка экспорта обращений',
          ErrorCodes.INTERNAL_ERROR
        )
      );
    }
  }
);

export default router;
