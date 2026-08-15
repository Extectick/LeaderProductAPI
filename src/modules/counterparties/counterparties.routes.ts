import express from 'express';
import { ZodError } from 'zod';
import { authenticateToken, authorizePermissions, type AuthRequest } from '../../middleware/auth';
import { checkUserStatus } from '../../middleware/checkUserStatus';
import { authorizeServiceAccess } from '../../middleware/serviceAccess';
import { ErrorCodes, errorResponse, successResponse } from '../../utils/apiResponse';
import { OnecLpAppTimeoutError } from '../onec/onec.lpApp.client';
import { counterpartyCardParamsSchema, counterpartyCardQuerySchema } from './counterparties.schemas';
import { CounterpartiesError, getCounterpartyCard } from './counterparties.service';

const router = express.Router();

router.use(authenticateToken, checkUserStatus, authorizeServiceAccess('client_orders'));

function validationMessage(error: ZodError) {
  const issue = error.issues[0];
  return issue ? `${issue.path.length ? `Поле «${issue.path.join('.')}»: ` : ''}${issue.message}` : 'Проверьте параметры запроса.';
}

router.get(
  '/:guid/card',
  authorizePermissions(['view_client_orders', 'view_counterparty_card'], { mode: 'any' }),
  async (req: AuthRequest, res) => {
    const params = counterpartyCardParamsSchema.safeParse(req.params);
    const query = counterpartyCardQuerySchema.safeParse(req.query);
    if (!params.success || !query.success) {
      const error = !params.success ? params.error : !query.success ? query.error : null;
      if (!error) {
        return res.status(400).json(errorResponse('Проверьте параметры запроса.', ErrorCodes.VALIDATION_ERROR));
      }
      return res.status(400).json(errorResponse(validationMessage(error), ErrorCodes.VALIDATION_ERROR));
    }

    try {
      const result = await getCounterpartyCard({
        counterpartyGuid: params.data.guid,
        organizationGuid: query.data.organizationGuid,
        preset: query.data.preset,
        periodFrom: query.data.periodFrom,
        periodTo: query.data.periodTo,
        forceRefresh: query.data.refresh,
        userId: req.user!.userId,
        roleName: req.user!.role,
        permissionNames: req.user!.permissions ?? [],
      });
      res.setHeader('Cache-Control', 'private, no-store');
      return res.json(successResponse(result, 'Карточка контрагента'));
    } catch (error) {
      if (error instanceof CounterpartiesError) {
        return res.status(error.status).json(errorResponse(error.message, error.code));
      }
      if (error instanceof OnecLpAppTimeoutError) {
        return res.status(504).json(
          errorResponse('Карточка контрагента формируется дольше обычного. Повторите запрос.', ErrorCodes.INTERNAL_ERROR)
        );
      }
      console.error('[counterparties] failed to load counterparty card', {
        counterpartyGuid: params.data.guid,
        userId: req.user?.userId,
        error: error instanceof Error ? error.message : String(error),
      });
      return res.status(502).json(errorResponse('Не удалось получить карточку контрагента из 1С.', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

export default router;
