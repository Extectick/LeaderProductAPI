import '../env';
import prisma, { pool } from '../prisma/client';
import { startKnowledgeWorker } from '../modules/knowledge/knowledge.worker';
import { safeErrorCode } from '../modules/knowledge/knowledge.config';

try {
  const stop = startKnowledgeWorker(); let stopping = false;
  const shutdown = async () => {
    if (stopping) return; stopping = true;
    const forced = setTimeout(() => process.exit(1), 80000); forced.unref();
    try { await stop(); await prisma.$disconnect(); await pool.end(); clearTimeout(forced); process.exit(0); }
    catch { process.exit(1); }
  };
  process.once('SIGTERM', () => void shutdown()); process.once('SIGINT', () => void shutdown());
} catch (error) {
  console.error('[knowledge] worker configuration failed', { code: safeErrorCode(error) });
  process.exitCode = 1; void prisma.$disconnect().finally(() => pool.end());
}
