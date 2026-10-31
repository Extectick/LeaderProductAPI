import prisma from '../../prisma/client';

/** Cancel remote work when another revision/IT/cancellation wins; extend only a still-owned live lease. */
export async function withHelpAssistantLease<T>(jobId: string, token: string, work: (signal: AbortSignal) => Promise<T>, shutdown?: AbortSignal) {
  const controller = new AbortController(); let pending: Promise<void> | null = null;
  const check = () => {
    if (pending) return pending;
    pending = (async () => {
      try {
        const result = await prisma.helpAssistantJob.updateMany({ where: { id: jobId, leaseToken: token, status: 'RUNNING',
          leaseUntil: { gt: new Date() }, ticket: { status: 'OPEN', itRequested: false, members: { none: { role: 'IT' } } } },
          data: { leaseUntil: new Date(Date.now() + 90000) } });
        if (!result.count) controller.abort();
      } catch { controller.abort(); }
    })().finally(() => { pending = null; });
    return pending;
  };
  await check();
  const timer = setInterval(() => { void check(); }, 2000); timer.unref();
  try { return await work(shutdown ? AbortSignal.any([controller.signal, shutdown]) : controller.signal); }
  finally { clearInterval(timer); await pending; }
}
