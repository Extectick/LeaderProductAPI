import express from 'express';
import prisma from '../prisma/client';
import { authenticateToken, authorizePermissions, AuthRequest } from '../middleware/auth';
import { authorizeServiceAccess } from '../middleware/serviceAccess';
import { checkUserStatus } from '../middleware/checkUserStatus';
import { ErrorCodes, errorResponse, successResponse } from '../utils/apiResponse';
import { cacheGet, cacheSet } from '../utils/cache';

const router = express.Router();
const STOCK_BALANCES_CACHE_PREFIX = 'stock-balances:';
const STOCK_BALANCES_META_TTL_SEC = 60;
const STOCK_BALANCES_TREE_TTL_SEC = 30;
const TREE_PAGE_LIMIT_MAX = 200;
const CHILDREN_PAGE_LIMIT_MAX = 200;

type HierarchyMode = 'warehouse-product' | 'product-warehouse';

type TreeQuery = {
  hierarchy?: string;
  offset?: string;
  limit?: string;
  search?: string;
  organizationGuid?: string;
  compact?: string;
};

type ChildrenQuery = {
  hierarchy?: string;
  level?: string;
  nodeGuid?: string;
  rootGuid?: string;
  search?: string;
  organizationGuid?: string;
  offset?: string;
  limit?: string;
};

type LeafRow = {
  id: string;
  product: {
    guid: string;
    name: string;
    code: string | null;
    article: string | null;
    sku: string | null;
    unit: {
      guid: string | null;
      name: string | null;
      symbol: string | null;
    } | null;
  };
  warehouse: {
    guid: string;
    name: string;
    code: string | null;
  };
  organization: {
    guid: string;
    name: string;
    code: string | null;
  } | null;
  series: {
    guid: string | null;
    number: string | null;
    productionDate: string | null;
    expiresAt: string | null;
  } | null;
  quantity: number;
  reserved: number;
  inStock: number;
  shipping: number;
  clientReserved: number;
  managerReserved: number;
  available: number;
  updatedAt: string;
};

type GroupChildNode = {
  id: string;
  type: 'warehouse' | 'product';
  guid: string;
  name: string;
  code: string | null;
  quantity: number;
  reserved: number;
  inStock: number;
  shipping: number;
  clientReserved: number;
  managerReserved: number;
  available: number;
  leafCount?: number;
  leaves: LeafRow[];
};

type GroupNode = {
  id: string;
  type: 'warehouse' | 'product';
  guid: string;
  name: string;
  code: string | null;
  quantity: number;
  reserved: number;
  inStock: number;
  shipping: number;
  clientReserved: number;
  managerReserved: number;
  available: number;
  childCount?: number;
  children: GroupChildNode[];
};

const HIERARCHY_MODES: HierarchyMode[] = ['warehouse-product', 'product-warehouse'];

function parseHierarchy(value: unknown): HierarchyMode {
  return value === 'product-warehouse' ? 'product-warehouse' : 'warehouse-product';
}

function parseNonNegativeInt(value: unknown, fallback: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), 0), max);
}

function parseBooleanFlag(value: unknown) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function decimalToNumber(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value) || 0;
  if (typeof value === 'object' && value && 'toNumber' in value && typeof (value as { toNumber?: () => number }).toNumber === 'function') {
    return (value as { toNumber: () => number }).toNumber();
  }
  return Number(value) || 0;
}

function addTotals(
  target: {
    quantity: number;
    reserved: number;
    inStock: number;
    shipping: number;
    clientReserved: number;
    managerReserved: number;
    available: number;
  },
  leaf: LeafRow
) {
  target.quantity += leaf.quantity;
  target.reserved += leaf.reserved;
  target.inStock += leaf.inStock;
  target.shipping += leaf.shipping;
  target.clientReserved += leaf.clientReserved;
  target.managerReserved += leaf.managerReserved;
  target.available += leaf.available;
}

function buildMetaCacheKey() {
  return `${STOCK_BALANCES_CACHE_PREFIX}meta`;
}

function buildTreeCacheKey(params: {
  hierarchy: HierarchyMode;
  offset: number;
  limit: number;
  search: string;
  organizationGuid: string;
  compact: boolean;
}) {
  return `${STOCK_BALANCES_CACHE_PREFIX}tree:${JSON.stringify(params)}`;
}

function buildChildrenCacheKey(params: {
  hierarchy: HierarchyMode;
  level: 'root' | 'group';
  nodeGuid: string;
  rootGuid: string;
  search: string;
  organizationGuid: string;
  offset: number;
  limit: number;
}) {
  return `${STOCK_BALANCES_CACHE_PREFIX}children:${JSON.stringify(params)}`;
}

function buildBalancesWhere(search: string, organizationGuid: string) {
  return {
    ...(organizationGuid ? { organization: { guid: organizationGuid } } : {}),
    ...(search
      ? {
          OR: [
            { warehouse: { name: { contains: search, mode: 'insensitive' as const } } },
            { warehouse: { code: { contains: search, mode: 'insensitive' as const } } },
            { product: { name: { contains: search, mode: 'insensitive' as const } } },
            { product: { code: { contains: search, mode: 'insensitive' as const } } },
            { product: { article: { contains: search, mode: 'insensitive' as const } } },
            { product: { sku: { contains: search, mode: 'insensitive' as const } } },
            { organization: { name: { contains: search, mode: 'insensitive' as const } } },
            { organization: { code: { contains: search, mode: 'insensitive' as const } } },
            { seriesNumber: { contains: search, mode: 'insensitive' as const } },
            { seriesGuid: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };
}

function getBalanceInclude() {
  return {
    product: {
      select: {
        guid: true,
        name: true,
        code: true,
        article: true,
        sku: true,
        baseUnit: {
          select: {
            guid: true,
            name: true,
            symbol: true,
          },
        },
      },
    },
    warehouse: {
      select: { guid: true, name: true, code: true },
    },
    organization: {
      select: { guid: true, name: true, code: true },
    },
  };
}

function toLeafRow(balance: {
  id: string;
  quantity: unknown;
  reserved: unknown;
  updatedAt: Date;
  seriesGuid?: string | null;
  seriesNumber?: string | null;
  seriesProductionDate?: Date | null;
  seriesExpiresAt?: Date | null;
  product: {
    guid: string;
    name: string;
    code: string | null;
    article: string | null;
    sku: string | null;
    baseUnit?: {
      guid: string | null;
      name: string | null;
      symbol: string | null;
    } | null;
  };
  warehouse: {
    guid: string;
    name: string;
    code: string | null;
  };
  organization?: {
    guid: string;
    name: string;
    code: string | null;
  } | null;
}): LeafRow {
  const quantity = decimalToNumber(balance.quantity);
  const reserved = decimalToNumber(balance.reserved);
  const inStock = decimalToNumber((balance as { inStock?: unknown }).inStock ?? balance.quantity);
  const shipping = decimalToNumber((balance as { shipping?: unknown }).shipping);
  const clientReserved = decimalToNumber((balance as { clientReserved?: unknown }).clientReserved);
  const managerReserved = decimalToNumber((balance as { managerReserved?: unknown }).managerReserved);
  const available = decimalToNumber((balance as { available?: unknown }).available ?? (quantity - reserved));

  return {
    id: balance.id,
    product: {
      guid: balance.product.guid,
      name: balance.product.name,
      code: balance.product.code ?? null,
      article: balance.product.article ?? null,
      sku: balance.product.sku ?? null,
      unit: balance.product.baseUnit
        ? {
            guid: balance.product.baseUnit.guid ?? null,
            name: balance.product.baseUnit.name ?? null,
            symbol: balance.product.baseUnit.symbol ?? null,
          }
        : null,
    },
    warehouse: {
      guid: balance.warehouse.guid,
      name: balance.warehouse.name,
      code: balance.warehouse.code ?? null,
    },
    organization: balance.organization
      ? {
          guid: balance.organization.guid,
          name: balance.organization.name,
          code: balance.organization.code ?? null,
        }
      : null,
    series:
      balance.seriesGuid || balance.seriesNumber || balance.seriesProductionDate || balance.seriesExpiresAt
        ? {
            guid: balance.seriesGuid ?? null,
            number: balance.seriesNumber ?? null,
            productionDate: balance.seriesProductionDate?.toISOString() ?? null,
            expiresAt: balance.seriesExpiresAt?.toISOString() ?? null,
          }
        : null,
    quantity,
    reserved,
    inStock,
    shipping,
    clientReserved,
    managerReserved,
    available,
    updatedAt: balance.updatedAt.toISOString(),
  };
}

router.get(
  '/meta',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('stock_balances'),
  authorizePermissions(['view_stock_balances']),
  async (_req: AuthRequest, res: express.Response) => {
    try {
      const cacheKey = buildMetaCacheKey();
      const cached = await cacheGet<{
        organizations: Array<{ id: string; guid: string; name: string; code: string | null; isActive: boolean }>;
        hierarchies: HierarchyMode[];
        defaultHierarchy: HierarchyMode;
        lastStockSyncedAt: string | null;
      }>(cacheKey);
      if (cached) {
        return res.json(successResponse(cached));
      }

      const [organizations, latestStock] = await Promise.all([
        prisma.organization.findMany({
          orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
          select: {
            id: true,
            guid: true,
            name: true,
            code: true,
            isActive: true,
          },
        }),
        prisma.stockBalance.findFirst({
          orderBy: [{ lastSyncedAt: 'desc' }, { updatedAt: 'desc' }],
          select: { lastSyncedAt: true, updatedAt: true },
        }),
      ]);

      const payload = {
        organizations,
        hierarchies: HIERARCHY_MODES,
        defaultHierarchy: 'warehouse-product' as HierarchyMode,
        lastStockSyncedAt:
          latestStock?.lastSyncedAt?.toISOString() ?? latestStock?.updatedAt?.toISOString() ?? null,
      };

      await cacheSet(cacheKey, payload, STOCK_BALANCES_META_TTL_SEC);
      return res.json(successResponse(payload));
    } catch (error) {
      console.error('stock balances meta error:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка получения метаданных остатков', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

router.get(
  '/tree',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('stock_balances'),
  authorizePermissions(['view_stock_balances']),
  async (req: AuthRequest, res: express.Response) => {
    try {
      const query = req.query as TreeQuery;
      const hierarchy = parseHierarchy(query.hierarchy);
      const offset = parseNonNegativeInt(query.offset, 0, 5000);
      const limit = parseNonNegativeInt(query.limit, 20, TREE_PAGE_LIMIT_MAX);
      const search = String(query.search || '').trim();
      const organizationGuid = String(query.organizationGuid || '').trim();
      const compact = parseBooleanFlag(query.compact);
      const cacheKey = buildTreeCacheKey({ hierarchy, offset, limit, search, organizationGuid, compact });

      const cached = await cacheGet<{
        hierarchy: HierarchyMode;
        offset: number;
        limit: number;
        totalRoots: number;
        totalLeaves: number;
        roots: GroupNode[];
      }>(cacheKey);
      if (cached) {
        return res.json(successResponse(cached));
      }

      const balances = await prisma.stockBalance.findMany({
        where: buildBalancesWhere(search, organizationGuid),
        include: getBalanceInclude(),
        orderBy:
          hierarchy === 'warehouse-product'
            ? [{ warehouse: { name: 'asc' } }, { product: { name: 'asc' } }, { updatedAt: 'desc' }]
            : [{ product: { name: 'asc' } }, { warehouse: { name: 'asc' } }, { updatedAt: 'desc' }],
      });

      const grouped = new Map<string, GroupNode>();

      for (const balance of balances) {
        const leaf = toLeafRow(balance);
        const rootRef =
          hierarchy === 'warehouse-product'
            ? {
                id: balance.warehouse.guid,
                type: 'warehouse' as const,
                name: balance.warehouse.name,
                code: balance.warehouse.code ?? null,
              }
            : {
                id: balance.product.guid,
                type: 'product' as const,
                name: balance.product.name,
                code: balance.product.code ?? null,
              };
        const childRef =
          hierarchy === 'warehouse-product'
            ? {
                id: balance.product.guid,
                type: 'product' as const,
                name: balance.product.name,
                code: balance.product.code ?? null,
              }
            : {
                id: balance.warehouse.guid,
                type: 'warehouse' as const,
                name: balance.warehouse.name,
                code: balance.warehouse.code ?? null,
              };

        let rootNode = grouped.get(rootRef.id);
        if (!rootNode) {
          rootNode = {
            id: `${rootRef.type}:${rootRef.id}`,
            type: rootRef.type,
            guid: rootRef.id,
            name: rootRef.name,
            code: rootRef.code,
            quantity: 0,
            reserved: 0,
            inStock: 0,
            shipping: 0,
            clientReserved: 0,
            managerReserved: 0,
            available: 0,
            childCount: 0,
            children: [],
          };
          grouped.set(rootRef.id, rootNode);
        }

        addTotals(rootNode, leaf);

        let childNode = rootNode.children.find((item) => item.guid === childRef.id);
        if (!childNode) {
          childNode = {
            id: `${rootRef.id}:${childRef.type}:${childRef.id}`,
            type: childRef.type,
            guid: childRef.id,
            name: childRef.name,
            code: childRef.code,
            quantity: 0,
            reserved: 0,
            inStock: 0,
            shipping: 0,
            clientReserved: 0,
            managerReserved: 0,
            available: 0,
            leafCount: 0,
            leaves: [],
          };
          rootNode.children.push(childNode);
          rootNode.childCount = (rootNode.childCount || 0) + 1;
        }

        addTotals(childNode, leaf);
        childNode.leafCount = (childNode.leafCount || 0) + 1;
        if (!compact) {
          childNode.leaves.push(leaf);
        }
      }

      const roots = Array.from(grouped.values());
      const pagedRoots = roots.slice(offset, offset + limit);
      const payload = {
        hierarchy,
        offset,
        limit,
        totalRoots: roots.length,
        totalLeaves: balances.length,
        roots: pagedRoots,
      };

      await cacheSet(cacheKey, payload, STOCK_BALANCES_TREE_TTL_SEC);
      return res.json(successResponse(payload));
    } catch (error) {
      console.error('stock balances tree error:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка получения дерева остатков', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

router.get(
  '/children',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('stock_balances'),
  authorizePermissions(['view_stock_balances']),
  async (req: AuthRequest, res: express.Response) => {
    try {
      const query = req.query as ChildrenQuery;
      const hierarchy = parseHierarchy(query.hierarchy);
      const level = query.level === 'group' ? 'group' : 'root';
      const nodeGuid = String(query.nodeGuid || '').trim();
      const rootGuid = String(query.rootGuid || '').trim();
      const search = String(query.search || '').trim();
      const organizationGuid = String(query.organizationGuid || '').trim();
      const offset = parseNonNegativeInt(query.offset, 0, 5000);
      const limit = parseNonNegativeInt(query.limit, 50, CHILDREN_PAGE_LIMIT_MAX);

      if (!nodeGuid) {
        return res.status(400).json(errorResponse('nodeGuid is required', ErrorCodes.VALIDATION_ERROR));
      }
      if (level === 'group' && !rootGuid) {
        return res
          .status(400)
          .json(errorResponse('rootGuid is required for group level', ErrorCodes.VALIDATION_ERROR));
      }

      const cacheKey = buildChildrenCacheKey({
        hierarchy,
        level,
        nodeGuid,
        rootGuid,
        search,
        organizationGuid,
        offset,
        limit,
      });
      const cached = await cacheGet(cacheKey);
      if (cached) {
        return res.json(successResponse(cached));
      }

      const baseWhere = buildBalancesWhere(search, organizationGuid);

      if (level === 'root') {
        const balances = await prisma.stockBalance.findMany({
          where: {
            ...baseWhere,
            ...(hierarchy === 'warehouse-product'
              ? { warehouse: { guid: nodeGuid } }
              : { product: { guid: nodeGuid } }),
          },
          include: {
            product: { select: { guid: true, name: true, code: true } },
            warehouse: { select: { guid: true, name: true, code: true } },
          },
          orderBy:
            hierarchy === 'warehouse-product'
              ? [{ product: { name: 'asc' } }, { updatedAt: 'desc' }]
              : [{ warehouse: { name: 'asc' } }, { updatedAt: 'desc' }],
        });

        const grouped = new Map<string, GroupChildNode>();
        for (const balance of balances) {
          const quantity = decimalToNumber(balance.quantity);
          const reserved = decimalToNumber(balance.reserved);
          const inStock = decimalToNumber((balance as { inStock?: unknown }).inStock ?? balance.quantity);
          const shipping = decimalToNumber((balance as { shipping?: unknown }).shipping);
          const clientReserved = decimalToNumber((balance as { clientReserved?: unknown }).clientReserved);
          const managerReserved = decimalToNumber((balance as { managerReserved?: unknown }).managerReserved);
          const available = decimalToNumber((balance as { available?: unknown }).available ?? (quantity - reserved));
          const childRef =
            hierarchy === 'warehouse-product'
              ? {
                  id: balance.product.guid,
                  type: 'product' as const,
                  name: balance.product.name,
                  code: balance.product.code ?? null,
                }
              : {
                  id: balance.warehouse.guid,
                  type: 'warehouse' as const,
                  name: balance.warehouse.name,
                  code: balance.warehouse.code ?? null,
                };

          let childNode = grouped.get(childRef.id);
          if (!childNode) {
            childNode = {
              id: `${nodeGuid}:${childRef.type}:${childRef.id}`,
              type: childRef.type,
              guid: childRef.id,
              name: childRef.name,
              code: childRef.code,
              quantity: 0,
              reserved: 0,
              inStock: 0,
              shipping: 0,
              clientReserved: 0,
              managerReserved: 0,
              available: 0,
              leafCount: 0,
              leaves: [],
            };
            grouped.set(childRef.id, childNode);
          }

          childNode.quantity += quantity;
          childNode.reserved += reserved;
          childNode.inStock += inStock;
          childNode.shipping += shipping;
          childNode.clientReserved += clientReserved;
          childNode.managerReserved += managerReserved;
          childNode.available += available;
          childNode.leafCount = (childNode.leafCount || 0) + 1;
        }

        const children = Array.from(grouped.values()).sort((left, right) => left.name.localeCompare(right.name, 'ru'));
        const payload = {
          level,
          rootGuid: nodeGuid,
          offset,
          limit,
          totalChildren: children.length,
          hasMore: offset + limit < children.length,
          children: children.slice(offset, offset + limit),
        };

        await cacheSet(cacheKey, payload, STOCK_BALANCES_TREE_TTL_SEC);
        return res.json(successResponse(payload));
      }

      const groupWhere = {
        ...baseWhere,
        ...(hierarchy === 'warehouse-product'
          ? { warehouse: { guid: rootGuid }, product: { guid: nodeGuid } }
          : { product: { guid: rootGuid }, warehouse: { guid: nodeGuid } }),
      };

      const [totalLeaves, balances] = await Promise.all([
        prisma.stockBalance.count({
          where: groupWhere,
        }),
        prisma.stockBalance.findMany({
          where: groupWhere,
          include: getBalanceInclude(),
          orderBy: [{ updatedAt: 'desc' }],
          skip: offset,
          take: limit,
        }),
      ]);

      const payload = {
        level,
        rootGuid,
        nodeGuid,
        offset,
        limit,
        totalLeaves,
        hasMore: offset + limit < totalLeaves,
        leaves: balances.map(toLeafRow),
      };

      await cacheSet(cacheKey, payload, STOCK_BALANCES_TREE_TTL_SEC);
      return res.json(successResponse(payload));
    } catch (error) {
      console.error('stock balances children error:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка получения дочерних элементов остатков', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

export default router;
