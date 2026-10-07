import { offlineContentHash, reconcileOfflineProjection } from '../src/modules/clientOrders/offlineProjection';

function store() {
  const states = new Map<string, any>();
  const rows = new Map<string, any>();
  const changes: any[] = [];
  let revision = 10000n;
  const key = (scope: string, entity: string) => `${scope}/${entity}`;
  const match = (row: any, where: any) => row.scopeKey === where.scopeKey && row.entity === where.entity
    && (!where.createdAt || row.createdAt < where.createdAt.lt)
    && (!where.revision || row.revision <= where.revision.lte);
  const tx: any = {
    offlineDatasetState: {
      findUnique: jest.fn(async ({ where: { scopeKey_entity: w } }) => states.get(key(w.scopeKey, w.entity)) ?? null),
      upsert: jest.fn(async ({ where: { scopeKey_entity: w }, create, update }) => {
        const id = key(w.scopeKey, w.entity);
        const next = states.has(id) ? { ...states.get(id), ...update } : { epoch: 'stable', ...create };
        states.set(id, next); return next;
      }),
    },
    offlineDatasetRow: {
      findMany: jest.fn(async ({ where }) => [...rows.values()].filter(row => match(row, where))),
      deleteMany: jest.fn(async ({ where }) => {
        for (const [id, row] of rows) if (match(row, where) && where.itemKey.in.includes(row.itemKey)) rows.delete(id);
      }),
    },
    offlineDatasetChange: {
      createMany: jest.fn(async ({ data }) => data.forEach((row: any) => changes.push({ ...row, revision: ++revision, createdAt: new Date('2026-10-07') }))),
      findFirst: jest.fn(async ({ where }) => { const found = changes.filter(row => match(row, where)); return found[found.length - 1] ?? null; }),
      deleteMany: jest.fn(async ({ where }) => {
        for (let i = changes.length - 1; i >= 0; i--) if (match(changes[i], where)) changes.splice(i, 1);
      }),
    },
    $executeRaw: jest.fn(async (_sql, scopeKey, entity, payload) => {
      JSON.parse(payload).forEach((row: any) => rows.set(`${key(scopeKey, entity)}/${row.itemKey}`, { scopeKey, entity, ...row }));
    }),
  };
  let generation = 0;
  const sync = (items: any[], options: any = {}) => reconcileOfflineProjection(tx, {
    scopeKey: 'manager-1', entity: 'selling-prices', schemaVersion: 1, now: new Date('2026-10-07'),
    fingerprint: `${++generation}`, pages: async function* () { yield items.map(item => ({ key: item.guid, item })); }, ...options,
  });
  return { tx, states, rows, changes, sync };
}

it('hashes semantic fields, ignoring export clocks and object key order', () => {
  expect(offlineContentHash({ price: '100', date: '2026-10-01', sourceUpdatedAt: 'a', product: { guid: 'p' } }))
    .toBe(offlineContentHash({ product: { guid: 'p' }, sourceUpdatedAt: 'b', date: '2026-10-01', price: '100' }));
  expect(offlineContentHash({ price: '100' })).not.toBe(offlineContentHash({ price: '101' }));
  expect(offlineContentHash({ startDate: 'a' })).not.toBe(offlineContentHash({ startDate: 'b' }));
});

it('does not emit deltas or rewrite rows on an identical full export with new timestamps', async () => {
  const s = store();
  const first = await s.sync([{ guid: 'p', price: 10, sourceUpdatedAt: 'before' }]);
  s.tx.$executeRaw.mockClear();
  const next = await s.sync([{ guid: 'p', price: 10, sourceUpdatedAt: 'after', updatedAt: 'now' }]);
  expect(next.currentRevision).toBe(first.currentRevision);
  expect(next.epoch).toBe(first.epoch);
  expect(next.lastSourceUpdateAt).toEqual(first.lastSourceUpdateAt);
  expect(s.changes).toHaveLength(0);
  expect(s.tx.$executeRaw).not.toHaveBeenCalled();
});

it('emits only changed prices, preserves unchanged rows, and freezes payload in the journal', async () => {
  const s = store();
  await s.sync([{ guid: 'a', price: 10 }, { guid: 'b', price: 20 }]);
  const next = await s.sync([{ guid: 'a', price: 11 }, { guid: 'b', price: 20 }]);
  expect(next.itemCount).toBe(2);
  expect(s.changes.map(row => [row.itemKey, row.operation, row.payload.price])).toEqual([['a', 'UPSERT', 11]]);
  await s.sync([{ guid: 'a', price: 12 }, { guid: 'b', price: 20 }]);
  expect(s.changes[0].payload.price).toBe(11);
});

it('publishes deletion even when the number of records stays the same', async () => {
  const s = store();
  await s.sync([{ guid: 'a', name: 'old' }]);
  await s.sync([{ guid: 'b', name: 'new' }]);
  expect(s.changes.map(row => [row.itemKey, row.operation])).toEqual([['b', 'UPSERT'], ['a', 'DELETE']]);
  expect([...s.rows.values()].map(row => row.itemKey)).toEqual(['b']);
});

it('removes the complete dataset, including lost manager access, without rotating epoch', async () => {
  const s = store();
  const first = await s.sync([{ guid: 'a' }, { guid: 'b' }]);
  const next = await s.sync([]);
  expect(next.epoch).toBe(first.epoch);
  expect(next.itemCount).toBe(0);
  expect(s.changes.map(row => row.operation)).toEqual(['DELETE', 'DELETE']);
});

it('does not mix different managers or expire their history using another scope revision', async () => {
  const s = store();
  await s.sync([{ guid: 'a', price: 1 }]);
  await s.sync([{ guid: 'a', price: 2 }]);
  await s.sync([{ guid: 'b' }], { scopeKey: 'manager-2' });
  await s.sync([], { scopeKey: 'manager-2' });
  expect([...s.rows.values()].map(row => row.scopeKey)).toEqual(['manager-1']);
  expect(s.states.get('manager-1/selling-prices').minAvailableRevision).toBe(0n);
  expect(s.changes.filter(row => row.scopeKey === 'manager-1')).toHaveLength(1);
});

it('does not query rows when source generations are unchanged', async () => {
  const s = store();
  await s.sync([{ guid: 'a' }], { fingerprint: 'same' });
  s.tx.offlineDatasetRow.findMany.mockClear();
  await s.sync([{ guid: 'a' }], { fingerprint: 'same' });
  expect(s.tx.offlineDatasetRow.findMany).not.toHaveBeenCalled();
});

it('keeps zero stock as an update and absence as a deletion', async () => {
  const s = store();
  await s.sync([{ guid: 'a', available: 5 }], { entity: 'stock' });
  await s.sync([{ guid: 'a', available: 0 }], { entity: 'stock' });
  await s.sync([], { entity: 'stock' });
  expect(s.changes.map(row => [row.operation, row.payload?.available])).toEqual([['UPSERT', 0], ['DELETE', undefined]]);
});
