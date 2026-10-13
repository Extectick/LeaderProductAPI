import express from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import prisma from '../prisma/client';
import { authenticateToken, authorizePermissions } from '../middleware/auth';
import { authorizeServiceAccess } from '../middleware/serviceAccess';
import { checkUserStatus } from '../middleware/checkUserStatus';
import { ErrorCodes, errorResponse, successResponse } from '../utils/apiResponse';
import { enrichProductsWithImages } from '../modules/clientOrders/clientOrders.productImages';

export const stockProductsQuery = z.object({
  search: z.string().trim().max(200).default(''),
  warehouseGuid: z.string().uuid().optional(),
  warehouseGuids: z.string().transform(value => value.split(',')).pipe(z.array(z.string().uuid()).min(1).max(100)).optional(),
  organizationGuid: z.string().uuid().optional(),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
type Query = z.infer<typeof stockProductsQuery>;
export function stockScope(query: Query): Prisma.StockBalanceWhereInput {
  return {
    ...(query.warehouseGuids?.length ? { warehouse: { guid: { in: [...new Set(query.warehouseGuids)] } } }
      : query.warehouseGuid ? { warehouse: { guid: query.warehouseGuid } } : {}),
    ...(query.organizationGuid ? { organization: { guid: query.organizationGuid } } : {}),
  };
}
export function stockMetrics(row: { quantity: unknown; reserved?: unknown; inStock?: unknown; available?: unknown;
  shipping?: unknown; clientReserved?: unknown; managerReserved?: unknown }) {
  const quantity = Number(row.quantity ?? 0);
  const reserved = Number(row.reserved ?? 0);
  return { quantity, reserved, inStock: Number(row.inStock ?? quantity),
    available: Number(row.available ?? quantity - reserved), shipping: Number(row.shipping ?? 0),
    clientReserved: Number(row.clientReserved ?? 0), managerReserved: Number(row.managerReserved ?? 0) };
}

export async function listStockProducts(query: Query) {
  const scope = stockScope(query);
  const products = await prisma.product.findMany({
    where: { stocks: { some: scope }, AND: query.search.split(/\s+/).filter(Boolean).map(term => ({
      OR: ['name', 'code', 'article', 'sku'].map(field => ({ [field]: { contains: term, mode: 'insensitive' } })),
    })) },
    select: { id: true, guid: true, name: true, code: true, article: true,
      baseUnit: { select: { name: true, symbol: true } } },
    orderBy: [{ name: 'asc' }, { id: 'asc' }], skip: query.offset, take: query.limit + 1,
  });
  const page = products.slice(0, query.limit);
  // Aggregate in PostgreSQL, only for this page. Never load all series into Node.
  const totals = page.length ? await prisma.$queryRaw<Array<{ productId: string; updatedAt: Date | null } & ReturnType<typeof stockMetrics>>>(Prisma.sql`
    SELECT s."productId", SUM(s.quantity) AS quantity, SUM(COALESCE(s.reserved, 0)) AS reserved,
      SUM(COALESCE(s."inStock", s.quantity)) AS "inStock",
      SUM(COALESCE(s.available, s.quantity - COALESCE(s.reserved, 0))) AS available,
      SUM(COALESCE(s.shipping, 0)) AS shipping,
      SUM(COALESCE(s."clientReserved", 0)) AS "clientReserved",
      SUM(COALESCE(s."managerReserved", 0)) AS "managerReserved",
      MAX(COALESCE(s."lastSyncedAt", s."updatedAt")) AS "updatedAt"
    FROM "StockBalance" s
    JOIN "Warehouse" w ON w.id = s."warehouseId"
    LEFT JOIN "Organization" o ON o.id = s."organizationId"
    WHERE s."productId" IN (${Prisma.join(page.map(p => p.id))})
    ${query.warehouseGuids?.length ? Prisma.sql`AND w.guid IN (${Prisma.join([...new Set(query.warehouseGuids)])})`
      : query.warehouseGuid ? Prisma.sql`AND w.guid = ${query.warehouseGuid}` : Prisma.empty}
    ${query.organizationGuid ? Prisma.sql`AND o.guid = ${query.organizationGuid}` : Prisma.empty}
    GROUP BY s."productId"
  `) : [];
  const byId = new Map(totals.map(row => [row.productId, row]));
  const items = page.map(({ id, ...product }) => {
    const total = byId.get(id);
    return { ...product, ...stockMetrics(total ?? { quantity: 0 }), updatedAt: total?.updatedAt ?? null };
  });
  return { items: await enrichProductsWithImages(items, { lazySyncMissing: false }),
    offset: query.offset, nextOffset: query.offset + page.length, hasMore: products.length > query.limit };
}

const router = express.Router();
const access = [authenticateToken, checkUserStatus, authorizeServiceAccess('stock_balances'), authorizePermissions(['view_stock_balances'])];
router.get('/filters', ...access, async (_req, res) => {
  try {
    const [warehouses, organizations] = await Promise.all([
      prisma.warehouse.findMany({ where: { stocks: { some: {} } }, select: { guid: true, name: true }, orderBy: { name: 'asc' } }),
      prisma.organization.findMany({ where: { stocks: { some: {} } }, select: { guid: true, name: true }, orderBy: { name: 'asc' } }),
    ]);
    res.json(successResponse({ warehouses, organizations }));
  } catch { res.status(500).json(errorResponse('Не удалось загрузить фильтры остатков', ErrorCodes.INTERNAL_ERROR)); }
});
router.get('/products', ...access, async (req, res) => {
  const parsed = stockProductsQuery.safeParse(req.query);
  if (!parsed.success) { res.status(400).json(errorResponse('Некорректные параметры поиска', ErrorCodes.VALIDATION_ERROR)); return; }
  try { res.json(successResponse(await listStockProducts(parsed.data))); }
  catch { res.status(500).json(errorResponse('Не удалось загрузить остатки', ErrorCodes.INTERNAL_ERROR)); }
});
router.get('/products/:guid/balances', ...access, async (req, res) => {
  const guid = (req.params as Record<string, string>).guid;
  const parsed = stockProductsQuery.safeParse(req.query);
  if (!parsed.success || !z.string().uuid().safeParse(guid).success) {
    res.status(400).json(errorResponse('Некорректные параметры остатков', ErrorCodes.VALIDATION_ERROR)); return;
  }
  try {
    const query = parsed.data;
    const rows = await prisma.stockBalance.findMany({
      where: { ...stockScope(query), product: { guid } },
      include: { warehouse: { select: { guid: true, name: true } }, organization: { select: { guid: true, name: true } } },
      orderBy: [{ warehouse: { name: 'asc' } }, { organization: { name: 'asc' } }, { seriesNumber: 'asc' }, { id: 'asc' }],
      skip: query.offset, take: query.limit + 1,
    });
    const items = rows.slice(0, query.limit).map(row => ({ id: row.id, warehouse: row.warehouse,
      organization: row.organization, seriesNumber: row.seriesNumber, expiresAt: row.seriesExpiresAt,
      productionDate: row.seriesProductionDate, updatedAt: row.lastSyncedAt ?? row.updatedAt, ...stockMetrics(row) }));
    res.json(successResponse({ items, offset: query.offset, nextOffset: query.offset + items.length, hasMore: rows.length > query.limit }));
  } catch { res.status(500).json(errorResponse('Не удалось загрузить детализацию остатков', ErrorCodes.INTERNAL_ERROR)); }
});
export default router;
