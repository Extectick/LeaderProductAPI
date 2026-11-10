import express from 'express';
import { z } from 'zod';
import { completeT3Request, HelpT3Error, readT3Request, t3Active } from './help.t3-exchange';

const router = express.Router();
router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!t3Active()) { res.sendStatus(404); return; }
  next();
});
const handle = (complete: boolean) => async (req: express.Request, res: express.Response) => {
  const id = z.string().uuid().safeParse(req.params.id);
  const auth = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '');
  if (!id.success || !auth) { res.sendStatus(404); return; }
  try {
    if (complete) {
      const accepted = await completeT3Request(id.data, auth[1], req.body);
      res.status(accepted ? 202 : 409).json({ accepted });
    } else res.json(await readT3Request(id.data, auth[1]));
  } catch (error) {
    if (error instanceof HelpT3Error) {
      res.status(error.code === 'HELP_T3_INVALID_RESPONSE' || error.code === 'HELP_T3_INVALID_CITATIONS' ? 400 : 404).json({ code: error.code });
    } else res.status(503).json({ code: 'HELP_T3_UNAVAILABLE' });
  }
};
router.get('/:id', handle(false));
router.post('/:id/result', express.json({ limit: '64kb' }), handle(true));
router.use((_req, res) => { res.sendStatus(404); });
router.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // Parser errors can carry original request text; keep them out of global logging.
  res.status(error?.type === 'entity.too.large' ? 413 : 400).json({ code: 'HELP_T3_INVALID_REQUEST' });
});
export default router;
