import { OrderStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import prisma from '../../prisma/client';
import { ErrorCodes } from '../../utils/apiResponse';
import { toApiPhoneString } from '../../utils/phone';
import type {
  IncludeInactiveQuery,
  ListProductsQuery,
  MeContextUpdateBody,
  OrderCreateBody,
  OrdersListQuery,
  ResolvePriceQuery,
} from './marketplace.schemas';

type MarketplaceErrorCode =
  | ErrorCodes.NOT_FOUND
  | ErrorCodes.VALIDATION_ERROR
  | ErrorCodes.INTERNAL_ERROR;

export class MarketplaceError extends Error {
  public readonly status: number;
  public readonly code: MarketplaceErrorCode;

  constructor(status: number, code: MarketplaceErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const decimalToNumber = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  if (typeof value === 'object' && value && 'toNumber' in value) {
    const maybeDecimal = value as { toNumber: () => number };
    return maybeDecimal.toNumber();
  }
  return Number(value);
};

const toDecimal = (value: number) => new Prisma.Decimal(value);
const now = () => new Date();

const isGuidProvided = (value: string | null | undefined): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const ensureActive = <T extends { isActive?: boolean | null }>(
  entity: T | null,
  message: string
): T => {
  if (!entity) {
    throw new MarketplaceError(404, ErrorCodes.NOT_FOUND, message);
  }
  if (entity.isActive === false) {
    throw new MarketplaceError(400, ErrorCodes.VALIDATION_ERROR, `${message} неактивен`);
  }
  return entity;
};

const getClientProfileOrThrow = async (userId: number) => {
  const profile = await prisma.clientProfile.findUnique({
    where: { userId },
    include: {
      user: { select: { phone: true } },
      address: true,
      counterparty: { select: { id: true, guid: true, name: true, isActive: true } },
      activeAgreement: {
        select: {
          id: true,
          guid: true,
          name: true,
          currency: true,
          isActive: true,
          counterpartyId: true,
          contractId: true,
          warehouseId: true,
          priceTypeId: true,
          counterparty: { select: { guid: true, name: true, isActive: true } },
          contract: {
            select: {
              id: true,
              guid: true,
              number: true,
              isActive: true,
              counterpartyId: true,
              counterparty: { select: { guid: true, name: true, isActive: true } },
            },
          },
          warehouse: { select: { guid: true, name: true, isActive: true, isDefault: true, isPickup: true } },
          priceType: { select: { guid: true, name: true, isActive: true } },
        },
      },
      activeContract: {
        select: {
          id: true,
          guid: true,
          number: true,
          isActive: true,
          counterpartyId: true,
          counterparty: { select: { guid: true, name: true, isActive: true } },
        },
      },
      activeWarehouse: {
        select: { id: true, guid: true, name: true, isActive: true, isDefault: true, isPickup: true },
      },
      activePriceType: {
        select: { id: true, guid: true, name: true, isActive: true },
      },
      activeDeliveryAddress: {
        select: {
          id: true,
          guid: true,
          name: true,
          fullAddress: true,
          city: true,
          street: true,
          house: true,
          isDefault: true,
          isActive: true,
          counterpartyId: true,
        },
      },
    },
  });

  if (!profile) {
    throw new MarketplaceError(404, ErrorCodes.NOT_FOUND, 'Клиентский профиль не найден');
  }

  return profile;
};

const toTimestamp = (value: Date | null | undefined): number => {
  if (!value) return Number.NEGATIVE_INFINITY;
  const ts = value.getTime();
  return Number.isNaN(ts) ? Number.NEGATIVE_INFINITY : ts;
};

const isWithinRange = (date: Date, start?: Date | null, end?: Date | null): boolean => {
  const ts = date.getTime();
  const startOk = !start || toTimestamp(start) <= ts;
  const endOk = !end || toTimestamp(end) >= ts;
  return startOk && endOk;
};

const computeMatchLevel = (
  agreementId: string | null,
  counterpartyId: string | null,
  priceTypeId: string | null,
  specialPrice: {
    agreementId: string | null;
    counterpartyId: string | null;
    priceTypeId: string | null;
  }
): 1 | 2 | 3 | 4 => {
  if (agreementId && specialPrice.agreementId === agreementId) return 4;
  if (counterpartyId && specialPrice.counterpartyId === counterpartyId) return 3;
  if (priceTypeId && specialPrice.priceTypeId === priceTypeId) return 2;
  return 1;
};

const matchLevelLabel = (level: 1 | 2 | 3 | 4): 'GLOBAL' | 'PRICE_TYPE' | 'COUNTERPARTY' | 'AGREEMENT' => {
  if (level === 4) return 'AGREEMENT';
  if (level === 3) return 'COUNTERPARTY';
  if (level === 2) return 'PRICE_TYPE';
  return 'GLOBAL';
};

export async function listProducts(query: ListProductsQuery) {
  const includeInactive = query.includeInactive === true;

  let groupId: string | undefined;
  if (query.groupGuid) {
    const group = await prisma.productGroup.findUnique({
      where: { guid: query.groupGuid },
      select: { id: true },
    });
    if (!group) {
      throw new MarketplaceError(404, ErrorCodes.NOT_FOUND, `Группа ${query.groupGuid} не найдена`);
    }
    groupId = group.id;
  }

  const where: any = {
    ...(includeInactive ? {} : { isActive: true }),
    ...(groupId ? { groupId } : {}),
  };

  if (query.search) {
    where.OR = [
      { name: { contains: query.search, mode: 'insensitive' } },
      { code: { contains: query.search, mode: 'insensitive' } },
      { article: { contains: query.search, mode: 'insensitive' } },
      { sku: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [items, total] = await prisma.$transaction([
    prisma.product.findMany({
      where,
      orderBy: [{ name: 'asc' }],
      skip: query.offset,
      take: query.limit,
      select: {
        id: true,
        guid: true,
        name: true,
        code: true,
        article: true,
        sku: true,
        isWeight: true,
        isService: true,
        isActive: true,
        group: {
          select: { guid: true, name: true, code: true, isActive: true },
        },
        baseUnit: {
          select: { guid: true, name: true, code: true, symbol: true },
        },
        packages: {
          orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
          select: {
            guid: true,
            name: true,
            multiplier: true,
            barcode: true,
            isDefault: true,
            sortOrder: true,
            unit: { select: { guid: true, name: true, code: true, symbol: true } },
          },
        },
        stocks: {
          where: { warehouse: { isActive: true } },
          select: {
            quantity: true,
            reserved: true,
          },
        },
      },
    }),
    prisma.product.count({ where }),
  ]);

  const mapped = items.map((item) => {
    const stockTotal = item.stocks.reduce((sum, stock) => sum + (decimalToNumber(stock.quantity) ?? 0), 0);
    const reservedTotal = item.stocks.reduce(
      (sum, stock) => sum + (decimalToNumber(stock.reserved) ?? 0),
      0
    );

    return {
      guid: item.guid,
      name: item.name,
      code: item.code,
      article: item.article,
      sku: item.sku,
      isWeight: item.isWeight,
      isService: item.isService,
      isActive: item.isActive,
      group: item.group,
      baseUnit: item.baseUnit,
      packages: item.packages.map((pack) => ({
        guid: pack.guid,
        name: pack.name,
        multiplier: decimalToNumber(pack.multiplier),
        barcode: pack.barcode,
        isDefault: pack.isDefault,
        sortOrder: pack.sortOrder,
        unit: pack.unit,
      })),
      stock: {
        total: stockTotal,
        reserved: reservedTotal,
        available: stockTotal - reservedTotal,
      },
    };
  });

  return { items: mapped, total };
}

export async function getProductByGuid(guid: string, includeInactiveWarehouses = false) {
  const product = await prisma.product.findUnique({
    where: { guid },
    select: {
      id: true,
      guid: true,
      name: true,
      code: true,
      article: true,
      sku: true,
      isWeight: true,
      isService: true,
      isActive: true,
      group: {
        select: { guid: true, name: true, code: true, isActive: true },
      },
      baseUnit: {
        select: { guid: true, name: true, code: true, symbol: true },
      },
      packages: {
        orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
        select: {
          guid: true,
          name: true,
          multiplier: true,
          barcode: true,
          isDefault: true,
          sortOrder: true,
          unit: { select: { guid: true, name: true, code: true, symbol: true } },
        },
      },
      stocks: {
        where: includeInactiveWarehouses ? undefined : { warehouse: { isActive: true } },
        select: {
          quantity: true,
          reserved: true,
          updatedAt: true,
          warehouse: {
            select: { guid: true, name: true, isActive: true, isDefault: true, isPickup: true },
          },
        },
      },
    },
  });

  if (!product) {
    throw new MarketplaceError(404, ErrorCodes.NOT_FOUND, `Товар ${guid} не найден`);
  }

  const stockTotal = product.stocks.reduce(
    (sum, stock) => sum + (decimalToNumber(stock.quantity) ?? 0),
    0
  );
  const reservedTotal = product.stocks.reduce(
    (sum, stock) => sum + (decimalToNumber(stock.reserved) ?? 0),
    0
  );

  return {
    id: product.id,
    guid: product.guid,
    name: product.name,
    code: product.code,
    article: product.article,
    sku: product.sku,
    isWeight: product.isWeight,
    isService: product.isService,
    isActive: product.isActive,
    group: product.group,
    baseUnit: product.baseUnit,
    packages: product.packages.map((pack) => ({
      guid: pack.guid,
      name: pack.name,
      multiplier: decimalToNumber(pack.multiplier),
      barcode: pack.barcode,
      isDefault: pack.isDefault,
      sortOrder: pack.sortOrder,
      unit: pack.unit,
    })),
    stock: {
      total: stockTotal,
      reserved: reservedTotal,
      available: stockTotal - reservedTotal,
      byWarehouse: product.stocks.map((stock) => {
        const quantity = decimalToNumber(stock.quantity) ?? 0;
        const reserved = decimalToNumber(stock.reserved) ?? 0;
        return {
          warehouse: stock.warehouse,
          quantity,
          reserved,
          available: quantity - reserved,
          updatedAt: stock.updatedAt,
        };
      }),
    },
  };
}

export async function getProductStock(
  productGuid: string,
  warehouseGuid?: string,
  includeInactiveWarehouses = false
) {
  const product = await prisma.product.findUnique({
    where: { guid: productGuid },
    select: { id: true, guid: true, name: true, isActive: true },
  });

  if (!product) {
    throw new MarketplaceError(404, ErrorCodes.NOT_FOUND, `Товар ${productGuid} не найден`);
  }

  let warehouseId: string | undefined;
  if (warehouseGuid) {
    const warehouse = await prisma.warehouse.findUnique({
      where: { guid: warehouseGuid },
      select: { id: true, guid: true, isActive: true },
    });

    if (!warehouse) {
      throw new MarketplaceError(404, ErrorCodes.NOT_FOUND, `Склад ${warehouseGuid} не найден`);
    }
    if (!includeInactiveWarehouses && !warehouse.isActive) {
      throw new MarketplaceError(400, ErrorCodes.VALIDATION_ERROR, `Склад ${warehouseGuid} неактивен`);
    }
    warehouseId = warehouse.id;
  }

  const stocks = await prisma.stockBalance.findMany({
    where: {
      productId: product.id,
      ...(warehouseId ? { warehouseId } : {}),
      ...(includeInactiveWarehouses ? {} : { warehouse: { isActive: true } }),
    },
    orderBy: [{ warehouse: { name: 'asc' } }],
    select: {
      quantity: true,
      reserved: true,
      updatedAt: true,
      warehouse: {
        select: { guid: true, name: true, isActive: true, isDefault: true, isPickup: true },
      },
    },
  });

  const mapped = stocks.map((stock) => {
    const quantity = decimalToNumber(stock.quantity) ?? 0;
    const reserved = decimalToNumber(stock.reserved) ?? 0;
    return {
      warehouse: stock.warehouse,
      quantity,
      reserved,
      available: quantity - reserved,
      updatedAt: stock.updatedAt,
    };
  });

  const total = mapped.reduce((sum, s) => sum + s.quantity, 0);
  const reservedTotal = mapped.reduce((sum, s) => sum + s.reserved, 0);

  return {
    product: { guid: product.guid, name: product.name, isActive: product.isActive },
    totals: {
      quantity: total,
      reserved: reservedTotal,
      available: total - reservedTotal,
    },
    items: mapped,
  };
}

export async function resolveEffectivePrice(query: ResolvePriceQuery) {
  const at = query.at ?? new Date();

  const product = await prisma.product.findUnique({
    where: { guid: query.productGuid },
    select: { id: true, guid: true, name: true, isActive: true },
  });
  if (!product) {
    throw new MarketplaceError(404, ErrorCodes.NOT_FOUND, `Товар ${query.productGuid} не найден`);
  }
  if (!product.isActive) {
    throw new MarketplaceError(400, ErrorCodes.VALIDATION_ERROR, `Товар ${query.productGuid} неактивен`);
  }

  const counterparty = query.counterpartyGuid
    ? await prisma.counterparty.findUnique({
        where: { guid: query.counterpartyGuid },
        select: { id: true, guid: true, name: true, isActive: true },
      })
    : null;
  if (query.counterpartyGuid && !counterparty) {
    throw new MarketplaceError(404, ErrorCodes.NOT_FOUND, `Контрагент ${query.counterpartyGuid} не найден`);
  }
  if (counterparty && !counterparty.isActive) {
    throw new MarketplaceError(400, ErrorCodes.VALIDATION_ERROR, `Контрагент ${query.counterpartyGuid} неактивен`);
  }

  const agreement = query.agreementGuid
    ? await prisma.clientAgreement.findUnique({
        where: { guid: query.agreementGuid },
        select: {
          id: true,
          guid: true,
          name: true,
          isActive: true,
          counterpartyId: true,
          priceTypeId: true,
          counterparty: { select: { guid: true, name: true, isActive: true } },
          priceType: { select: { guid: true, name: true, isActive: true } },
        },
      })
    : null;
  if (query.agreementGuid && !agreement) {
    throw new MarketplaceError(404, ErrorCodes.NOT_FOUND, `Соглашение ${query.agreementGuid} не найдено`);
  }
  if (agreement && !agreement.isActive) {
    throw new MarketplaceError(400, ErrorCodes.VALIDATION_ERROR, `Соглашение ${query.agreementGuid} неактивно`);
  }

  const priceType = query.priceTypeGuid
    ? await prisma.priceType.findUnique({
        where: { guid: query.priceTypeGuid },
        select: { id: true, guid: true, name: true, isActive: true },
      })
    : null;
  if (query.priceTypeGuid && !priceType) {
    throw new MarketplaceError(404, ErrorCodes.NOT_FOUND, `Тип цен ${query.priceTypeGuid} не найден`);
  }
  if (priceType && !priceType.isActive) {
    throw new MarketplaceError(400, ErrorCodes.VALIDATION_ERROR, `Тип цен ${query.priceTypeGuid} неактивен`);
  }

  if (agreement && counterparty && agreement.counterpartyId && agreement.counterpartyId !== counterparty.id) {
    throw new MarketplaceError(
      400,
      ErrorCodes.VALIDATION_ERROR,
      'agreementGuid не принадлежит указанному counterpartyGuid'
    );
  }
  if (agreement && priceType && agreement.priceTypeId && agreement.priceTypeId !== priceType.id) {
    throw new MarketplaceError(
      400,
      ErrorCodes.VALIDATION_ERROR,
      'agreementGuid не принадлежит указанному priceTypeGuid'
    );
  }

  const resolvedCounterpartyId = counterparty?.id ?? agreement?.counterpartyId ?? null;
  const resolvedPriceTypeId = priceType?.id ?? agreement?.priceTypeId ?? null;
  const resolvedAgreementId = agreement?.id ?? null;
  const context = {
    at,
    counterpartyGuid: counterparty?.guid ?? agreement?.counterparty?.guid ?? null,
    agreementGuid: agreement?.guid ?? null,
    priceTypeGuid: priceType?.guid ?? agreement?.priceType?.guid ?? null,
  };

  const candidates = await prisma.specialPrice.findMany({
    where: {
      productId: product.id,
      isActive: true,
    },
    select: {
      guid: true,
      price: true,
      currency: true,
      startDate: true,
      endDate: true,
      minQty: true,
      agreementId: true,
      counterpartyId: true,
      priceTypeId: true,
    },
  });

  const filtered = candidates.filter((candidate) => {
    if (!isWithinRange(at, candidate.startDate, candidate.endDate)) return false;

    if (resolvedAgreementId) {
      if (candidate.agreementId !== resolvedAgreementId) return false;
    } else if (candidate.agreementId) {
      return false;
    }

    if (resolvedCounterpartyId) {
      if (candidate.counterpartyId && candidate.counterpartyId !== resolvedCounterpartyId) return false;
    } else if (candidate.counterpartyId) {
      return false;
    }

    if (resolvedPriceTypeId) {
      if (candidate.priceTypeId && candidate.priceTypeId !== resolvedPriceTypeId) return false;
    } else if (candidate.priceTypeId) {
      return false;
    }

    return true;
  });

  if (filtered.length > 0) {
    const ranked = filtered
      .map((candidate) => {
        const level = computeMatchLevel(resolvedAgreementId, resolvedCounterpartyId, resolvedPriceTypeId, candidate);
        return { candidate, level };
      })
      .sort((a, b) => {
        if (a.level !== b.level) return b.level - a.level;
        return toTimestamp(b.candidate.startDate) - toTimestamp(a.candidate.startDate);
      });

    const best = ranked[0];
    const bestPrice = best.candidate;

    return {
      product: { guid: product.guid, name: product.name },
      context,
      match: {
        source: 'SPECIAL_PRICE',
        level: matchLevelLabel(best.level),
        specialPriceGuid: bestPrice.guid,
        startDate: bestPrice.startDate,
        endDate: bestPrice.endDate,
        minQty: decimalToNumber(bestPrice.minQty),
      },
      price: {
        value: decimalToNumber(bestPrice.price),
        currency: bestPrice.currency ?? null,
      },
    };
  }

  const productPriceCandidates = await prisma.productPrice.findMany({
    where: {
      productId: product.id,
      isActive: true,
      ...(resolvedPriceTypeId
        ? { OR: [{ priceTypeId: resolvedPriceTypeId }, { priceTypeId: null }] }
        : { priceTypeId: null }),
    },
    select: {
      guid: true,
      price: true,
      currency: true,
      startDate: true,
      endDate: true,
      minQty: true,
      priceTypeId: true,
    },
  });

  const productPriceFiltered = productPriceCandidates.filter((candidate) =>
    isWithinRange(at, candidate.startDate, candidate.endDate)
  );

  if (productPriceFiltered.length === 0) {
    throw new MarketplaceError(404, ErrorCodes.NOT_FOUND, 'Подходящая цена не найдена');
  }

  const rankedProductPrices = productPriceFiltered.sort((a, b) => {
    const aLevel = resolvedPriceTypeId && a.priceTypeId === resolvedPriceTypeId ? 2 : 1;
    const bLevel = resolvedPriceTypeId && b.priceTypeId === resolvedPriceTypeId ? 2 : 1;
    if (aLevel !== bLevel) return bLevel - aLevel;
    return toTimestamp(b.startDate) - toTimestamp(a.startDate);
  });

  const bestProductPrice = rankedProductPrices[0];
  const bestLevel = resolvedPriceTypeId && bestProductPrice.priceTypeId === resolvedPriceTypeId ? 2 : 1;

  return {
    product: { guid: product.guid, name: product.name },
    context,
    match: {
      source: 'PRODUCT_PRICE',
      level: matchLevelLabel(bestLevel),
      productPriceGuid: bestProductPrice.guid,
      startDate: bestProductPrice.startDate,
      endDate: bestProductPrice.endDate,
      minQty: decimalToNumber(bestProductPrice.minQty),
    },
    price: {
      value: decimalToNumber(bestProductPrice.price),
      currency: bestProductPrice.currency ?? null,
    },
  };
}

const mapClientContext = (profile: Awaited<ReturnType<typeof getClientProfileOrThrow>>) => {
  const agreement = profile.activeAgreement?.isActive === false ? null : profile.activeAgreement;
  const contract =
    profile.activeContract?.isActive === false ? null : profile.activeContract ?? agreement?.contract ?? null;
  const warehouse =
    profile.activeWarehouse?.isActive === false ? null : profile.activeWarehouse ?? agreement?.warehouse ?? null;
  const priceType =
    profile.activePriceType?.isActive === false ? null : profile.activePriceType ?? agreement?.priceType ?? null;
  const counterparty = profile.counterparty ?? agreement?.counterparty ?? contract?.counterparty ?? null;

  return {
    profile: {
      userId: profile.userId,
      phone: toApiPhoneString(profile.user?.phone),
      address: profile.address
        ? {
            street: profile.address.street,
            city: profile.address.city,
            state: profile.address.state,
            postalCode: profile.address.postalCode,
            country: profile.address.country,
          }
        : null,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    },
    context: {
      counterparty: counterparty
        ? { guid: counterparty.guid, name: counterparty.name, isActive: counterparty.isActive ?? true }
        : null,
      agreement: agreement
        ? {
            guid: agreement.guid,
            name: agreement.name,
            currency: agreement.currency ?? null,
            isActive: agreement.isActive,
            counterpartyGuid: agreement.counterparty?.guid ?? null,
            contractGuid: agreement.contract?.guid ?? null,
            warehouseGuid: agreement.warehouse?.guid ?? null,
            priceTypeGuid: agreement.priceType?.guid ?? null,
          }
        : null,
      contract: contract
        ? { guid: contract.guid, number: contract.number, isActive: contract.isActive }
        : null,
      warehouse: warehouse
        ? {
            guid: warehouse.guid,
            name: warehouse.name,
            isActive: warehouse.isActive,
            isDefault: warehouse.isDefault,
            isPickup: warehouse.isPickup,
          }
        : null,
      priceType: priceType ? { guid: priceType.guid, name: priceType.name, isActive: priceType.isActive } : null,
      deliveryAddress: profile.activeDeliveryAddress
        ? {
            guid: profile.activeDeliveryAddress.guid,
            fullAddress: profile.activeDeliveryAddress.fullAddress,
            isActive: profile.activeDeliveryAddress.isActive,
            isDefault: profile.activeDeliveryAddress.isDefault,
          }
        : null,
    },
  };
};

const loadCounterpartyById = async (id: string) =>
  ensureActive(
    await prisma.counterparty.findUnique({
      where: { id },
      select: { id: true, guid: true, name: true, isActive: true },
    }),
    'Контрагент'
  );

type AgreementRef = {
  id: string;
  guid: string;
  name: string;
  isActive: boolean;
  counterpartyId: string | null;
  contractId: string | null;
  warehouseId: string | null;
  priceTypeId: string | null;
  currency: string | null;
};

type ContractRef = {
  id: string;
  guid: string;
  number: string;
  isActive: boolean;
  counterpartyId: string;
};

type WarehouseRef = {
  id: string;
  guid: string;
  name: string;
  isActive: boolean;
  isDefault?: boolean;
  isPickup?: boolean;
};

type PriceTypeRef = {
  id: string;
  guid: string;
  name: string;
  isActive: boolean;
};

type DeliveryAddressRef = {
  id: string;
  guid: string | null;
  fullAddress: string;
  isActive: boolean;
  counterpartyId: string;
  isDefault?: boolean;
};

export async function getClientContext(userId: number) {
  const profile = await getClientProfileOrThrow(userId);
  return mapClientContext(profile);
}

export async function updateClientContext(userId: number, body: MeContextUpdateBody) {
  const profile = await getClientProfileOrThrow(userId);

  const counterpartyProvided = body.counterpartyGuid !== undefined;
  const agreementProvided = body.activeAgreementGuid !== undefined;
  const contractProvided = body.activeContractGuid !== undefined;
  const warehouseProvided = body.activeWarehouseGuid !== undefined;
  const priceTypeProvided = body.activePriceTypeGuid !== undefined;
  const deliveryAddressProvided = body.activeDeliveryAddressGuid !== undefined;

  let counterparty =
    profile.counterparty && profile.counterparty.isActive !== false ? profile.counterparty : null;

  if (counterpartyProvided) {
    if (body.counterpartyGuid === null) {
      counterparty = null;
    } else if (isGuidProvided(body.counterpartyGuid)) {
      counterparty = ensureActive(
        await prisma.counterparty.findUnique({
          where: { guid: body.counterpartyGuid },
          select: { id: true, guid: true, name: true, isActive: true },
        }),
        'Контрагент'
      );
    }
  }

  let agreement: AgreementRef | null =
    !agreementProvided && profile.activeAgreement?.isActive !== false ? profile.activeAgreement : null;
  if (agreementProvided) {
    if (body.activeAgreementGuid === null) {
      agreement = null;
    } else if (isGuidProvided(body.activeAgreementGuid)) {
      agreement = ensureActive(
        await prisma.clientAgreement.findUnique({
          where: { guid: body.activeAgreementGuid },
          select: {
            id: true,
            guid: true,
            name: true,
            currency: true,
            isActive: true,
            counterpartyId: true,
            contractId: true,
            warehouseId: true,
            priceTypeId: true,
          },
        }),
        'Соглашение'
      );
    }
  }

  let contract: ContractRef | null =
    !contractProvided && profile.activeContract?.isActive !== false ? profile.activeContract : null;
  if (contractProvided) {
    if (body.activeContractGuid === null) {
      contract = null;
    } else if (isGuidProvided(body.activeContractGuid)) {
      contract = ensureActive(
        await prisma.clientContract.findUnique({
          where: { guid: body.activeContractGuid },
          select: { id: true, guid: true, number: true, isActive: true, counterpartyId: true },
        }),
        'Договор'
      );
    }
  }

  let warehouse: WarehouseRef | null =
    !warehouseProvided && profile.activeWarehouse?.isActive !== false ? profile.activeWarehouse : null;
  if (warehouseProvided) {
    if (body.activeWarehouseGuid === null) {
      warehouse = null;
    } else if (isGuidProvided(body.activeWarehouseGuid)) {
      warehouse = ensureActive(
        await prisma.warehouse.findUnique({
          where: { guid: body.activeWarehouseGuid },
          select: { id: true, guid: true, name: true, isActive: true, isDefault: true, isPickup: true },
        }),
        'Склад'
      );
    }
  }

  let priceType: PriceTypeRef | null =
    !priceTypeProvided && profile.activePriceType?.isActive !== false ? profile.activePriceType : null;
  if (priceTypeProvided) {
    if (body.activePriceTypeGuid === null) {
      priceType = null;
    } else if (isGuidProvided(body.activePriceTypeGuid)) {
      priceType = ensureActive(
        await prisma.priceType.findUnique({
          where: { guid: body.activePriceTypeGuid },
          select: { id: true, guid: true, name: true, isActive: true },
        }),
        'Тип цен'
      );
    }
  }

  let deliveryAddress: DeliveryAddressRef | null =
    !deliveryAddressProvided && profile.activeDeliveryAddress?.isActive !== false
      ? profile.activeDeliveryAddress
      : null;
  if (deliveryAddressProvided) {
    if (body.activeDeliveryAddressGuid === null) {
      deliveryAddress = null;
    } else if (isGuidProvided(body.activeDeliveryAddressGuid)) {
      deliveryAddress = ensureActive(
        await prisma.deliveryAddress.findUnique({
          where: { guid: body.activeDeliveryAddressGuid },
          select: { id: true, guid: true, fullAddress: true, isActive: true, counterpartyId: true, isDefault: true },
        }),
        'Адрес доставки'
      );
    }
  }

  const counterpartyChanged =
    counterpartyProvided && profile.counterpartyId !== (counterparty?.id ?? null);
  if (counterpartyChanged) {
    if (!agreementProvided) agreement = null;
    if (!contractProvided) contract = null;
    if (!deliveryAddressProvided) deliveryAddress = null;
  }

  if (agreement?.counterpartyId) {
    if (counterparty && counterparty.id !== agreement.counterpartyId) {
      throw new MarketplaceError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        'Соглашение не принадлежит выбранному контрагенту'
      );
    }
    counterparty = await loadCounterpartyById(agreement.counterpartyId);
  }

  if (contract) {
    if (counterparty && counterparty.id !== contract.counterpartyId) {
      throw new MarketplaceError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        'Договор не принадлежит выбранному контрагенту'
      );
    }
    counterparty = await loadCounterpartyById(contract.counterpartyId);
  }

  if (deliveryAddress?.counterpartyId) {
    if (counterparty && counterparty.id !== deliveryAddress.counterpartyId) {
      throw new MarketplaceError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        'Адрес доставки не принадлежит выбранному контрагенту'
      );
    }
    counterparty = await loadCounterpartyById(deliveryAddress.counterpartyId);
  }

  if (agreement && contract && agreement.contractId && agreement.contractId !== contract.id) {
    throw new MarketplaceError(400, ErrorCodes.VALIDATION_ERROR, 'Договор не соответствует соглашению');
  }
  if (agreement && warehouse && agreement.warehouseId && agreement.warehouseId !== warehouse.id) {
    throw new MarketplaceError(400, ErrorCodes.VALIDATION_ERROR, 'Склад не соответствует соглашению');
  }
  if (agreement && priceType && agreement.priceTypeId && agreement.priceTypeId !== priceType.id) {
    throw new MarketplaceError(400, ErrorCodes.VALIDATION_ERROR, 'Тип цен не соответствует соглашению');
  }

  await prisma.clientProfile.update({
    where: { userId },
    data: {
      counterpartyId: counterparty?.id ?? null,
      activeAgreementId: agreement?.id ?? null,
      activeContractId: contract?.id ?? null,
      activeWarehouseId: warehouse?.id ?? null,
      activePriceTypeId: priceType?.id ?? null,
      activeDeliveryAddressId: deliveryAddress?.id ?? null,
    },
  });

  const refreshed = await getClientProfileOrThrow(userId);
  return mapClientContext(refreshed);
}

export async function listWarehouses(query: IncludeInactiveQuery) {
  const includeInactive = query.includeInactive === true;
  const warehouses = await prisma.warehouse.findMany({
    where: includeInactive ? undefined : { isActive: true },
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    select: {
      guid: true,
      name: true,
      code: true,
      address: true,
      isActive: true,
      isDefault: true,
      isPickup: true,
      updatedAt: true,
    },
  });

  return { items: warehouses, total: warehouses.length };
}

export async function listClientAgreements(userId: number, query: IncludeInactiveQuery) {
  const profile = await getClientProfileOrThrow(userId);
  if (!profile.counterpartyId) {
    throw new MarketplaceError(
      400,
      ErrorCodes.VALIDATION_ERROR,
      'У клиента не выбран контрагент для получения соглашений'
    );
  }

  const includeInactive = query.includeInactive === true;

  const agreements = await prisma.clientAgreement.findMany({
    where: {
      counterpartyId: profile.counterpartyId,
      ...(includeInactive ? {} : { isActive: true }),
    },
    orderBy: [{ name: 'asc' }],
    select: {
      guid: true,
      name: true,
      currency: true,
      isActive: true,
      contract: { select: { guid: true, number: true, isActive: true } },
      warehouse: { select: { guid: true, name: true, isActive: true, isDefault: true, isPickup: true } },
      priceType: { select: { guid: true, name: true, isActive: true } },
      updatedAt: true,
    },
  });

  return { items: agreements, total: agreements.length };
}

export async function getClientCounterparty(userId: number, query: IncludeInactiveQuery) {
  const profile = await getClientProfileOrThrow(userId);
  if (!profile.counterpartyId) {
    throw new MarketplaceError(400, ErrorCodes.VALIDATION_ERROR, 'У клиента не выбран контрагент');
  }

  const includeInactive = query.includeInactive === true;

  const counterparty = await prisma.counterparty.findUnique({
    where: { id: profile.counterpartyId },
    select: {
      guid: true,
      name: true,
      fullName: true,
      inn: true,
      kpp: true,
      phone: true,
      email: true,
      isActive: true,
      addresses: {
        where: includeInactive ? undefined : { isActive: true },
        orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
        select: {
          guid: true,
          name: true,
          fullAddress: true,
          city: true,
          street: true,
          house: true,
          isDefault: true,
          isActive: true,
          updatedAt: true,
        },
      },
      contracts: {
        where: includeInactive ? undefined : { isActive: true },
        orderBy: [{ date: 'desc' }],
        select: {
          guid: true,
          number: true,
          date: true,
          validFrom: true,
          validTo: true,
          isActive: true,
          comment: true,
          updatedAt: true,
        },
      },
      agreements: {
        where: includeInactive ? undefined : { isActive: true },
        orderBy: [{ name: 'asc' }],
        select: {
          guid: true,
          name: true,
          currency: true,
          isActive: true,
          contract: { select: { guid: true, number: true, isActive: true } },
          warehouse: { select: { guid: true, name: true, isActive: true } },
          priceType: { select: { guid: true, name: true, isActive: true } },
          updatedAt: true,
        },
      },
      updatedAt: true,
    },
  });

  if (!counterparty) {
    throw new MarketplaceError(404, ErrorCodes.NOT_FOUND, 'Контрагент не найден');
  }
  if (!includeInactive && counterparty.isActive === false) {
    throw new MarketplaceError(400, ErrorCodes.VALIDATION_ERROR, 'Контрагент неактивен');
  }

  return counterparty;
}

type ResolvedOrderContext = {
  counterparty: { id: string; guid: string; name: string };
  agreement: {
    id: string;
    guid: string;
    name: string;
    currency: string | null;
    contractId: string | null;
    warehouseId: string | null;
    priceTypeId: string | null;
  } | null;
  contract: { id: string; guid: string; number: string } | null;
  warehouse: { id: string; guid: string; name: string } | null;
  priceType: { id: string; guid: string; name: string } | null;
  deliveryAddress: { id: string; guid: string | null; fullAddress: string } | null;
};

const resolveOrderContext = async (userId: number, body: OrderCreateBody): Promise<ResolvedOrderContext> => {
  const profile = await getClientProfileOrThrow(userId);

  const agreementProvided = body.agreementGuid !== undefined;
  const contractProvided = body.contractGuid !== undefined;
  const warehouseProvided = body.warehouseGuid !== undefined;
  const priceTypeProvided = body.priceTypeGuid !== undefined;
  const deliveryAddressProvided = body.deliveryAddressGuid !== undefined;

  let counterparty =
    profile.counterparty && profile.counterparty.isActive !== false ? profile.counterparty : null;

  let agreement: AgreementRef | null =
    !agreementProvided && profile.activeAgreement?.isActive !== false ? profile.activeAgreement : null;
  if (agreementProvided) {
    if (body.agreementGuid === null) {
      agreement = null;
    } else if (isGuidProvided(body.agreementGuid)) {
      agreement = ensureActive(
        await prisma.clientAgreement.findUnique({
          where: { guid: body.agreementGuid },
          select: {
            id: true,
            guid: true,
            name: true,
            currency: true,
            isActive: true,
            counterpartyId: true,
            contractId: true,
            warehouseId: true,
            priceTypeId: true,
          },
        }),
        'Соглашение'
      );
    }
  }

  let contract: ContractRef | null =
    !contractProvided && profile.activeContract?.isActive !== false ? profile.activeContract : null;
  if (contractProvided) {
    if (body.contractGuid === null) {
      contract = null;
    } else if (isGuidProvided(body.contractGuid)) {
      contract = ensureActive(
        await prisma.clientContract.findUnique({
          where: { guid: body.contractGuid },
          select: { id: true, guid: true, number: true, isActive: true, counterpartyId: true },
        }),
        'Договор'
      );
    }
  }

  let warehouse: WarehouseRef | null =
    !warehouseProvided && profile.activeWarehouse?.isActive !== false ? profile.activeWarehouse : null;
  if (warehouseProvided) {
    if (body.warehouseGuid === null) {
      warehouse = null;
    } else if (isGuidProvided(body.warehouseGuid)) {
      warehouse = ensureActive(
        await prisma.warehouse.findUnique({
          where: { guid: body.warehouseGuid },
          select: { id: true, guid: true, name: true, isActive: true },
        }),
        'Склад'
      );
    }
  }

  let priceType: PriceTypeRef | null =
    !priceTypeProvided && profile.activePriceType?.isActive !== false ? profile.activePriceType : null;
  if (priceTypeProvided) {
    if (body.priceTypeGuid === null) {
      priceType = null;
    } else if (isGuidProvided(body.priceTypeGuid)) {
      priceType = ensureActive(
        await prisma.priceType.findUnique({
          where: { guid: body.priceTypeGuid },
          select: { id: true, guid: true, name: true, isActive: true },
        }),
        'Тип цен'
      );
    }
  }

  let deliveryAddress: DeliveryAddressRef | null =
    !deliveryAddressProvided && profile.activeDeliveryAddress?.isActive !== false
      ? profile.activeDeliveryAddress
      : null;
  if (deliveryAddressProvided) {
    if (body.deliveryAddressGuid === null) {
      deliveryAddress = null;
    } else if (isGuidProvided(body.deliveryAddressGuid)) {
      deliveryAddress = ensureActive(
        await prisma.deliveryAddress.findUnique({
          where: { guid: body.deliveryAddressGuid },
          select: { id: true, guid: true, fullAddress: true, isActive: true, counterpartyId: true },
        }),
        'Адрес доставки'
      );
    }
  }

  if (agreement?.counterpartyId) {
    if (counterparty && counterparty.id !== agreement.counterpartyId) {
      throw new MarketplaceError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        'Соглашение не принадлежит выбранному контрагенту'
      );
    }
    counterparty = await loadCounterpartyById(agreement.counterpartyId);
  }

  if (contract) {
    if (counterparty && counterparty.id !== contract.counterpartyId) {
      throw new MarketplaceError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        'Договор не принадлежит выбранному контрагенту'
      );
    }
    counterparty = await loadCounterpartyById(contract.counterpartyId);
  }

  if (deliveryAddress?.counterpartyId) {
    if (counterparty && counterparty.id !== deliveryAddress.counterpartyId) {
      throw new MarketplaceError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        'Адрес доставки не принадлежит выбранному контрагенту'
      );
    }
    counterparty = await loadCounterpartyById(deliveryAddress.counterpartyId);
  }

  if (!counterparty) {
    throw new MarketplaceError(
      400,
      ErrorCodes.VALIDATION_ERROR,
      'Нельзя создать заказ без выбранного контрагента'
    );
  }

  if (agreement && contract && agreement.contractId && agreement.contractId !== contract.id) {
    throw new MarketplaceError(400, ErrorCodes.VALIDATION_ERROR, 'Договор не соответствует соглашению');
  }
  if (agreement && warehouse && agreement.warehouseId && agreement.warehouseId !== warehouse.id) {
    throw new MarketplaceError(400, ErrorCodes.VALIDATION_ERROR, 'Склад не соответствует соглашению');
  }
  if (agreement && priceType && agreement.priceTypeId && agreement.priceTypeId !== priceType.id) {
    throw new MarketplaceError(400, ErrorCodes.VALIDATION_ERROR, 'Тип цен не соответствует соглашению');
  }

  return {
    counterparty: { id: counterparty.id, guid: counterparty.guid, name: counterparty.name },
    agreement: agreement
      ? {
          id: agreement.id,
          guid: agreement.guid,
          name: agreement.name,
          currency: agreement.currency ?? null,
          contractId: agreement.contractId ?? null,
          warehouseId: agreement.warehouseId ?? null,
          priceTypeId: agreement.priceTypeId ?? null,
        }
      : null,
    contract: contract ? { id: contract.id, guid: contract.guid, number: contract.number } : null,
    warehouse: warehouse ? { id: warehouse.id, guid: warehouse.guid, name: warehouse.name } : null,
    priceType: priceType ? { id: priceType.id, guid: priceType.guid, name: priceType.name } : null,
    deliveryAddress: deliveryAddress
      ? { id: deliveryAddress.id, guid: deliveryAddress.guid ?? null, fullAddress: deliveryAddress.fullAddress }
      : null,
  };
};

export async function createOrder(userId: number, body: OrderCreateBody) {
  const context = await resolveOrderContext(userId, body);
  const createdAt = now();
  const guid = randomUUID();

  const order = await prisma.$transaction(async (tx) => {
    const preparedItems: Array<{
      productId: string;
      packageId: string | null;
      unitId: string | null;
      quantity: Prisma.Decimal;
      quantityBase: Prisma.Decimal;
      price: Prisma.Decimal;
      lineAmount: Prisma.Decimal;
    }> = [];

    for (const item of body.items) {
      const product = await tx.product.findUnique({
        where: { guid: item.productGuid },
        select: {
          id: true,
          guid: true,
          name: true,
          isActive: true,
          baseUnit: { select: { id: true, guid: true } },
        },
      });

      if (!product) {
        throw new MarketplaceError(404, ErrorCodes.NOT_FOUND, `Товар ${item.productGuid} не найден`);
      }
      if (!product.isActive) {
        throw new MarketplaceError(400, ErrorCodes.VALIDATION_ERROR, `Товар ${item.productGuid} неактивен`);
      }

      let packageRecord: { id: string; unitId: string; multiplier: Prisma.Decimal } | null = null;
      if (item.packageGuid) {
        packageRecord = await tx.productPackage.findFirst({
          where: { guid: item.packageGuid, productId: product.id },
          select: { id: true, unitId: true, multiplier: true },
        });
        if (!packageRecord) {
          throw new MarketplaceError(
            404,
            ErrorCodes.NOT_FOUND,
            `Упаковка ${item.packageGuid} для товара ${item.productGuid} не найдена`
          );
        }
      }

      if (item.unitGuid && !packageRecord) {
        if (!product.baseUnit || product.baseUnit.guid !== item.unitGuid) {
          throw new MarketplaceError(
            400,
            ErrorCodes.VALIDATION_ERROR,
            'unitGuid можно указывать только для базовой единицы товара или вместе с packageGuid'
          );
        }
      }

      const multiplier = packageRecord?.multiplier ?? new Prisma.Decimal(1);
      const quantity = new Prisma.Decimal(item.quantity);
      const quantityBase = quantity.mul(multiplier);

      const resolvedPrice = await resolveEffectivePrice({
        productGuid: product.guid,
        counterpartyGuid: context.counterparty.guid,
        agreementGuid: context.agreement?.guid ?? undefined,
        priceTypeGuid: context.priceType?.guid ?? undefined,
        at: createdAt,
      });

      const priceValue = resolvedPrice.price.value;
      if (priceValue === null || priceValue === undefined) {
        throw new MarketplaceError(
          400,
          ErrorCodes.VALIDATION_ERROR,
          `Не удалось определить цену для товара ${product.guid}`
        );
      }

      const minQty = resolvedPrice.match.minQty ?? null;
      if (minQty !== null && item.quantity < minQty) {
        throw new MarketplaceError(
          400,
          ErrorCodes.VALIDATION_ERROR,
          `Количество для товара ${product.guid} меньше минимального (${minQty})`
        );
      }

      const price = toDecimal(priceValue);
      const lineAmount = quantityBase.mul(price);

      preparedItems.push({
        productId: product.id,
        packageId: packageRecord?.id ?? null,
        unitId: packageRecord?.unitId ?? product.baseUnit?.id ?? null,
        quantity,
        quantityBase,
        price,
        lineAmount,
      });
    }

    const totalAmount = preparedItems.reduce(
      (sum, item) => sum.add(item.lineAmount),
      new Prisma.Decimal(0)
    );

    const contractId = context.contract?.id ?? context.agreement?.contractId ?? null;
    const warehouseId = context.warehouse?.id ?? context.agreement?.warehouseId ?? null;
    const currency = body.currency ?? context.agreement?.currency ?? null;

    return tx.order.create({
      data: {
        guid,
        counterpartyId: context.counterparty.id,
        agreementId: context.agreement?.id ?? null,
        contractId,
        warehouseId,
        deliveryAddressId: context.deliveryAddress?.id ?? null,
        status: OrderStatus.QUEUED,
        queuedAt: createdAt,
        deliveryDate: body.deliveryDate ?? null,
        comment: body.comment ?? null,
        currency,
        totalAmount,
        sourceUpdatedAt: createdAt,
        items: {
          create: preparedItems.map((item) => ({
            productId: item.productId,
            packageId: item.packageId,
            unitId: item.unitId,
            quantity: item.quantity,
            quantityBase: item.quantityBase,
            price: item.price,
            lineAmount: item.lineAmount,
            sourceUpdatedAt: createdAt,
          })),
        },
      },
      select: { guid: true },
    });
  });

  return getOrderByGuid(userId, order.guid ?? guid);
}

const orderSelect = {
  guid: true,
  number1c: true,
  date1c: true,
  status: true,
  comment: true,
  deliveryDate: true,
  totalAmount: true,
  currency: true,
  queuedAt: true,
  sentTo1cAt: true,
  lastStatusSyncAt: true,
  exportAttempts: true,
  lastExportError: true,
  createdAt: true,
  updatedAt: true,
  counterparty: { select: { guid: true, name: true } },
  agreement: { select: { guid: true, name: true, currency: true } },
  contract: { select: { guid: true, number: true } },
  warehouse: { select: { guid: true, name: true } },
  deliveryAddress: { select: { guid: true, fullAddress: true } },
  items: {
    select: {
      quantity: true,
      quantityBase: true,
      price: true,
      lineAmount: true,
      discountPercent: true,
      product: { select: { guid: true, name: true, code: true, article: true } },
      package: { select: { guid: true, name: true, multiplier: true } },
      unit: { select: { guid: true, name: true, symbol: true } },
    },
  },
} satisfies Prisma.OrderSelect;

const mapOrder = (order: Prisma.OrderGetPayload<{ select: typeof orderSelect }>) => ({
  guid: order.guid,
  number1c: order.number1c,
  date1c: order.date1c,
  status: order.status,
  comment: order.comment,
  deliveryDate: order.deliveryDate,
  totalAmount: decimalToNumber(order.totalAmount),
  currency: order.currency,
  queuedAt: order.queuedAt,
  sentTo1cAt: order.sentTo1cAt,
  lastStatusSyncAt: order.lastStatusSyncAt,
  exportAttempts: order.exportAttempts,
  lastExportError: order.lastExportError,
  counterparty: order.counterparty,
  agreement: order.agreement,
  contract: order.contract,
  warehouse: order.warehouse,
  deliveryAddress: order.deliveryAddress,
  items: order.items.map((item) => ({
    product: item.product,
    package: item.package
      ? {
          guid: item.package.guid,
          name: item.package.name,
          multiplier: decimalToNumber(item.package.multiplier),
        }
      : null,
    unit: item.unit,
    quantity: decimalToNumber(item.quantity),
    quantityBase: decimalToNumber(item.quantityBase),
    price: decimalToNumber(item.price),
    lineAmount: decimalToNumber(item.lineAmount),
    discountPercent: decimalToNumber(item.discountPercent),
  })),
  createdAt: order.createdAt,
  updatedAt: order.updatedAt,
});

export async function listOrders(userId: number, query: OrdersListQuery) {
  const profile = await getClientProfileOrThrow(userId);
  if (!profile.counterpartyId) {
    throw new MarketplaceError(400, ErrorCodes.VALIDATION_ERROR, 'У клиента не выбран контрагент');
  }

  const where: Prisma.OrderWhereInput = {
    counterpartyId: profile.counterpartyId,
    ...(query.status ? { status: query.status } : {}),
  };

  const [orders, total] = await prisma.$transaction([
    prisma.order.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }],
      skip: query.offset,
      take: query.limit,
      select: orderSelect,
    }),
    prisma.order.count({ where }),
  ]);

  return {
    items: orders.map(mapOrder),
    total,
    limit: query.limit,
    offset: query.offset,
  };
}

export async function getOrderByGuid(userId: number, guid: string) {
  const profile = await getClientProfileOrThrow(userId);
  if (!profile.counterpartyId) {
    throw new MarketplaceError(400, ErrorCodes.VALIDATION_ERROR, 'У клиента не выбран контрагент');
  }

  const order = await prisma.order.findFirst({
    where: { guid, counterpartyId: profile.counterpartyId },
    select: orderSelect,
  });

  if (!order) {
    throw new MarketplaceError(404, ErrorCodes.NOT_FOUND, `Заказ ${guid} не найден`);
  }

  return mapOrder(order);
}
