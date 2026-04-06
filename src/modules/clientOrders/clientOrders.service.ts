import {
  OrderSource,
  OrderStatus,
  OrderSyncState,
  OrderEventSource,
  Prisma,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import prisma from '../../prisma/client';
import { ErrorCodes } from '../../utils/apiResponse';
import { appendOrderEvent } from '../orders/orderEvents';
import { decimalToNumber, mapOrderDetail, orderDetailSelect, toDecimal } from '../orders/orderModel';
import { MarketplaceError, resolveEffectivePrice } from '../marketplace/marketplace.service';
import type {
  ClientOrderCancelBody,
  ClientOrderCreateBody,
  ClientOrderSubmitBody,
  ClientOrderUpdateBody,
  ClientOrdersListQuery,
  ClientOrdersProductsQuery,
  ClientOrdersReferenceDataQuery,
} from './clientOrders.schemas';

type ClientOrdersErrorCode =
  | ErrorCodes.NOT_FOUND
  | ErrorCodes.VALIDATION_ERROR
  | ErrorCodes.INTERNAL_ERROR
  | ErrorCodes.CONFLICT
  | ErrorCodes.FORBIDDEN;

type Tx = Prisma.TransactionClient;

class ClientOrdersError extends Error {
  public readonly status: number;
  public readonly code: ClientOrdersErrorCode;

  constructor(status: number, code: ClientOrdersErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type ManagerOrderContext = {
  counterparty: { id: string; guid: string; name: string };
  agreement: {
    id: string;
    guid: string;
    name: string;
    counterpartyId: string | null;
    contractId: string | null;
    warehouseId: string | null;
    priceTypeId: string | null;
    currency: string | null;
  } | null;
  contract: { id: string; guid: string; number: string; counterpartyId: string } | null;
  warehouse: { id: string; guid: string; name: string } | null;
  deliveryAddress: { id: string; guid: string | null; fullAddress: string; counterpartyId: string } | null;
  priceType: { id: string; guid: string; name: string } | null;
};

type PreparedOrderLine = {
  create: Prisma.OrderItemUncheckedCreateWithoutOrderInput;
  snapshot: Prisma.InputJsonObject;
};

type PreparedOrderPayload = {
  items: PreparedOrderLine[];
  totalAmount: Prisma.Decimal;
  generalDiscountAmount: Prisma.Decimal;
};

const now = () => new Date();

function ensureEditable(order: {
  status: OrderStatus;
  isPostedIn1c: boolean;
  source: OrderSource;
}) {
  if (order.source !== OrderSource.MANAGER_APP) {
    throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, 'Заказ менеджера не найден');
  }
  if (order.isPostedIn1c) {
    throw new ClientOrdersError(409, ErrorCodes.CONFLICT, 'Проведенный заказ в 1С доступен только для чтения');
  }
  if (order.status === OrderStatus.CANCELLED) {
    throw new ClientOrdersError(409, ErrorCodes.CONFLICT, 'Отмененный заказ нельзя редактировать');
  }
}

function assertRevision(currentRevision: number, expectedRevision: number) {
  if (currentRevision !== expectedRevision) {
    throw new ClientOrdersError(
      409,
      ErrorCodes.CONFLICT,
      `Версия заказа устарела. Актуальная revision: ${currentRevision}`
    );
  }
}

function normalizeSearch(search?: string) {
  const trimmed = search?.trim();
  return trimmed ? trimmed : undefined;
}

function buildReferenceWhere(includeInactive: boolean) {
  return includeInactive ? {} : { isActive: true };
}

async function fetchManagerOrderOrThrow(guid: string) {
  const order = await prisma.order.findFirst({
    where: { guid, source: OrderSource.MANAGER_APP },
    select: orderDetailSelect,
  });

  if (!order) {
    throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Заказ ${guid} не найден`);
  }

  return order;
}

async function loadCounterpartyByGuid(tx: Tx, guid: string) {
  const counterparty = await tx.counterparty.findUnique({
    where: { guid },
    select: { id: true, guid: true, name: true, isActive: true },
  });

  if (!counterparty) {
    throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Контрагент ${guid} не найден`);
  }
  if (counterparty.isActive === false) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, `Контрагент ${guid} неактивен`);
  }

  return counterparty;
}

async function loadAgreementByGuid(tx: Tx, guid: string) {
  const agreement = await tx.clientAgreement.findUnique({
    where: { guid },
    select: {
      id: true,
      guid: true,
      name: true,
      counterpartyId: true,
      contractId: true,
      warehouseId: true,
      priceTypeId: true,
      currency: true,
      isActive: true,
    },
  });

  if (!agreement) {
    throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Соглашение ${guid} не найдено`);
  }
  if (agreement.isActive === false) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, `Соглашение ${guid} неактивно`);
  }

  return agreement;
}

async function loadContractByGuid(tx: Tx, guid: string) {
  const contract = await tx.clientContract.findUnique({
    where: { guid },
    select: {
      id: true,
      guid: true,
      number: true,
      counterpartyId: true,
      isActive: true,
    },
  });

  if (!contract) {
    throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Договор ${guid} не найден`);
  }
  if (contract.isActive === false) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, `Договор ${guid} неактивен`);
  }

  return contract;
}

async function loadWarehouseByGuid(tx: Tx, guid: string) {
  const warehouse = await tx.warehouse.findUnique({
    where: { guid },
    select: { id: true, guid: true, name: true, isActive: true },
  });

  if (!warehouse) {
    throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Склад ${guid} не найден`);
  }
  if (warehouse.isActive === false) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, `Склад ${guid} неактивен`);
  }

  return warehouse;
}

async function loadDeliveryAddressByGuid(tx: Tx, guid: string) {
  const address = await tx.deliveryAddress.findFirst({
    where: { OR: [{ guid }, { id: guid }] },
    select: {
      id: true,
      guid: true,
      fullAddress: true,
      counterpartyId: true,
      isActive: true,
    },
  });

  if (!address) {
    throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Адрес доставки ${guid} не найден`);
  }
  if (address.isActive === false) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, `Адрес доставки ${guid} неактивен`);
  }

  return address;
}

async function loadPriceTypeById(tx: Tx, id: string) {
  const priceType = await tx.priceType.findUnique({
    where: { id },
    select: { id: true, guid: true, name: true, isActive: true },
  });

  if (!priceType) {
    throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, 'Тип цены не найден');
  }
  if (priceType.isActive === false) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, `Тип цены ${priceType.guid} неактивен`);
  }

  return priceType;
}

async function resolveManagerOrderContext(tx: Tx, body: ClientOrderCreateBody): Promise<ManagerOrderContext> {
  const counterparty = await loadCounterpartyByGuid(tx, body.counterpartyGuid);

  const agreement = body.agreementGuid ? await loadAgreementByGuid(tx, body.agreementGuid) : null;
  if (agreement?.counterpartyId && agreement.counterpartyId !== counterparty.id) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, 'Соглашение не принадлежит выбранному контрагенту');
  }

  const contract = body.contractGuid ? await loadContractByGuid(tx, body.contractGuid) : null;
  if (contract?.counterpartyId !== undefined && contract.counterpartyId !== counterparty.id) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, 'Договор не принадлежит выбранному контрагенту');
  }
  if (agreement?.contractId && contract && agreement.contractId !== contract.id) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, 'Договор не соответствует выбранному соглашению');
  }

  const warehouse = body.warehouseGuid ? await loadWarehouseByGuid(tx, body.warehouseGuid) : null;
  if (agreement?.warehouseId && warehouse && agreement.warehouseId !== warehouse.id) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, 'Склад не соответствует выбранному соглашению');
  }

  const deliveryAddress = body.deliveryAddressGuid
    ? await loadDeliveryAddressByGuid(tx, body.deliveryAddressGuid)
    : null;
  if (deliveryAddress && deliveryAddress.counterpartyId !== counterparty.id) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, 'Адрес доставки не принадлежит выбранному контрагенту');
  }

  const priceTypeId = agreement?.priceTypeId ?? null;
  const priceType = priceTypeId ? await loadPriceTypeById(tx, priceTypeId) : null;

  return {
    counterparty: { id: counterparty.id, guid: counterparty.guid, name: counterparty.name },
    agreement: agreement
      ? {
          id: agreement.id,
          guid: agreement.guid,
          name: agreement.name,
          counterpartyId: agreement.counterpartyId,
          contractId: agreement.contractId,
          warehouseId: agreement.warehouseId,
          priceTypeId: agreement.priceTypeId,
          currency: agreement.currency,
        }
      : null,
    contract: contract
      ? {
          id: contract.id,
          guid: contract.guid,
          number: contract.number,
          counterpartyId: contract.counterpartyId,
        }
      : null,
    warehouse: warehouse ? { id: warehouse.id, guid: warehouse.guid, name: warehouse.name } : null,
    deliveryAddress: deliveryAddress
      ? {
          id: deliveryAddress.id,
          guid: deliveryAddress.guid ?? null,
          fullAddress: deliveryAddress.fullAddress,
          counterpartyId: deliveryAddress.counterpartyId,
        }
      : null,
    priceType: priceType ? { id: priceType.id, guid: priceType.guid, name: priceType.name } : null,
  };
}

async function prepareOrderItems(
  tx: Tx,
  body: ClientOrderCreateBody,
  context: ManagerOrderContext,
  sourceUpdatedAt: Date
): Promise<PreparedOrderPayload> {
  const preparedItems: PreparedOrderLine[] = [];
  let totalAmount = new Prisma.Decimal(0);
  let generalDiscountAmount = new Prisma.Decimal(0);
  const generalDiscountPercent = body.generalDiscountPercent ?? null;

  for (const item of body.items) {
    const product = await tx.product.findUnique({
      where: { guid: item.productGuid },
      select: {
        id: true,
        guid: true,
        name: true,
        code: true,
        article: true,
        isActive: true,
        baseUnit: { select: { id: true, guid: true, name: true, symbol: true } },
      },
    });

    if (!product) {
      throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Товар ${item.productGuid} не найден`);
    }
    if (product.isActive === false) {
      throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, `Товар ${item.productGuid} неактивен`);
    }

    let packageRecord: {
      id: string;
      guid: string | null;
      name: string;
      unitId: string;
      multiplier: Prisma.Decimal;
      unit: { guid: string | null; name: string; symbol: string | null };
    } | null = null;

    if (item.packageGuid) {
      packageRecord = await tx.productPackage.findFirst({
        where: { guid: item.packageGuid, productId: product.id },
        select: {
          id: true,
          guid: true,
          name: true,
          unitId: true,
          multiplier: true,
          unit: { select: { guid: true, name: true, symbol: true } },
        },
      });

      if (!packageRecord) {
        throw new ClientOrdersError(
          404,
          ErrorCodes.NOT_FOUND,
          `Упаковка ${item.packageGuid} для товара ${item.productGuid} не найдена`
        );
      }
    }

    const quantity = new Prisma.Decimal(item.quantity);
    const multiplier = packageRecord?.multiplier ?? new Prisma.Decimal(1);
    const quantityBase = quantity.mul(multiplier);

    const resolvedPrice = await resolveEffectivePrice({
      productGuid: product.guid,
      counterpartyGuid: context.counterparty.guid,
      agreementGuid: context.agreement?.guid ?? undefined,
      priceTypeGuid: context.priceType?.guid ?? undefined,
      at: sourceUpdatedAt,
    });

    const basePriceValue = resolvedPrice.price.value;
    if (basePriceValue === null || basePriceValue === undefined) {
      throw new ClientOrdersError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        `Не удалось определить базовую цену для товара ${product.guid}`
      );
    }

    const minQty = resolvedPrice.match.minQty ?? null;
    if (minQty !== null && item.quantity < minQty) {
      throw new ClientOrdersError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        `Количество для товара ${product.guid} меньше минимального (${minQty})`
      );
    }

    const basePrice = toDecimal(basePriceValue)!;
    const isManualPrice = item.manualPrice !== null && item.manualPrice !== undefined;
    const manualPrice = isManualPrice ? toDecimal(item.manualPrice)! : null;
    const lineDiscountPercent = item.discountPercent ?? null;
    const canApplyGeneralDiscount = !isManualPrice && (lineDiscountPercent === null || lineDiscountPercent === undefined);
    const appliedDiscountPercent = lineDiscountPercent ?? (canApplyGeneralDiscount ? generalDiscountPercent : null);

    let finalPrice = manualPrice ?? basePrice;
    if (appliedDiscountPercent !== null && appliedDiscountPercent !== undefined) {
      const multiplierPercent = new Prisma.Decimal(100).minus(new Prisma.Decimal(appliedDiscountPercent)).div(100);
      const discountedPrice = finalPrice.mul(multiplierPercent);
      if (canApplyGeneralDiscount && generalDiscountPercent !== null && generalDiscountPercent !== undefined) {
        generalDiscountAmount = generalDiscountAmount.add(basePrice.minus(discountedPrice).mul(quantityBase));
      }
      finalPrice = discountedPrice;
    }

    const lineAmount = quantityBase.mul(finalPrice);
    totalAmount = totalAmount.add(lineAmount);

    preparedItems.push({
      create: {
        productId: product.id,
        packageId: packageRecord?.id ?? null,
        unitId: packageRecord?.unitId ?? product.baseUnit?.id ?? null,
        quantity,
        quantityBase,
        basePrice,
        price: finalPrice,
        isManualPrice,
        manualPrice,
        priceSource: `${resolvedPrice.match.source}:${resolvedPrice.match.level}`,
        discountPercent: lineDiscountPercent !== null && lineDiscountPercent !== undefined ? toDecimal(lineDiscountPercent)! : null,
        appliedDiscountPercent:
          appliedDiscountPercent !== null && appliedDiscountPercent !== undefined
            ? toDecimal(appliedDiscountPercent)!
            : null,
        lineAmount,
        comment: item.comment ?? null,
        sourceUpdatedAt,
      },
      snapshot: {
        product: {
          guid: product.guid,
          name: product.name,
          code: product.code,
          article: product.article,
        },
        package: packageRecord
          ? {
              guid: packageRecord.guid,
              name: packageRecord.name,
              multiplier: decimalToNumber(packageRecord.multiplier),
            }
          : null,
        unit: packageRecord
          ? packageRecord.unit
          : product.baseUnit
            ? {
                guid: product.baseUnit.guid,
                name: product.baseUnit.name,
                symbol: product.baseUnit.symbol,
              }
            : null,
        quantity: item.quantity,
        quantityBase: decimalToNumber(quantityBase),
        basePrice: decimalToNumber(basePrice),
        manualPrice: decimalToNumber(manualPrice),
        isManualPrice,
        price: decimalToNumber(finalPrice),
        priceSource: `${resolvedPrice.match.source}:${resolvedPrice.match.level}`,
        discountPercent: lineDiscountPercent,
        appliedDiscountPercent,
        lineAmount: decimalToNumber(lineAmount),
        comment: item.comment ?? null,
      },
    });
  }

  return {
    items: preparedItems,
    totalAmount,
    generalDiscountAmount,
  };
}

export async function listClientOrders(query: ClientOrdersListQuery) {
  const search = normalizeSearch(query.search);
  const where: Prisma.OrderWhereInput = {
    source: OrderSource.MANAGER_APP,
    ...(query.status ? { status: query.status } : {}),
    ...(query.counterpartyGuid ? { counterparty: { guid: query.counterpartyGuid } } : {}),
    ...(search
      ? {
          OR: [
            { guid: { contains: search, mode: 'insensitive' } },
            { number1c: { contains: search, mode: 'insensitive' } },
            { comment: { contains: search, mode: 'insensitive' } },
            { counterparty: { name: { contains: search, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };

  const [items, total] = await prisma.$transaction([
    prisma.order.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
      skip: query.offset,
      take: query.limit,
      select: orderDetailSelect,
    }),
    prisma.order.count({ where }),
  ]);

  return {
    items: items.map(mapOrderDetail),
    total,
    limit: query.limit,
    offset: query.offset,
  };
}

export async function getClientOrderByGuid(guid: string) {
  const order = await fetchManagerOrderOrThrow(guid);
  return mapOrderDetail(order);
}

export async function getClientOrdersReferenceData(query: ClientOrdersReferenceDataQuery) {
  const commonWhere = buildReferenceWhere(query.includeInactive);
  const counterparty = query.counterpartyGuid
    ? await prisma.counterparty.findUnique({
        where: { guid: query.counterpartyGuid },
        select: { id: true, guid: true, name: true, isActive: true },
      })
    : null;

  if (query.counterpartyGuid && !counterparty) {
    throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Контрагент ${query.counterpartyGuid} не найден`);
  }
  if (counterparty?.isActive === false && !query.includeInactive) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, `Контрагент ${query.counterpartyGuid} неактивен`);
  }

  const counterparties = await prisma.counterparty.findMany({
    where: commonWhere,
    orderBy: [{ name: 'asc' }],
    select: {
      guid: true,
      name: true,
      fullName: true,
      inn: true,
      kpp: true,
      isActive: true,
    },
  });

  const counterpartyId = counterparty?.id;

  const [agreements, contracts, deliveryAddresses, warehouses] = await Promise.all([
    prisma.clientAgreement.findMany({
      where: {
        ...commonWhere,
        ...(counterpartyId ? { counterpartyId } : {}),
      },
      orderBy: [{ name: 'asc' }],
      select: {
        guid: true,
        name: true,
        currency: true,
        isActive: true,
        contract: { select: { guid: true, number: true } },
        warehouse: { select: { guid: true, name: true } },
        priceType: { select: { guid: true, name: true } },
      },
    }),
    prisma.clientContract.findMany({
      where: {
        ...commonWhere,
        ...(counterpartyId ? { counterpartyId } : {}),
      },
      orderBy: [{ number: 'asc' }],
      select: {
        guid: true,
        number: true,
        date: true,
        validFrom: true,
        validTo: true,
        isActive: true,
      },
    }),
    prisma.deliveryAddress.findMany({
      where: {
        ...commonWhere,
        ...(counterpartyId ? { counterpartyId } : {}),
      },
      orderBy: [{ isDefault: 'desc' }, { fullAddress: 'asc' }],
      select: {
        guid: true,
        name: true,
        fullAddress: true,
        city: true,
        street: true,
        house: true,
        isDefault: true,
        isActive: true,
      },
    }),
    prisma.warehouse.findMany({
      where: commonWhere,
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      select: {
        guid: true,
        name: true,
        code: true,
        isDefault: true,
        isPickup: true,
        isActive: true,
      },
    }),
  ]);

  return {
    counterparties,
    agreements,
    contracts,
    deliveryAddresses,
    warehouses,
  };
}

export async function getClientOrdersProducts(query: ClientOrdersProductsQuery) {
  const search = normalizeSearch(query.search);
  const contextCounterparty = query.counterpartyGuid
    ? await prisma.counterparty.findUnique({
        where: { guid: query.counterpartyGuid },
        select: { id: true, guid: true, name: true, isActive: true },
      })
    : null;

  if (query.counterpartyGuid && !contextCounterparty) {
    throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Контрагент ${query.counterpartyGuid} не найден`);
  }

  const agreement = query.agreementGuid
    ? await prisma.clientAgreement.findUnique({
        where: { guid: query.agreementGuid },
        select: {
          id: true,
          guid: true,
          isActive: true,
          counterpartyId: true,
          priceTypeId: true,
          priceType: { select: { guid: true, name: true } },
        },
      })
    : null;

  if (query.agreementGuid && !agreement) {
    throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Соглашение ${query.agreementGuid} не найдено`);
  }
  if (agreement?.counterpartyId && contextCounterparty && agreement.counterpartyId !== contextCounterparty.id) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, 'Соглашение не принадлежит выбранному контрагенту');
  }

  const where: Prisma.ProductWhereInput = {
    isActive: true,
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { code: { contains: search, mode: 'insensitive' } },
            { article: { contains: search, mode: 'insensitive' } },
            { sku: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [products, total] = await prisma.$transaction([
    prisma.product.findMany({
      where,
      orderBy: [{ name: 'asc' }],
      skip: query.offset,
      take: query.limit,
      select: {
        guid: true,
        name: true,
        code: true,
        article: true,
        sku: true,
        baseUnit: { select: { guid: true, name: true, symbol: true } },
        packages: {
          orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
          select: {
            guid: true,
            name: true,
            multiplier: true,
            isDefault: true,
            unit: { select: { guid: true, name: true, symbol: true } },
          },
        },
      },
    }),
    prisma.product.count({ where }),
  ]);

  const items = await Promise.all(
    products.map(async (product) => {
      try {
        const resolved = await resolveEffectivePrice({
          productGuid: product.guid,
          counterpartyGuid: contextCounterparty?.guid,
          agreementGuid: agreement?.guid,
          priceTypeGuid: agreement?.priceType?.guid,
        });

        return {
          ...product,
          packages: product.packages.map((pack) => ({
            ...pack,
            multiplier: decimalToNumber(pack.multiplier),
          })),
          basePrice: resolved.price.value,
          currency: resolved.price.currency,
          priceMatch: resolved.match,
        };
      } catch (error) {
        if (error instanceof MarketplaceError) {
          return {
            ...product,
            packages: product.packages.map((pack) => ({
              ...pack,
              multiplier: decimalToNumber(pack.multiplier),
            })),
            basePrice: null,
            currency: null,
            priceMatch: null,
            priceError: error.message,
          };
        }
        throw error;
      }
    })
  );

  return {
    items,
    total,
    limit: query.limit,
    offset: query.offset,
  };
}

export async function createClientOrder(userId: number, body: ClientOrderCreateBody) {
  const sourceUpdatedAt = now();

  const created = await prisma.$transaction(async (tx) => {
    const context = await resolveManagerOrderContext(tx, body);
    const prepared = await prepareOrderItems(tx, body, context, sourceUpdatedAt);
    const guid = randomUUID();

    const order = await tx.order.create({
      data: {
        guid,
        source: OrderSource.MANAGER_APP,
        revision: 1,
        syncState: OrderSyncState.DRAFT,
        status: OrderStatus.DRAFT,
        counterpartyId: context.counterparty.id,
        agreementId: context.agreement?.id ?? null,
        contractId: context.contract?.id ?? context.agreement?.contractId ?? null,
        warehouseId: context.warehouse?.id ?? context.agreement?.warehouseId ?? null,
        deliveryAddressId: context.deliveryAddress?.id ?? null,
        createdByUserId: userId,
        comment: body.comment ?? null,
        deliveryDate: body.deliveryDate ?? null,
        currency: body.currency ?? context.agreement?.currency ?? null,
        totalAmount: prepared.totalAmount,
        generalDiscountPercent:
          body.generalDiscountPercent !== null && body.generalDiscountPercent !== undefined
            ? toDecimal(body.generalDiscountPercent)
            : null,
        generalDiscountAmount: prepared.generalDiscountAmount,
        sourceUpdatedAt,
        items: {
          create: prepared.items.map((item) => item.create),
        },
      },
      select: { id: true, guid: true, revision: true },
    });

    await appendOrderEvent(tx, {
      orderId: order.id,
      revision: order.revision,
      source: OrderEventSource.APP_MANAGER,
      eventType: 'CLIENT_ORDER_CREATED',
      actorUserId: userId,
      payload: {
        comment: body.comment ?? null,
        deliveryDate: body.deliveryDate?.toISOString?.() ?? null,
        generalDiscountPercent: body.generalDiscountPercent ?? null,
        items: prepared.items.map((item) => item.snapshot),
      } as Prisma.InputJsonValue,
    });

    return order.guid!;
  });

  return getClientOrderByGuid(created);
}

export async function updateClientOrder(guid: string, userId: number, body: ClientOrderUpdateBody) {
  const sourceUpdatedAt = now();

  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({
      where: { guid, source: OrderSource.MANAGER_APP },
      select: {
        id: true,
        guid: true,
        revision: true,
        status: true,
        source: true,
        isPostedIn1c: true,
      },
    });

    if (!order) {
      throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Заказ ${guid} не найден`);
    }

    ensureEditable(order);
    assertRevision(order.revision, body.revision);

    const context = await resolveManagerOrderContext(tx, body);
    const prepared = await prepareOrderItems(tx, body, context, sourceUpdatedAt);
    const nextRevision = order.revision + 1;

    await tx.orderItem.deleteMany({ where: { orderId: order.id } });

    await tx.order.update({
      where: { id: order.id },
      data: {
        revision: nextRevision,
        syncState:
          order.status === OrderStatus.SENT_TO_1C || order.status === OrderStatus.QUEUED
            ? OrderSyncState.QUEUED
            : OrderSyncState.DRAFT,
        counterpartyId: context.counterparty.id,
        agreementId: context.agreement?.id ?? null,
        contractId: context.contract?.id ?? context.agreement?.contractId ?? null,
        warehouseId: context.warehouse?.id ?? context.agreement?.warehouseId ?? null,
        deliveryAddressId: context.deliveryAddress?.id ?? null,
        comment: body.comment ?? null,
        deliveryDate: body.deliveryDate ?? null,
        currency: body.currency ?? context.agreement?.currency ?? null,
        totalAmount: prepared.totalAmount,
        generalDiscountPercent:
          body.generalDiscountPercent !== null && body.generalDiscountPercent !== undefined
            ? toDecimal(body.generalDiscountPercent)
            : null,
        generalDiscountAmount: prepared.generalDiscountAmount,
        last1cError: null,
        sourceUpdatedAt,
        items: {
          create: prepared.items.map((item) => item.create),
        },
      },
    });

    await appendOrderEvent(tx, {
      orderId: order.id,
      revision: nextRevision,
      source: OrderEventSource.APP_MANAGER,
      eventType: 'CLIENT_ORDER_UPDATED',
      actorUserId: userId,
      payload: {
        comment: body.comment ?? null,
        deliveryDate: body.deliveryDate?.toISOString?.() ?? null,
        generalDiscountPercent: body.generalDiscountPercent ?? null,
        items: prepared.items.map((item) => item.snapshot),
      } as Prisma.InputJsonValue,
    });
  });

  return getClientOrderByGuid(guid);
}

export async function submitClientOrder(guid: string, userId: number, body: ClientOrderSubmitBody) {
  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({
      where: { guid, source: OrderSource.MANAGER_APP },
      select: {
        id: true,
        guid: true,
        revision: true,
        status: true,
        source: true,
        isPostedIn1c: true,
      },
    });

    if (!order) {
      throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Заказ ${guid} не найден`);
    }

    ensureEditable(order);
    assertRevision(order.revision, body.revision);

    if (order.status === OrderStatus.CANCELLED) {
      throw new ClientOrdersError(409, ErrorCodes.CONFLICT, 'Отмененный заказ нельзя отправить');
    }

    const nextRevision = order.revision + 1;
    const queuedAt = now();

    await tx.order.update({
      where: { id: order.id },
      data: {
        revision: nextRevision,
        status: OrderStatus.QUEUED,
        syncState: OrderSyncState.QUEUED,
        queuedAt,
        cancelRequestedAt: null,
        cancelReason: null,
        last1cError: null,
        sourceUpdatedAt: queuedAt,
      },
    });

    await appendOrderEvent(tx, {
      orderId: order.id,
      revision: nextRevision,
      source: OrderEventSource.APP_MANAGER,
      eventType: 'CLIENT_ORDER_SUBMITTED',
      actorUserId: userId,
      payload: { queuedAt: queuedAt.toISOString() },
    });
  });

  return getClientOrderByGuid(guid);
}

export async function cancelClientOrder(guid: string, userId: number, body: ClientOrderCancelBody) {
  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({
      where: { guid, source: OrderSource.MANAGER_APP },
      select: {
        id: true,
        guid: true,
        revision: true,
        status: true,
        source: true,
        isPostedIn1c: true,
      },
    });

    if (!order) {
      throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Заказ ${guid} не найден`);
    }

    ensureEditable(order);
    assertRevision(order.revision, body.revision);

    const nextRevision = order.revision + 1;
    const cancelledAt = now();
    const requiresOnecCancel = order.status !== OrderStatus.DRAFT;

    await tx.order.update({
      where: { id: order.id },
      data: {
        revision: nextRevision,
        status: OrderStatus.CANCELLED,
        syncState: requiresOnecCancel ? OrderSyncState.CANCEL_REQUESTED : OrderSyncState.SYNCED,
        cancelRequestedAt: requiresOnecCancel ? cancelledAt : null,
        cancelReason: body.reason ?? null,
        sourceUpdatedAt: cancelledAt,
      },
    });

    await appendOrderEvent(tx, {
      orderId: order.id,
      revision: nextRevision,
      source: OrderEventSource.APP_CANCEL_REQUEST,
      eventType: 'CLIENT_ORDER_CANCELLED',
      actorUserId: userId,
      note: body.reason ?? null,
      payload: {
        cancelRequestedAt: cancelledAt.toISOString(),
        requiresOnecCancel,
        reason: body.reason ?? null,
      },
    });
  });

  return getClientOrderByGuid(guid);
}

export { ClientOrdersError };
