import express from 'express';

const router = express.Router();

function noUpdate(res: express.Response) {
  res.setHeader('expo-protocol-version', '1');
  res.setHeader('cache-control', 'private, no-cache, no-store');
  return res.status(204).end();
}

router.get('/update', (_req, res) => {
  return noUpdate(res);
});

router.post('/update', (_req, res) => {
  return noUpdate(res);
});

export default router;
