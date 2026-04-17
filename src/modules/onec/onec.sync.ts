import {
  OnecStageResolveStatus,
  OnecSyncSessionStatus,
  Prisma,
  SyncEntityType,
} from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import prisma from '../../prisma/client';
import { cacheDelPrefix } from '../../utils/cache';
import type {
  AgreementItem,
  ContractItem,
  CounterpartyItem,
  NomenclatureItem,
  OrganizationItem,
  ProductPriceItem,
  SessionCompleteBody,
  SessionStartBody,
  SpecialPriceItem,
  StockItem,
  WarehouseItem,
} from './onec.schemas';

export type BatchEntityCode =
  | 'nomenclature'
  | 'organizations'
  | 'warehouses'
  | 'counterparties'
  | 'contracts'
  | 'agreements'
  | 'product-prices'
  | 'special-prices'
  | 'stock';

export type BatchResult = { key: string; status: 'ok' | 'error'; error?: string };

type StageIssue = { stageId: string; message: string };

type ApplySummary = {
  resolvedStageIds: string[];
  blocked: StageIssue[];
  errors: StageIssue[];
};

const emptyApplySummary = (): ApplySummary => ({ resolvedStageIds: [], blocked: [], errors: [] });

const mergeApplySummaries = (base: ApplySummary, extra: ApplySummary): ApplySummary => {
  const blockedIds = new Set(extra.blocked.map((item) => item.stageId));
  const errorIds = new Set(extra.errors.map((item) => item.stageId));
  const resolvedStageIds = [...new Set([...base.resolvedStageIds, ...extra.resolvedStageIds])].filter(
    (stageId) => !blockedIds.has(stageId) && !errorIds.has(stageId)
  );
  return {
    resolvedStageIds,
    blocked: [...base.blocked, ...extra.blocked],
    errors: [...base.errors, ...extra.errors],
  };
};

type SessionOutcome = {
  sessionId: string;
  status: OnecSyncSessionStatus;
  acceptedCount: number;
  resolvedCount: number;
  blockedCount: number;
  errorCount: number;
  notes?: string | null;
};

type TxClient = Prisma.TransactionClient;

const CLOSED_AGREEMENT_STATUS = 'Закрыто';
const CLOSED_CONTRACT_STATUS = 'Закрыт';
const ZERO_GUID = '00000000-0000-0000-0000-000000000000';

function nonEmptyString(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function optionalGuid(value?: string | null) {
  const guid = nonEmptyString(value);
  return guid && guid !== ZERO_GUID ? guid : undefined;
}

function isClosedAgreementStatus(status?: string | null) {
  return status?.trim().toLocaleLowerCase('ru') === CLOSED_AGREEMENT_STATUS.toLocaleLowerCase('ru');
}

function isClosedContractStatus(status?: string | null) {
  return status?.trim().toLocaleLowerCase('ru') === CLOSED_CONTRACT_STATUS.toLocaleLowerCase('ru');
}

const ENTITY_SYNC_TYPE: Record<BatchEntityCode, SyncEntityType> = {
  nomenclature: SyncEntityType.NOMENCLATURE,
  organizations: SyncEntityType.ORGANIZATIONS,
  warehouses: SyncEntityType.WAREHOUSES,
  counterparties: SyncEntityType.COUNTERPARTIES,
  contracts: SyncEntityType.CONTRACTS,
  agreements: SyncEntityType.AGREEMENTS,
  'product-prices': SyncEntityType.PRODUCT_PRICES,
  'special-prices': SyncEntityType.SPECIAL_PRICES,
  stock: SyncEntityType.STOCK,
};

const SYNC_SESSION_TX_MAX_WAIT_MS = 10_000;
const SYNC_SESSION_TX_TIMEOUT_MS = 120_000;
const STOCK_BALANCES_CACHE_PREFIX = 'stock-balances:';

const RECONCILE_ORDER: BatchEntityCode[] = [
  'nomenclature',
  'organizations',
  'warehouses',
  'counterparties',
  'contracts',
  'agreements',
  'product-prices',
  'special-prices',
  'stock',
];

const now = () => new Date();

const toJsonValue = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

const hashPayload = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

const normalizeSelectedEntities = (selected?: string[] | null): BatchEntityCode[] => {
  if (!selected?.length) return [];
  const allowed = new Set<BatchEntityCode>(RECONCILE_ORDER);
  const result: BatchEntityCode[] = [];
  for (const entity of selected) {
    const normalized = String(entity).trim() as BatchEntityCode;
    if (!allowed.has(normalized) || result.includes(normalized)) {
      continue;
    }
    result.push(normalized);
  }
  return result;
};

const toDecimal = (value?: number | null) =>
  value === undefined || value === null ? undefined : new Prisma.Decimal(value);

const toNullableDecimal = (value?: number | null) =>
  value === undefined || value === null ? null : new Prisma.Decimal(value);

const normalizeCounterpartyString = (value: string | null | undefined): string | undefined => {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const digitsOnly = (value: string | null | undefined): string | undefined => {
  const prepared = normalizeCounterpartyString(value);
  if (!prepared) return undefined;
  const digits = prepared.replace(/\D+/g, '');
  return digits.length > 0 ? digits : undefined;
};

const normalizeInn = (value: string | null | undefined): string | undefined => {
  const digits = digitsOnly(value);
  if (!digits) return undefined;
  return digits.length === 10 || digits.length === 12 ? digits : undefined;
};

const normalizeKpp = (value: string | null | undefined): string | undefined => {
  const digits = digitsOnly(value);
  if (!digits) return undefined;
  return digits.length === 9 ? digits : undefined;
};

const normalizePhone = (value: string | null | undefined): string | undefined => {
  const prepared = normalizeCounterpartyString(value);
  if (!prepared) return undefined;
  const digits = prepared.replace(/\D+/g, '');
  if (digits.length < 6) return undefined;
  return prepared.startsWith('+') ? `+${digits}` : digits;
};

async function touchSession(sessionId: string) {
  await prisma.onecSyncSession.update({
    where: { id: sessionId },
    data: {
      status: OnecSyncSessionStatus.ACCEPTING,
      lastActivityAt: now(),
    },
  });
}

export async function startOnecSyncSession(body: SessionStartBody) {
  const selectedEntities = normalizeSelectedEntities(body.selectedEntities);
  return prisma.onecSyncSession.create({
    data: {
      requestId: randomUUID(),
      status: OnecSyncSessionStatus.STARTED,
      replaceMode: body.replaceMode ?? false,
      selectedEntities: selectedEntities.length
        ? (selectedEntities as unknown as Prisma.InputJsonValue)
        : undefined,
    },
    select: {
      id: true,
      requestId: true,
      status: true,
      replaceMode: true,
      selectedEntities: true,
      startedAt: true,
    },
  });
}

export async function resolveBatchSession(
  entity: BatchEntityCode,
  sessionId?: string
): Promise<{ sessionId: string; implicit: boolean }> {
  if (sessionId) {
    const session = await prisma.onecSyncSession.findUnique({
      where: { id: sessionId },
      select: { id: true },
    });
    if (!session) {
      throw new Error(`Sync session ${sessionId} not found`);
    }
    await touchSession(session.id);
    return { sessionId: session.id, implicit: false };
  }

  const created = await prisma.onecSyncSession.create({
    data: {
      requestId: randomUUID(),
      status: OnecSyncSessionStatus.ACCEPTING,
      replaceMode: false,
      selectedEntities: [entity] as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });

  return { sessionId: created.id, implicit: true };
}

export async function stageNomenclatureBatch(
  sessionId: string,
  items: NomenclatureItem[]
): Promise<BatchResult[]> {
  const importedAt = now();
  await Promise.all(
    items.map((item) =>
      prisma.onecStageNomenclature.upsert({
        where: { sessionId_sourceKey: { sessionId, sourceKey: item.guid } },
        create: {
          sessionId,
          sourceKey: item.guid,
          guid: item.guid,
          parentGuid: item.parentGuid ?? null,
          isGroup: item.isGroup,
          payload: toJsonValue(item),
          payloadHash: hashPayload(item),
          sourceUpdatedAt: item.sourceUpdatedAt ?? null,
          lastImportedAt: importedAt,
          resolveStatus: OnecStageResolveStatus.PENDING,
          lastResolveError: null,
          resolvedAt: null,
        },
        update: {
          parentGuid: item.parentGuid ?? null,
          isGroup: item.isGroup,
          payload: toJsonValue(item),
          payloadHash: hashPayload(item),
          sourceUpdatedAt: item.sourceUpdatedAt ?? null,
          lastImportedAt: importedAt,
          resolveStatus: OnecStageResolveStatus.PENDING,
          lastResolveError: null,
          resolvedAt: null,
        },
      })
    )
  );
  await prisma.onecSyncSession.update({
    where: { id: sessionId },
    data: {
      acceptedCount: { increment: items.length },
      lastActivityAt: importedAt,
    },
  });
  return items.map((item) => ({ key: item.guid, status: 'ok' }));
}

export async function stageWarehousesBatch(
  sessionId: string,
  items: WarehouseItem[]
): Promise<BatchResult[]> {
  const importedAt = now();
  await Promise.all(
    items.map((item) =>
      prisma.onecStageWarehouse.upsert({
        where: { sessionId_sourceKey: { sessionId, sourceKey: item.guid } },
        create: {
          sessionId,
          sourceKey: item.guid,
          guid: item.guid,
          payload: toJsonValue(item),
          payloadHash: hashPayload(item),
          sourceUpdatedAt: item.sourceUpdatedAt ?? null,
          lastImportedAt: importedAt,
          resolveStatus: OnecStageResolveStatus.PENDING,
          lastResolveError: null,
          resolvedAt: null,
        },
        update: {
          payload: toJsonValue(item),
          payloadHash: hashPayload(item),
          sourceUpdatedAt: item.sourceUpdatedAt ?? null,
          lastImportedAt: importedAt,
          resolveStatus: OnecStageResolveStatus.PENDING,
          lastResolveError: null,
          resolvedAt: null,
        },
      })
    )
  );
  await prisma.onecSyncSession.update({
    where: { id: sessionId },
    data: {
      acceptedCount: { increment: items.length },
      lastActivityAt: importedAt,
    },
  });
  return items.map((item) => ({ key: item.guid, status: 'ok' }));
}

export async function stageOrganizationsBatch(
  sessionId: string,
  items: OrganizationItem[]
): Promise<BatchResult[]> {
  const importedAt = now();
  await Promise.all(
    items.map((item) =>
      prisma.onecStageOrganization.upsert({
        where: { sessionId_sourceKey: { sessionId, sourceKey: item.guid } },
        create: {
          sessionId,
          sourceKey: item.guid,
          guid: item.guid,
          payload: toJsonValue(item),
          payloadHash: hashPayload(item),
          sourceUpdatedAt: item.sourceUpdatedAt ?? null,
          lastImportedAt: importedAt,
          resolveStatus: OnecStageResolveStatus.PENDING,
          lastResolveError: null,
          resolvedAt: null,
        },
        update: {
          payload: toJsonValue(item),
          payloadHash: hashPayload(item),
          sourceUpdatedAt: item.sourceUpdatedAt ?? null,
          lastImportedAt: importedAt,
          resolveStatus: OnecStageResolveStatus.PENDING,
          lastResolveError: null,
          resolvedAt: null,
        },
      })
    )
  );
  await prisma.onecSyncSession.update({
    where: { id: sessionId },
    data: {
      acceptedCount: { increment: items.length },
      lastActivityAt: importedAt,
    },
  });
  return items.map((item) => ({ key: item.guid, status: 'ok' }));
}

export async function stageCounterpartiesBatch(
  sessionId: string,
  items: CounterpartyItem[]
): Promise<BatchResult[]> {
  const importedAt = now();
  await Promise.all(
    items.map((item) =>
      prisma.onecStageCounterparty.upsert({
        where: { sessionId_sourceKey: { sessionId, sourceKey: item.guid } },
        create: {
          sessionId,
          sourceKey: item.guid,
          guid: item.guid,
          payload: toJsonValue(item),
          payloadHash: hashPayload(item),
          sourceUpdatedAt: item.sourceUpdatedAt ?? null,
          lastImportedAt: importedAt,
          resolveStatus: OnecStageResolveStatus.PENDING,
          lastResolveError: null,
          resolvedAt: null,
        },
        update: {
          payload: toJsonValue(item),
          payloadHash: hashPayload(item),
          sourceUpdatedAt: item.sourceUpdatedAt ?? null,
          lastImportedAt: importedAt,
          resolveStatus: OnecStageResolveStatus.PENDING,
          lastResolveError: null,
          resolvedAt: null,
        },
      })
    )
  );
  await prisma.onecSyncSession.update({
    where: { id: sessionId },
    data: {
      acceptedCount: { increment: items.length },
      lastActivityAt: importedAt,
    },
  });
  return items.map((item) => ({ key: item.guid, status: 'ok' }));
}

export async function stageContractsBatch(
  sessionId: string,
  items: ContractItem[]
): Promise<BatchResult[]> {
  const importedAt = now();
  await Promise.all(
    items.map((item) =>
      prisma.onecStageContract.upsert({
        where: { sessionId_sourceKey: { sessionId, sourceKey: item.guid } },
        create: {
          sessionId,
          sourceKey: item.guid,
          guid: item.guid,
          counterpartyGuid: item.counterpartyGuid ?? null,
          organizationGuid: item.organizationGuid ?? null,
          payload: toJsonValue(item),
          payloadHash: hashPayload(item),
          sourceUpdatedAt: item.sourceUpdatedAt ?? null,
          lastImportedAt: importedAt,
          resolveStatus: OnecStageResolveStatus.PENDING,
          lastResolveError: null,
          resolvedAt: null,
        },
        update: {
          counterpartyGuid: item.counterpartyGuid ?? null,
          organizationGuid: item.organizationGuid ?? null,
          payload: toJsonValue(item),
          payloadHash: hashPayload(item),
          sourceUpdatedAt: item.sourceUpdatedAt ?? null,
          lastImportedAt: importedAt,
          resolveStatus: OnecStageResolveStatus.PENDING,
          lastResolveError: null,
          resolvedAt: null,
        },
      })
    )
  );
  await prisma.onecSyncSession.update({
    where: { id: sessionId },
    data: {
      acceptedCount: { increment: items.length },
      lastActivityAt: importedAt,
    },
  });
  return items.map((item) => ({ key: item.guid, status: 'ok' }));
}

export async function stageAgreementsBatch(
  sessionId: string,
  items: AgreementItem[]
): Promise<BatchResult[]> {
  const importedAt = now();
  await Promise.all(
    items.map((item) =>
      prisma.onecStageAgreement.upsert({
        where: { sessionId_sourceKey: { sessionId, sourceKey: item.agreement.guid } },
        create: {
          sessionId,
          sourceKey: item.agreement.guid,
          agreementGuid: item.agreement.guid,
          counterpartyGuid: item.agreement.counterpartyGuid ?? item.contract?.counterpartyGuid ?? null,
          contractGuid: item.agreement.contractGuid ?? item.contract?.guid ?? null,
          warehouseGuid: item.agreement.warehouseGuid ?? null,
          priceTypeGuid: item.agreement.priceTypeGuid ?? item.priceType?.guid ?? null,
          payload: toJsonValue(item),
          payloadHash: hashPayload(item),
          sourceUpdatedAt:
            item.agreement.sourceUpdatedAt ??
            item.contract?.sourceUpdatedAt ??
            item.priceType?.sourceUpdatedAt ??
            null,
          lastImportedAt: importedAt,
          resolveStatus: OnecStageResolveStatus.PENDING,
          lastResolveError: null,
          resolvedAt: null,
        },
        update: {
          counterpartyGuid: item.agreement.counterpartyGuid ?? item.contract?.counterpartyGuid ?? null,
          contractGuid: item.agreement.contractGuid ?? item.contract?.guid ?? null,
          warehouseGuid: item.agreement.warehouseGuid ?? null,
          priceTypeGuid: item.agreement.priceTypeGuid ?? item.priceType?.guid ?? null,
          payload: toJsonValue(item),
          payloadHash: hashPayload(item),
          sourceUpdatedAt:
            item.agreement.sourceUpdatedAt ??
            item.contract?.sourceUpdatedAt ??
            item.priceType?.sourceUpdatedAt ??
            null,
          lastImportedAt: importedAt,
          resolveStatus: OnecStageResolveStatus.PENDING,
          lastResolveError: null,
          resolvedAt: null,
        },
      })
    )
  );
  await prisma.onecSyncSession.update({
    where: { id: sessionId },
    data: {
      acceptedCount: { increment: items.length },
      lastActivityAt: importedAt,
    },
  });
  return items.map((item) => ({ key: item.agreement.guid, status: 'ok' }));
}

export async function stageProductPricesBatch(
  sessionId: string,
  items: ProductPriceItem[]
): Promise<BatchResult[]> {
  const importedAt = now();
  const productPriceSourceKey = (item: ProductPriceItem) =>
    optionalGuid(item.guid) ??
    [
      item.productGuid,
      item.characteristicGuid ?? '',
      item.priceTypeGuid ?? item.priceType?.guid ?? '',
      item.packageGuid ?? '',
      item.startDate?.toISOString() ?? '',
    ].join('|');
  await Promise.all(
    items.map((item) => {
      const sourceKey = productPriceSourceKey(item);
      return prisma.onecStageProductPrice.upsert({
        where: { sessionId_sourceKey: { sessionId, sourceKey } },
        create: {
          sessionId,
          sourceKey,
          guid: optionalGuid(item.guid) ?? null,
          productGuid: item.productGuid,
          priceTypeGuid: item.priceTypeGuid ?? null,
          startDate: item.startDate ?? null,
          payload: toJsonValue(item),
          payloadHash: hashPayload(item),
          sourceUpdatedAt: item.sourceUpdatedAt ?? null,
          lastImportedAt: importedAt,
          resolveStatus: OnecStageResolveStatus.PENDING,
          lastResolveError: null,
          resolvedAt: null,
        },
        update: {
          guid: optionalGuid(item.guid) ?? null,
          productGuid: item.productGuid,
          priceTypeGuid: item.priceTypeGuid ?? null,
          startDate: item.startDate ?? null,
          payload: toJsonValue(item),
          payloadHash: hashPayload(item),
          sourceUpdatedAt: item.sourceUpdatedAt ?? null,
          lastImportedAt: importedAt,
          resolveStatus: OnecStageResolveStatus.PENDING,
          lastResolveError: null,
          resolvedAt: null,
        },
      });
    })
  );
  await prisma.onecSyncSession.update({
    where: { id: sessionId },
    data: {
      acceptedCount: { increment: items.length },
      lastActivityAt: importedAt,
    },
  });
  return items.map((item) => ({
    key: productPriceSourceKey(item),
    status: 'ok',
  }));
}

export async function stageSpecialPricesBatch(
  sessionId: string,
  items: SpecialPriceItem[]
): Promise<BatchResult[]> {
  const importedAt = now();
  await Promise.all(
    items.map((item) => {
      const sourceKey =
        optionalGuid(item.guid) ??
        `${item.productGuid}|${item.counterpartyGuid ?? ''}|${item.agreementGuid ?? ''}|${item.priceTypeGuid ?? ''}|${item.startDate?.toISOString() ?? ''}`;
      return prisma.onecStageSpecialPrice.upsert({
        where: { sessionId_sourceKey: { sessionId, sourceKey } },
        create: {
          sessionId,
          sourceKey,
          guid: optionalGuid(item.guid) ?? null,
          productGuid: item.productGuid,
          counterpartyGuid: item.counterpartyGuid ?? null,
          agreementGuid: item.agreementGuid ?? null,
          priceTypeGuid: item.priceTypeGuid ?? null,
          startDate: item.startDate ?? null,
          payload: toJsonValue(item),
          payloadHash: hashPayload(item),
          sourceUpdatedAt: item.sourceUpdatedAt ?? null,
          lastImportedAt: importedAt,
          resolveStatus: OnecStageResolveStatus.PENDING,
          lastResolveError: null,
          resolvedAt: null,
        },
        update: {
          guid: optionalGuid(item.guid) ?? null,
          productGuid: item.productGuid,
          counterpartyGuid: item.counterpartyGuid ?? null,
          agreementGuid: item.agreementGuid ?? null,
          priceTypeGuid: item.priceTypeGuid ?? null,
          startDate: item.startDate ?? null,
          payload: toJsonValue(item),
          payloadHash: hashPayload(item),
          sourceUpdatedAt: item.sourceUpdatedAt ?? null,
          lastImportedAt: importedAt,
          resolveStatus: OnecStageResolveStatus.PENDING,
          lastResolveError: null,
          resolvedAt: null,
        },
      });
    })
  );
  await prisma.onecSyncSession.update({
    where: { id: sessionId },
    data: {
      acceptedCount: { increment: items.length },
      lastActivityAt: importedAt,
    },
  });
  return items.map((item) => ({
    key:
      optionalGuid(item.guid) ??
      `${item.productGuid}|${item.counterpartyGuid ?? ''}|${item.agreementGuid ?? ''}|${item.priceTypeGuid ?? ''}|${item.startDate?.toISOString() ?? ''}`,
    status: 'ok',
  }));
}

export async function stageStockBatch(
  sessionId: string,
  items: StockItem[]
): Promise<BatchResult[]> {
  const importedAt = now();
  await Promise.all(
    items.map((item) => {
      const sourceKey = `${item.productGuid}|${item.warehouseGuid}|${item.organizationGuid}|${item.seriesGuid ?? ''}`;
      return prisma.onecStageStock.upsert({
        where: { sessionId_sourceKey: { sessionId, sourceKey } },
        create: {
          sessionId,
          sourceKey,
          productGuid: item.productGuid,
          warehouseGuid: item.warehouseGuid,
          organizationGuid: item.organizationGuid,
          seriesGuid: item.seriesGuid ?? null,
          seriesNumber: item.seriesNumber ?? null,
          seriesProductionDate: item.seriesProductionDate ?? null,
          seriesExpiresAt: item.seriesExpiresAt ?? null,
          payload: toJsonValue(item),
          payloadHash: hashPayload(item),
          sourceUpdatedAt: item.updatedAt ?? null,
          lastImportedAt: importedAt,
          resolveStatus: OnecStageResolveStatus.PENDING,
          lastResolveError: null,
          resolvedAt: null,
        },
        update: {
          productGuid: item.productGuid,
          warehouseGuid: item.warehouseGuid,
          organizationGuid: item.organizationGuid,
          seriesGuid: item.seriesGuid ?? null,
          seriesNumber: item.seriesNumber ?? null,
          seriesProductionDate: item.seriesProductionDate ?? null,
          seriesExpiresAt: item.seriesExpiresAt ?? null,
          payload: toJsonValue(item),
          payloadHash: hashPayload(item),
          sourceUpdatedAt: item.updatedAt ?? null,
          lastImportedAt: importedAt,
          resolveStatus: OnecStageResolveStatus.PENDING,
          lastResolveError: null,
          resolvedAt: null,
        },
      });
    })
  );
  await prisma.onecSyncSession.update({
    where: { id: sessionId },
    data: {
      acceptedCount: { increment: items.length },
      lastActivityAt: importedAt,
    },
  });
  return items.map((item) => ({
    key: `${item.productGuid}:${item.warehouseGuid}:${item.organizationGuid}:${item.seriesGuid ?? ''}`,
    status: 'ok',
  }));
}

async function clearEntityInTx(tx: TxClient, entity: BatchEntityCode) {
  switch (entity) {
    case 'stock':
      await tx.stockBalance.deleteMany({});
      return;
    case 'organizations':
      await tx.stockBalance.deleteMany({});
      await tx.organization.deleteMany({});
      return;
    case 'special-prices':
      await tx.specialPrice.deleteMany({});
      return;
    case 'product-prices':
      await tx.productPrice.deleteMany({});
      return;
    case 'agreements':
      await tx.specialPrice.deleteMany({ where: { agreementId: { not: null } } });
      await tx.clientAgreement.deleteMany({});
      await tx.priceType.deleteMany({});
      return;
    case 'contracts':
      await tx.clientAgreement.updateMany({ where: { contractId: { not: null } }, data: { contractId: null } });
      await tx.order.updateMany({ where: { contractId: { not: null } }, data: { contractId: null } });
      await tx.counterparty.updateMany({ where: { defaultContractId: { not: null } }, data: { defaultContractId: null } });
      await tx.clientOrderUserCounterpartyDefaults.updateMany({
        where: { contractId: { not: null } },
        data: { contractId: null },
      });
      await tx.clientContract.deleteMany({});
      return;
    case 'counterparties':
      await tx.counterparty.updateMany({
        data: {
          defaultAgreementId: null,
          defaultContractId: null,
          defaultWarehouseId: null,
          defaultDeliveryAddressId: null,
        },
      });
      await tx.specialPrice.deleteMany({ where: { counterpartyId: { not: null } } });
      await tx.clientAgreement.deleteMany({});
      await tx.clientContract.deleteMany({});
      await tx.deliveryAddress.deleteMany({});
      await tx.counterparty.deleteMany({});
      return;
    case 'warehouses':
      await tx.stockBalance.deleteMany({});
      await tx.clientAgreement.deleteMany({ where: { warehouseId: { not: null } } });
      await tx.warehouse.deleteMany({});
      return;
    case 'nomenclature':
      await tx.stockBalance.deleteMany({});
      await tx.specialPrice.deleteMany({});
      await tx.productPrice.deleteMany({});
      await tx.productPackage.deleteMany({});
      await tx.product.deleteMany({});
      await tx.productGroup.deleteMany({});
      return;
  }
}

async function applyStagedNomenclature(
  tx: TxClient,
  sessionId: string,
  syncedAt: Date
): Promise<ApplySummary> {
  const stages = await tx.onecStageNomenclature.findMany({
    where: { sessionId },
    orderBy: [{ isGroup: 'desc' }, { lastImportedAt: 'asc' }],
  });
  const summary: ApplySummary = { resolvedStageIds: [], blocked: [], errors: [] };
  const groups = stages.filter((item) => item.isGroup);
  const products = stages.filter((item) => !item.isGroup);
  const resolvedGroupGuids = new Set<string>();
  const pendingGroups = [...groups];

  while (pendingGroups.length > 0) {
    let progressed = false;
    for (let index = pendingGroups.length - 1; index >= 0; index -= 1) {
      const stage = pendingGroups[index];
      const item = stage.payload as unknown as NomenclatureItem;
      if (item.parentGuid && !resolvedGroupGuids.has(item.parentGuid)) {
        const parentExists = await tx.productGroup.findUnique({
          where: { guid: item.parentGuid },
          select: { id: true },
        });
        if (!parentExists) {
          continue;
        }
      }

      try {
        let parentId: string | null = null;
        if (item.parentGuid) {
          const parent = await tx.productGroup.findUnique({
            where: { guid: item.parentGuid },
            select: { id: true },
          });
          parentId = parent?.id ?? null;
        }

        await tx.productGroup.upsert({
          where: { guid: item.guid },
          create: {
            guid: item.guid,
            name: item.name,
            code: item.code,
            isActive: item.isActive ?? true,
            parentId,
            sourceUpdatedAt: item.sourceUpdatedAt ?? syncedAt,
            lastSyncedAt: syncedAt,
          },
          update: {
            name: item.name,
            code: item.code,
            isActive: item.isActive ?? true,
            parentId,
            sourceUpdatedAt: item.sourceUpdatedAt ?? syncedAt,
            lastSyncedAt: syncedAt,
          },
        });

        resolvedGroupGuids.add(item.guid);
        summary.resolvedStageIds.push(stage.id);
        pendingGroups.splice(index, 1);
        progressed = true;
      } catch (error) {
        summary.errors.push({
          stageId: stage.id,
          message: error instanceof Error ? error.message : 'Failed to apply group',
        });
        pendingGroups.splice(index, 1);
      }
    }

    if (!progressed) {
      break;
    }
  }

  for (const stage of pendingGroups) {
    const item = stage.payload as unknown as NomenclatureItem;
    summary.blocked.push({ stageId: stage.id, message: `Parent group ${item.parentGuid} not found` });
  }

  for (const stage of products) {
    const item = stage.payload as unknown as NomenclatureItem;
    try {
      let groupId: string | null = null;
      if (item.parentGuid) {
        const group = await tx.productGroup.findUnique({
          where: { guid: item.parentGuid },
          select: { id: true },
        });
        if (!group) {
          summary.blocked.push({ stageId: stage.id, message: `Group ${item.parentGuid} not found` });
          continue;
        }
        groupId = group.id;
      }

      let baseUnitId: string | null = null;
      if (item.baseUnit) {
        const unit = await tx.unit.upsert({
          where: { guid: item.baseUnit.guid },
          create: {
            guid: item.baseUnit.guid,
            name: item.baseUnit.name,
            code: item.baseUnit.code,
            symbol: item.baseUnit.symbol,
            sourceUpdatedAt: item.baseUnit.sourceUpdatedAt ?? item.sourceUpdatedAt ?? syncedAt,
            lastSyncedAt: syncedAt,
          },
          update: {
            name: item.baseUnit.name,
            code: item.baseUnit.code,
            symbol: item.baseUnit.symbol,
            sourceUpdatedAt: item.baseUnit.sourceUpdatedAt ?? item.sourceUpdatedAt ?? syncedAt,
            lastSyncedAt: syncedAt,
          },
          select: { id: true },
        });
        baseUnitId = unit.id;
      }

      const product = await tx.product.upsert({
        where: { guid: item.guid },
        create: {
          guid: item.guid,
          name: item.name,
          code: item.code,
          article: item.article,
          sku: item.sku,
          isWeight: item.isWeight ?? false,
          isService: item.isService ?? false,
          isActive: item.isActive ?? true,
          groupId,
          baseUnitId,
          sourceUpdatedAt: item.sourceUpdatedAt ?? syncedAt,
          lastSyncedAt: syncedAt,
        },
        update: {
          name: item.name,
          code: item.code,
          article: item.article,
          sku: item.sku,
          isWeight: item.isWeight ?? false,
          isService: item.isService ?? false,
          isActive: item.isActive ?? true,
          groupId,
          baseUnitId,
          sourceUpdatedAt: item.sourceUpdatedAt ?? syncedAt,
          lastSyncedAt: syncedAt,
        },
        select: { id: true },
      });

      if (item.packages?.length) {
        for (const pack of item.packages) {
          const unit = await tx.unit.upsert({
            where: { guid: pack.unit.guid },
            create: {
              guid: pack.unit.guid,
              name: pack.unit.name,
              code: pack.unit.code,
              symbol: pack.unit.symbol,
              sourceUpdatedAt:
                pack.unit.sourceUpdatedAt ?? pack.sourceUpdatedAt ?? item.sourceUpdatedAt ?? syncedAt,
              lastSyncedAt: syncedAt,
            },
            update: {
              name: pack.unit.name,
              code: pack.unit.code,
              symbol: pack.unit.symbol,
              sourceUpdatedAt:
                pack.unit.sourceUpdatedAt ?? pack.sourceUpdatedAt ?? item.sourceUpdatedAt ?? syncedAt,
              lastSyncedAt: syncedAt,
            },
            select: { id: true },
          });

          const packageData = {
            productId: product.id,
            unitId: unit.id,
            name: pack.name,
            multiplier: toDecimal(pack.multiplier) ?? new Prisma.Decimal(1),
            barcode: pack.barcode,
            isDefault: pack.isDefault ?? false,
            sortOrder: pack.sortOrder ?? 0,
            sourceUpdatedAt: pack.sourceUpdatedAt ?? item.sourceUpdatedAt ?? syncedAt,
            lastSyncedAt: syncedAt,
          };

          if (pack.guid) {
            await tx.productPackage.upsert({
              where: { guid: pack.guid },
              create: { ...packageData, guid: pack.guid },
              update: packageData,
            });
          } else {
            await tx.productPackage.create({ data: packageData });
          }
        }
      }

      summary.resolvedStageIds.push(stage.id);
    } catch (error) {
      summary.errors.push({
        stageId: stage.id,
        message: error instanceof Error ? error.message : 'Failed to apply product',
      });
    }
  }

  return summary;
}

async function applyStagedWarehouses(tx: TxClient, sessionId: string, syncedAt: Date): Promise<ApplySummary> {
  const stages = await tx.onecStageWarehouse.findMany({ where: { sessionId }, orderBy: { lastImportedAt: 'asc' } });
  const summary: ApplySummary = { resolvedStageIds: [], blocked: [], errors: [] };

  for (const stage of stages) {
    const item = stage.payload as unknown as WarehouseItem;
    try {
      await tx.warehouse.upsert({
        where: { guid: item.guid },
        create: {
          guid: item.guid,
          name: item.name,
          code: item.code,
          isActive: item.isActive ?? true,
          isDefault: item.isDefault ?? false,
          isPickup: item.isPickup ?? false,
          address: item.address ?? undefined,
          sourceUpdatedAt: item.sourceUpdatedAt ?? syncedAt,
          lastSyncedAt: syncedAt,
        },
        update: {
          name: item.name,
          code: item.code,
          isActive: item.isActive ?? true,
          isDefault: item.isDefault ?? false,
          isPickup: item.isPickup ?? false,
          address: item.address ?? undefined,
          sourceUpdatedAt: item.sourceUpdatedAt ?? syncedAt,
          lastSyncedAt: syncedAt,
        },
      });
      summary.resolvedStageIds.push(stage.id);
    } catch (error) {
      summary.errors.push({
        stageId: stage.id,
        message: error instanceof Error ? error.message : 'Failed to apply warehouse',
      });
    }
  }

  return summary;
}

async function applyStagedCounterparties(
  tx: TxClient,
  sessionId: string,
  syncedAt: Date
): Promise<ApplySummary> {
  const stages = await tx.onecStageCounterparty.findMany({
    where: { sessionId },
    orderBy: { lastImportedAt: 'asc' },
  });
  const summary: ApplySummary = { resolvedStageIds: [], blocked: [], errors: [] };

  for (const stage of stages) {
    const item = stage.payload as unknown as CounterpartyItem;
    try {
      const counterpartyData = {
        name: item.name,
        fullName: item.fullName ?? null,
        inn: normalizeInn(item.inn),
        kpp: normalizeKpp(item.kpp),
        phone: normalizePhone(item.phone),
        email: normalizeCounterpartyString(item.email),
        dataVersion: item.dataVersion ?? null,
        isSeparateSubdivision: item.isSeparateSubdivision ?? null,
        legalEntityType: item.legalEntityType ?? null,
        legalOrIndividualType: item.legalOrIndividualType ?? null,
        registrationCountryGuid: item.registrationCountryGuid ?? null,
        headCounterpartyGuid: item.headCounterpartyGuid ?? null,
        additionalInfo: item.additionalInfo ?? null,
        partnerGuid: item.partnerGuid ?? null,
        vatByRates4And2: item.vatByRates4And2 ?? null,
        okpoCode: item.okpoCode ?? null,
        registrationNumber: item.registrationNumber ?? null,
        taxNumber: item.taxNumber ?? null,
        internationalName: item.internationalName ?? null,
        isPredefined: item.isPredefined ?? null,
        predefinedDataName: item.predefinedDataName ?? null,
        isActive: item.isActive ?? true,
        sourceUpdatedAt: item.sourceUpdatedAt ?? syncedAt,
        lastSyncedAt: syncedAt,
      };
      const counterparty = await tx.counterparty.upsert({
        where: { guid: item.guid },
        create: { guid: item.guid, ...counterpartyData },
        update: counterpartyData,
        select: { id: true },
      });

      if (item.addresses?.length) {
        for (const address of item.addresses) {
          const addressGuid = address.guid?.trim() || null;
          const addressData = {
            counterpartyId: counterparty.id,
            guid: addressGuid,
            name: address.name ?? null,
            fullAddress: address.fullAddress,
            city: address.city ?? null,
            street: address.street ?? null,
            house: address.house ?? null,
            building: address.building ?? null,
            apartment: address.apartment ?? null,
            postcode: address.postcode ?? null,
            isDefault: address.isDefault ?? false,
            isActive: address.isActive ?? true,
            sourceUpdatedAt: address.sourceUpdatedAt ?? item.sourceUpdatedAt ?? syncedAt,
            lastSyncedAt: syncedAt,
          };

          if (addressGuid) {
            await tx.deliveryAddress.upsert({
              where: { guid: addressGuid },
              create: addressData,
              update: addressData,
            });
          } else {
            await tx.deliveryAddress.create({ data: addressData });
          }
        }
      }

      summary.resolvedStageIds.push(stage.id);
    } catch (error) {
      summary.errors.push({
        stageId: stage.id,
        message: error instanceof Error ? error.message : 'Failed to apply counterparty',
      });
    }
  }

  return summary;
}

async function applyStagedAgreements(tx: TxClient, sessionId: string, syncedAt: Date): Promise<ApplySummary> {
  const stages = await tx.onecStageAgreement.findMany({ where: { sessionId }, orderBy: { lastImportedAt: 'asc' } });
  const summary: ApplySummary = { resolvedStageIds: [], blocked: [], errors: [] };

  for (const stage of stages) {
    const item = stage.payload as unknown as AgreementItem;
    try {
      let counterpartyId: string | null = null;
      const counterpartyGuid = item.agreement.counterpartyGuid ?? item.contract?.counterpartyGuid;
      if (counterpartyGuid) {
        const counterparty = await tx.counterparty.findUnique({
          where: { guid: counterpartyGuid },
          select: { id: true },
        });
        if (!counterparty) {
          summary.blocked.push({ stageId: stage.id, message: `Counterparty ${counterpartyGuid} not found` });
          continue;
        }
        counterpartyId = counterparty.id;
      }

      let organizationId: string | null = null;
      if (item.agreement.organizationGuid) {
        const organization = await tx.organization.findUnique({
          where: { guid: item.agreement.organizationGuid },
          select: { id: true },
        });
        if (!organization) {
          summary.blocked.push({ stageId: stage.id, message: `Organization ${item.agreement.organizationGuid} not found` });
          continue;
        }
        organizationId = organization.id;
      }

      let priceTypeId: string | null = null;
      if (item.priceType) {
        const priceType = await tx.priceType.upsert({
          where: { guid: item.priceType.guid },
          create: {
            guid: item.priceType.guid,
            name: item.priceType.name,
            code: item.priceType.code,
            isActive: item.priceType.isActive ?? true,
            sourceUpdatedAt: item.priceType.sourceUpdatedAt ?? syncedAt,
            lastSyncedAt: syncedAt,
          },
          update: {
            name: item.priceType.name,
            code: item.priceType.code,
            isActive: item.priceType.isActive ?? true,
            sourceUpdatedAt: item.priceType.sourceUpdatedAt ?? syncedAt,
            lastSyncedAt: syncedAt,
          },
          select: { id: true },
        });
        priceTypeId = priceType.id;
      } else if (item.agreement.priceTypeGuid) {
        const priceType = await tx.priceType.findUnique({
          where: { guid: item.agreement.priceTypeGuid },
          select: { id: true },
        });
        if (!priceType) {
          summary.blocked.push({ stageId: stage.id, message: `Price type ${item.agreement.priceTypeGuid} not found` });
          continue;
        }
        priceTypeId = priceType.id;
      }

      let contractId: string | null = null;
      if (item.contract) {
        if (!counterpartyId) {
          summary.blocked.push({ stageId: stage.id, message: `Counterparty ${item.contract.counterpartyGuid} not found` });
          continue;
        }
        let contractOrganizationId = organizationId;
        if (item.contract.organizationGuid && item.contract.organizationGuid !== item.agreement.organizationGuid) {
          const contractOrganization = await tx.organization.findUnique({
            where: { guid: item.contract.organizationGuid },
            select: { id: true },
          });
          if (!contractOrganization) {
            summary.blocked.push({ stageId: stage.id, message: `Organization ${item.contract.organizationGuid} not found` });
            continue;
          }
          contractOrganizationId = contractOrganization.id;
        }
        const contractData = {
          counterpartyId,
          organizationId: contractOrganizationId,
          dataVersion: item.contract.dataVersion ?? null,
          name: item.contract.name ?? null,
          printName: item.contract.printName ?? null,
          number: item.contract.number,
          date: item.contract.date,
          validFrom: item.contract.validFrom ?? null,
          validTo: item.contract.validTo ?? null,
          partnerGuid: item.contract.partnerGuid ?? null,
          bankAccountGuid: item.contract.bankAccountGuid ?? null,
          counterpartyBankAccountGuid: item.contract.counterpartyBankAccountGuid ?? null,
          contactPersonGuid: item.contract.contactPersonGuid ?? null,
          departmentGuid: item.contract.departmentGuid ?? null,
          managerGuid: item.contract.managerGuid ?? null,
          cashFlowItemGuid: item.contract.cashFlowItemGuid ?? null,
          businessOperation: item.contract.businessOperation ?? null,
          financialAccountingGroupGuid: item.contract.financialAccountingGroupGuid ?? null,
          activityDirectionGuid: item.contract.activityDirectionGuid ?? null,
          currency: item.contract.currency ?? null,
          currencyGuid: item.contract.currencyGuid ?? null,
          status: item.contract.status ?? null,
          contractType: item.contract.contractType ?? null,
          purpose: item.contract.purpose ?? null,
          isAgreed: item.contract.isAgreed ?? null,
          hasPaymentTerm: item.contract.hasPaymentTerm ?? null,
          paymentTermDays: item.contract.paymentTermDays ?? null,
          settlementProcedure: item.contract.settlementProcedure ?? null,
          limitDebtAmount: item.contract.limitDebtAmount ?? null,
          amount: toNullableDecimal(item.contract.amount),
          allowedDebtAmount: toNullableDecimal(item.contract.allowedDebtAmount),
          forbidOverdueDebt: item.contract.forbidOverdueDebt ?? null,
          vatTaxation: item.contract.vatTaxation ?? null,
          vatRate: item.contract.vatRate ?? null,
          vatDefinedInDocument: item.contract.vatDefinedInDocument ?? null,
          deliveryMethod: item.contract.deliveryMethod ?? null,
          carrierPartnerGuid: item.contract.carrierPartnerGuid ?? null,
          deliveryZoneGuid: item.contract.deliveryZoneGuid ?? null,
          deliveryTimeFrom: item.contract.deliveryTimeFrom ?? null,
          deliveryTimeTo: item.contract.deliveryTimeTo ?? null,
          deliveryAddress: item.contract.deliveryAddress ?? null,
          deliveryAddressFields: item.contract.deliveryAddressFields ?? null,
          additionalDeliveryInfo: item.contract.additionalDeliveryInfo ?? null,
          isActive: (item.contract.isActive ?? true) && !isClosedContractStatus(item.contract.status),
          comment: item.contract.comment ?? null,
          sourceUpdatedAt: item.contract.sourceUpdatedAt ?? syncedAt,
          lastSyncedAt: syncedAt,
        };
        const contract = await tx.clientContract.upsert({
          where: { guid: item.contract.guid },
          create: { guid: item.contract.guid, ...contractData },
          update: contractData,
          select: { id: true },
        });
        contractId = contract.id;
      } else if (item.agreement.contractGuid) {
        const contract = await tx.clientContract.findUnique({
          where: { guid: item.agreement.contractGuid },
          select: { id: true },
        });
        if (!contract) {
          summary.blocked.push({ stageId: stage.id, message: `Contract ${item.agreement.contractGuid} not found` });
          continue;
        }
        contractId = contract.id;
      }

      let warehouseId: string | null = null;
      if (item.agreement.warehouseGuid) {
        const warehouse = await tx.warehouse.findUnique({
          where: { guid: item.agreement.warehouseGuid },
          select: { id: true },
        });
        if (!warehouse) {
          summary.blocked.push({ stageId: stage.id, message: `Warehouse ${item.agreement.warehouseGuid} not found` });
          continue;
        }
        warehouseId = warehouse.id;
      }

      const agreementData = {
        name: item.agreement.name,
        number: item.agreement.number ?? null,
        date: item.agreement.date ?? null,
        counterpartyId,
        organizationId,
        contractId,
        priceTypeId,
        warehouseId,
        currency: item.agreement.currency ?? null,
        dataVersion: item.agreement.dataVersion ?? null,
        partnerGuid: item.agreement.partnerGuid ?? null,
        partnerSegmentGuid: item.agreement.partnerSegmentGuid ?? null,
        paymentScheduleGuid: item.agreement.paymentScheduleGuid ?? null,
        documentAmount: toNullableDecimal(item.agreement.documentAmount),
        isTemplate: item.agreement.isTemplate ?? null,
        deliveryTerm: item.agreement.deliveryTerm ?? null,
        priceIncludesVat: item.agreement.priceIncludesVat ?? null,
        usedBySalesRepresentatives: item.agreement.usedBySalesRepresentatives ?? null,
        parentAgreementGuid: item.agreement.parentAgreementGuid ?? null,
        nomenclatureSegmentGuid: item.agreement.nomenclatureSegmentGuid ?? null,
        validFrom: item.agreement.validFrom ?? null,
        validTo: item.agreement.validTo ?? null,
        comment: item.agreement.comment ?? null,
        isRegular: item.agreement.isRegular ?? null,
        period: item.agreement.period ?? null,
        periodCount: item.agreement.periodCount ?? null,
        status: item.agreement.status ?? null,
        isAgreed: item.agreement.isAgreed ?? null,
        managerGuid: item.agreement.managerGuid ?? null,
        businessOperation: item.agreement.businessOperation ?? null,
        manualDiscountPercent: toNullableDecimal(item.agreement.manualDiscountPercent),
        manualMarkupPercent: toNullableDecimal(item.agreement.manualMarkupPercent),
        availableForExternalUsers: item.agreement.availableForExternalUsers ?? null,
        usesCounterpartyContracts: item.agreement.usesCounterpartyContracts ?? null,
        limitManualDiscounts: item.agreement.limitManualDiscounts ?? null,
        paymentForm: item.agreement.paymentForm ?? null,
        contactPersonGuid: item.agreement.contactPersonGuid ?? null,
        settlementProcedure: item.agreement.settlementProcedure ?? null,
        priceCalculationVariant: item.agreement.priceCalculationVariant ?? null,
        minOrderAmount: toNullableDecimal(item.agreement.minOrderAmount),
        orderFrequency: item.agreement.orderFrequency ?? null,
        individualPriceTypeGuid: item.agreement.individualPriceTypeGuid ?? null,
        settlementCurrency: item.agreement.settlementCurrency ?? null,
        paymentInCurrency: item.agreement.paymentInCurrency ?? null,
        financialAccountingGroupGuid: item.agreement.financialAccountingGroupGuid ?? null,
        cashFlowItemGuid: item.agreement.cashFlowItemGuid ?? null,
        activityDirectionGuid: item.agreement.activityDirectionGuid ?? null,
        isActive: (item.agreement.isActive ?? true) && !isClosedAgreementStatus(item.agreement.status),
        sourceUpdatedAt: item.agreement.sourceUpdatedAt ?? syncedAt,
        lastSyncedAt: syncedAt,
      };
      await tx.clientAgreement.upsert({
        where: { guid: item.agreement.guid },
        create: { guid: item.agreement.guid, ...agreementData },
        update: agreementData,
      });

      summary.resolvedStageIds.push(stage.id);
    } catch (error) {
      summary.errors.push({
        stageId: stage.id,
        message: error instanceof Error ? error.message : 'Failed to apply agreement',
      });
    }
  }

  return summary;
}

async function applyStagedContracts(tx: TxClient, sessionId: string, syncedAt: Date): Promise<ApplySummary> {
  const stages = await tx.onecStageContract.findMany({ where: { sessionId }, orderBy: { lastImportedAt: 'asc' } });
  const summary: ApplySummary = { resolvedStageIds: [], blocked: [], errors: [] };

  for (const stage of stages) {
    const item = stage.payload as unknown as ContractItem;
    try {
      const counterparty = await tx.counterparty.findUnique({
        where: { guid: item.counterpartyGuid },
        select: { id: true },
      });
      if (!counterparty) {
        summary.blocked.push({ stageId: stage.id, message: `Counterparty ${item.counterpartyGuid} not found` });
        continue;
      }

      let organizationId: string | null = null;
      if (item.organizationGuid) {
        const organization = await tx.organization.findUnique({
          where: { guid: item.organizationGuid },
          select: { id: true },
        });
        if (!organization) {
          summary.blocked.push({ stageId: stage.id, message: `Organization ${item.organizationGuid} not found` });
          continue;
        }
        organizationId = organization.id;
      }

      const data = {
        counterpartyId: counterparty.id,
        organizationId,
        dataVersion: item.dataVersion ?? null,
        name: item.name ?? null,
        printName: item.printName ?? null,
        number: item.number,
        date: item.date,
        validFrom: item.validFrom ?? null,
        validTo: item.validTo ?? null,
        partnerGuid: item.partnerGuid ?? null,
        bankAccountGuid: item.bankAccountGuid ?? null,
        counterpartyBankAccountGuid: item.counterpartyBankAccountGuid ?? null,
        contactPersonGuid: item.contactPersonGuid ?? null,
        departmentGuid: item.departmentGuid ?? null,
        managerGuid: item.managerGuid ?? null,
        cashFlowItemGuid: item.cashFlowItemGuid ?? null,
        businessOperation: item.businessOperation ?? null,
        financialAccountingGroupGuid: item.financialAccountingGroupGuid ?? null,
        activityDirectionGuid: item.activityDirectionGuid ?? null,
        currency: item.currency ?? null,
        currencyGuid: item.currencyGuid ?? null,
        status: item.status ?? null,
        contractType: item.contractType ?? null,
        purpose: item.purpose ?? null,
        isAgreed: item.isAgreed ?? null,
        hasPaymentTerm: item.hasPaymentTerm ?? null,
        paymentTermDays: item.paymentTermDays ?? null,
        settlementProcedure: item.settlementProcedure ?? null,
        limitDebtAmount: item.limitDebtAmount ?? null,
        amount: toNullableDecimal(item.amount),
        allowedDebtAmount: toNullableDecimal(item.allowedDebtAmount),
        forbidOverdueDebt: item.forbidOverdueDebt ?? null,
        vatTaxation: item.vatTaxation ?? null,
        vatRate: item.vatRate ?? null,
        vatDefinedInDocument: item.vatDefinedInDocument ?? null,
        deliveryMethod: item.deliveryMethod ?? null,
        carrierPartnerGuid: item.carrierPartnerGuid ?? null,
        deliveryZoneGuid: item.deliveryZoneGuid ?? null,
        deliveryTimeFrom: item.deliveryTimeFrom ?? null,
        deliveryTimeTo: item.deliveryTimeTo ?? null,
        deliveryAddress: item.deliveryAddress ?? null,
        deliveryAddressFields: item.deliveryAddressFields ?? null,
        additionalDeliveryInfo: item.additionalDeliveryInfo ?? null,
        isActive: (item.isActive ?? true) && !isClosedContractStatus(item.status),
        comment: item.comment ?? null,
        sourceUpdatedAt: item.sourceUpdatedAt ?? syncedAt,
        lastSyncedAt: syncedAt,
      };

      await tx.clientContract.upsert({
        where: { guid: item.guid },
        create: { guid: item.guid, ...data },
        update: data,
      });

      summary.resolvedStageIds.push(stage.id);
    } catch (error) {
      summary.errors.push({
        stageId: stage.id,
        message: error instanceof Error ? error.message : 'Failed to apply contract',
      });
    }
  }

  return summary;
}

async function applyCounterpartyDefaultLinks(
  tx: TxClient,
  sessionId: string,
  syncedAt: Date
): Promise<ApplySummary> {
  const stages = await tx.onecStageCounterparty.findMany({
    where: { sessionId },
    orderBy: { lastImportedAt: 'asc' },
  });
  const summary: ApplySummary = emptyApplySummary();

  for (const stage of stages) {
    const item = stage.payload as unknown as CounterpartyItem;
    try {
      const counterparty = await tx.counterparty.findUnique({
        where: { guid: item.guid },
        select: { id: true },
      });

      if (!counterparty) {
        summary.blocked.push({ stageId: stage.id, message: `Counterparty ${item.guid} not found` });
        continue;
      }

      const hasDefaultField = (field: keyof CounterpartyItem) => Object.prototype.hasOwnProperty.call(item, field);
      const updateData: Prisma.CounterpartyUncheckedUpdateInput = { lastSyncedAt: syncedAt };

      if (hasDefaultField('defaultAgreementGuid')) {
        let defaultAgreementId: string | null = null;
        if (item.defaultAgreementGuid) {
          const agreement = await tx.clientAgreement.findUnique({
            where: { guid: item.defaultAgreementGuid },
            select: { id: true },
          });
          if (!agreement) {
            summary.blocked.push({ stageId: stage.id, message: `Default agreement ${item.defaultAgreementGuid} not found` });
            continue;
          }
          defaultAgreementId = agreement.id;
        }
        updateData.defaultAgreementId = defaultAgreementId;
      }

      if (hasDefaultField('defaultContractGuid')) {
        let defaultContractId: string | null = null;
        if (item.defaultContractGuid) {
          const contract = await tx.clientContract.findUnique({
            where: { guid: item.defaultContractGuid },
            select: { id: true },
          });
          if (!contract) {
            summary.blocked.push({ stageId: stage.id, message: `Default contract ${item.defaultContractGuid} not found` });
            continue;
          }
          defaultContractId = contract.id;
        }
        updateData.defaultContractId = defaultContractId;
      }

      if (hasDefaultField('defaultWarehouseGuid')) {
        let defaultWarehouseId: string | null = null;
        if (item.defaultWarehouseGuid) {
          const warehouse = await tx.warehouse.findUnique({
            where: { guid: item.defaultWarehouseGuid },
            select: { id: true },
          });
          if (!warehouse) {
            summary.blocked.push({ stageId: stage.id, message: `Default warehouse ${item.defaultWarehouseGuid} not found` });
            continue;
          }
          defaultWarehouseId = warehouse.id;
        }
        updateData.defaultWarehouseId = defaultWarehouseId;
      }

      if (hasDefaultField('defaultDeliveryAddressGuid')) {
        let defaultDeliveryAddressId: string | null = null;
        if (item.defaultDeliveryAddressGuid) {
          const deliveryAddress = await tx.deliveryAddress.findFirst({
            where: {
              guid: item.defaultDeliveryAddressGuid,
              counterpartyId: counterparty.id,
            },
            select: { id: true },
          });
          if (!deliveryAddress) {
            summary.blocked.push({
              stageId: stage.id,
              message: `Default delivery address ${item.defaultDeliveryAddressGuid} not found`,
            });
            continue;
          }
          defaultDeliveryAddressId = deliveryAddress.id;
        }
        updateData.defaultDeliveryAddressId = defaultDeliveryAddressId;
      }

      await tx.counterparty.update({
        where: { id: counterparty.id },
        data: updateData,
      });

      summary.resolvedStageIds.push(stage.id);
    } catch (error) {
      summary.errors.push({
        stageId: stage.id,
        message: error instanceof Error ? error.message : 'Failed to apply counterparty default links',
      });
    }
  }

  return summary;
}

async function applyStagedProductPrices(
  tx: TxClient,
  sessionId: string,
  syncedAt: Date
): Promise<ApplySummary> {
  const stages = await tx.onecStageProductPrice.findMany({
    where: { sessionId },
    orderBy: { lastImportedAt: 'asc' },
  });
  const summary: ApplySummary = { resolvedStageIds: [], blocked: [], errors: [] };

  for (const stage of stages) {
    const item = stage.payload as unknown as ProductPriceItem;
    try {
      const product = await tx.product.findUnique({ where: { guid: item.productGuid }, select: { id: true } });
      if (!product) {
        summary.blocked.push({ stageId: stage.id, message: `Product ${item.productGuid} not found` });
        continue;
      }

      let priceTypeId: string | null = null;
      if (item.priceType) {
        const priceType = await tx.priceType.upsert({
          where: { guid: item.priceType.guid },
          create: {
            guid: item.priceType.guid,
            name: item.priceType.name,
            code: item.priceType.code,
            isActive: item.priceType.isActive ?? true,
            sourceUpdatedAt: item.priceType.sourceUpdatedAt ?? syncedAt,
            lastSyncedAt: syncedAt,
          },
          update: {
            name: item.priceType.name,
            code: item.priceType.code,
            isActive: item.priceType.isActive ?? true,
            sourceUpdatedAt: item.priceType.sourceUpdatedAt ?? syncedAt,
            lastSyncedAt: syncedAt,
          },
          select: { id: true },
        });
        priceTypeId = priceType.id;
      } else if (item.priceTypeGuid) {
        const priceType = await tx.priceType.findUnique({
          where: { guid: item.priceTypeGuid },
          select: { id: true },
        });
        if (!priceType) {
          summary.blocked.push({ stageId: stage.id, message: `Price type ${item.priceTypeGuid} not found` });
          continue;
        }
        priceTypeId = priceType.id;
      }

      const data = {
        productId: product.id,
        priceTypeId,
        price: toDecimal(item.price) ?? new Prisma.Decimal(0),
        currency: item.currency ?? undefined,
        startDate: item.startDate ?? null,
        endDate: item.endDate ?? null,
        minQty: toDecimal(item.minQty),
        isActive: item.isActive ?? true,
        sourceUpdatedAt: item.sourceUpdatedAt ?? item.startDate ?? syncedAt,
        lastSyncedAt: syncedAt,
      };

      const itemGuid = optionalGuid(item.guid);
      const where: Prisma.ProductPriceWhereUniqueInput = itemGuid
        ? { guid: itemGuid }
        : ({
            productId_priceTypeId_startDate: {
              productId: product.id,
              priceTypeId,
              startDate: item.startDate ?? null,
            },
          } as Prisma.ProductPriceWhereUniqueInput);

      await tx.productPrice.upsert({
        where,
        create: { guid: itemGuid ?? null, ...data },
        update: data,
      });

      summary.resolvedStageIds.push(stage.id);
    } catch (error) {
      summary.errors.push({
        stageId: stage.id,
        message: error instanceof Error ? error.message : 'Failed to apply product price',
      });
    }
  }

  return summary;
}

async function applyStagedSpecialPrices(
  tx: TxClient,
  sessionId: string,
  syncedAt: Date
): Promise<ApplySummary> {
  const stages = await tx.onecStageSpecialPrice.findMany({
    where: { sessionId },
    orderBy: { lastImportedAt: 'asc' },
  });
  const summary: ApplySummary = { resolvedStageIds: [], blocked: [], errors: [] };

  for (const stage of stages) {
    const item = stage.payload as unknown as SpecialPriceItem;
    try {
      const product = await tx.product.findUnique({ where: { guid: item.productGuid }, select: { id: true } });
      if (!product) {
        summary.blocked.push({ stageId: stage.id, message: `Product ${item.productGuid} not found` });
        continue;
      }

      let counterpartyId: string | null = null;
      if (item.counterpartyGuid) {
        const counterparty = await tx.counterparty.findUnique({
          where: { guid: item.counterpartyGuid },
          select: { id: true },
        });
        if (!counterparty) {
          summary.blocked.push({ stageId: stage.id, message: `Counterparty ${item.counterpartyGuid} not found` });
          continue;
        }
        counterpartyId = counterparty.id;
      }

      let agreementId: string | null = null;
      if (item.agreementGuid) {
        const agreement = await tx.clientAgreement.findUnique({
          where: { guid: item.agreementGuid },
          select: { id: true },
        });
        if (!agreement) {
          summary.blocked.push({ stageId: stage.id, message: `Agreement ${item.agreementGuid} not found` });
          continue;
        }
        agreementId = agreement.id;
      }

      let priceTypeId: string | null = null;
      if (item.priceTypeGuid) {
        const priceType = await tx.priceType.findUnique({
          where: { guid: item.priceTypeGuid },
          select: { id: true },
        });
        if (!priceType) {
          summary.blocked.push({ stageId: stage.id, message: `Price type ${item.priceTypeGuid} not found` });
          continue;
        }
        priceTypeId = priceType.id;
      }

      const data = {
        productId: product.id,
        counterpartyId,
        agreementId,
        priceTypeId,
        price: toDecimal(item.price) ?? new Prisma.Decimal(0),
        currency: item.currency ?? undefined,
        startDate: item.startDate ?? null,
        endDate: item.endDate ?? null,
        minQty: toDecimal(item.minQty),
        isActive: item.isActive ?? true,
        sourceUpdatedAt: item.sourceUpdatedAt ?? syncedAt,
        lastSyncedAt: syncedAt,
      };

      const itemGuid = optionalGuid(item.guid);
      const where: Prisma.SpecialPriceWhereUniqueInput = itemGuid
        ? { guid: itemGuid }
        : ({
            productId_counterpartyId_agreementId_priceTypeId_startDate: {
              productId: product.id,
              counterpartyId,
              agreementId,
              priceTypeId,
              startDate: item.startDate ?? null,
            },
          } as Prisma.SpecialPriceWhereUniqueInput);

      await tx.specialPrice.upsert({
        where,
        create: { guid: itemGuid ?? null, ...data },
        update: data,
      });

      summary.resolvedStageIds.push(stage.id);
    } catch (error) {
      summary.errors.push({
        stageId: stage.id,
        message: error instanceof Error ? error.message : 'Failed to apply special price',
      });
    }
  }

  return summary;
}

async function applyStagedOrganizations(
  tx: TxClient,
  sessionId: string,
  syncedAt: Date
): Promise<ApplySummary> {
  const stages = await tx.onecStageOrganization.findMany({
    where: { sessionId },
    orderBy: { lastImportedAt: 'asc' },
  });
  const summary: ApplySummary = { resolvedStageIds: [], blocked: [], errors: [] };

  for (const stage of stages) {
    const item = stage.payload as unknown as OrganizationItem;
    try {
      await tx.organization.upsert({
        where: { guid: item.guid },
        create: {
          guid: item.guid,
          name: item.name,
          code: item.code ?? null,
          isActive: item.isActive ?? true,
          sourceUpdatedAt: item.sourceUpdatedAt ?? syncedAt,
          lastSyncedAt: syncedAt,
        },
        update: {
          name: item.name,
          code: item.code ?? null,
          isActive: item.isActive ?? true,
          sourceUpdatedAt: item.sourceUpdatedAt ?? syncedAt,
          lastSyncedAt: syncedAt,
        },
      });

      summary.resolvedStageIds.push(stage.id);
    } catch (error) {
      summary.errors.push({
        stageId: stage.id,
        message: error instanceof Error ? error.message : 'Failed to apply organization',
      });
    }
  }

  return summary;
}

async function applyStagedStock(tx: TxClient, sessionId: string, syncedAt: Date): Promise<ApplySummary> {
  const stages = await tx.onecStageStock.findMany({ where: { sessionId }, orderBy: { lastImportedAt: 'asc' } });
  const summary: ApplySummary = { resolvedStageIds: [], blocked: [], errors: [] };

  for (const stage of stages) {
    const item = stage.payload as unknown as StockItem;
    try {
      const organizationGuid = stage.organizationGuid ?? item.organizationGuid ?? null;
      const [product, warehouse, organization] = await Promise.all([
        tx.product.findUnique({ where: { guid: item.productGuid }, select: { id: true } }),
        tx.warehouse.findUnique({ where: { guid: item.warehouseGuid }, select: { id: true } }),
        organizationGuid
          ? tx.organization.findUnique({ where: { guid: organizationGuid }, select: { id: true } })
          : Promise.resolve(null),
      ]);

      if (!product) {
        summary.blocked.push({ stageId: stage.id, message: `Product ${item.productGuid} not found` });
        continue;
      }
      if (!warehouse) {
        summary.blocked.push({ stageId: stage.id, message: `Warehouse ${item.warehouseGuid} not found` });
        continue;
      }
      if (!organizationGuid) {
        summary.blocked.push({ stageId: stage.id, message: 'Organization GUID is missing' });
        continue;
      }
      if (!organization) {
        summary.blocked.push({ stageId: stage.id, message: `Organization ${organizationGuid} not found` });
        continue;
      }

      const quantity = item.quantity ?? item.inStock ?? 0;
      const reserved = item.reserved ?? ((item.clientReserved ?? 0) + (item.managerReserved ?? 0));

      const syncKey = `${product.id}|${warehouse.id}|${organization.id}|${item.seriesGuid ?? ''}`;
      await tx.stockBalance.upsert({
        where: { syncKey },
        create: {
          syncKey,
          productId: product.id,
          warehouseId: warehouse.id,
          organizationId: organization.id,
          quantity: toDecimal(quantity) ?? new Prisma.Decimal(0),
          reserved: toDecimal(reserved),
          inStock: toDecimal(item.inStock ?? quantity),
          shipping: toDecimal(item.shipping),
          clientReserved: toDecimal(item.clientReserved),
          managerReserved: toDecimal(item.managerReserved),
          available: toDecimal(item.available ?? (quantity - reserved)),
          updatedAt: item.updatedAt ?? syncedAt,
          seriesGuid: item.seriesGuid ?? null,
          seriesNumber: item.seriesNumber ?? null,
          seriesProductionDate: item.seriesProductionDate ?? null,
          seriesExpiresAt: item.seriesExpiresAt ?? null,
          sourceUpdatedAt: item.updatedAt ?? syncedAt,
          lastSyncedAt: syncedAt,
        },
        update: {
          organizationId: organization.id,
          quantity: toDecimal(quantity) ?? new Prisma.Decimal(0),
          reserved: toDecimal(reserved),
          inStock: toDecimal(item.inStock ?? quantity),
          shipping: toDecimal(item.shipping),
          clientReserved: toDecimal(item.clientReserved),
          managerReserved: toDecimal(item.managerReserved),
          available: toDecimal(item.available ?? (quantity - reserved)),
          updatedAt: item.updatedAt ?? syncedAt,
          seriesGuid: item.seriesGuid ?? null,
          seriesNumber: item.seriesNumber ?? null,
          seriesProductionDate: item.seriesProductionDate ?? null,
          seriesExpiresAt: item.seriesExpiresAt ?? null,
          sourceUpdatedAt: item.updatedAt ?? syncedAt,
          lastSyncedAt: syncedAt,
        },
      });

      summary.resolvedStageIds.push(stage.id);
    } catch (error) {
      summary.errors.push({
        stageId: stage.id,
        message: error instanceof Error ? error.message : 'Failed to apply stock',
      });
    }
  }

  return summary;
}

async function updateStageStatuses(
  sessionId: string,
  entity: BatchEntityCode,
  summary: ApplySummary,
  resolvedAt: Date
) {
  const resolvedIds = [...new Set(summary.resolvedStageIds)];
  const blockedMap = new Map(summary.blocked.map((item) => [item.stageId, item.message]));
  const errorMap = new Map(summary.errors.map((item) => [item.stageId, item.message]));

  if (resolvedIds.length) {
    switch (entity) {
      case 'nomenclature':
        await prisma.onecStageNomenclature.updateMany({
          where: { sessionId, id: { in: resolvedIds } },
          data: { resolveStatus: OnecStageResolveStatus.RESOLVED, lastResolveError: null, resolvedAt },
        });
        break;
      case 'organizations':
        await prisma.onecStageOrganization.updateMany({
          where: { sessionId, id: { in: resolvedIds } },
          data: { resolveStatus: OnecStageResolveStatus.RESOLVED, lastResolveError: null, resolvedAt },
        });
        break;
      case 'warehouses':
        await prisma.onecStageWarehouse.updateMany({
          where: { sessionId, id: { in: resolvedIds } },
          data: { resolveStatus: OnecStageResolveStatus.RESOLVED, lastResolveError: null, resolvedAt },
        });
        break;
      case 'counterparties':
        await prisma.onecStageCounterparty.updateMany({
          where: { sessionId, id: { in: resolvedIds } },
          data: { resolveStatus: OnecStageResolveStatus.RESOLVED, lastResolveError: null, resolvedAt },
        });
        break;
      case 'contracts':
        await prisma.onecStageContract.updateMany({
          where: { sessionId, id: { in: resolvedIds } },
          data: { resolveStatus: OnecStageResolveStatus.RESOLVED, lastResolveError: null, resolvedAt },
        });
        break;
      case 'agreements':
        await prisma.onecStageAgreement.updateMany({
          where: { sessionId, id: { in: resolvedIds } },
          data: { resolveStatus: OnecStageResolveStatus.RESOLVED, lastResolveError: null, resolvedAt },
        });
        break;
      case 'product-prices':
        await prisma.onecStageProductPrice.updateMany({
          where: { sessionId, id: { in: resolvedIds } },
          data: { resolveStatus: OnecStageResolveStatus.RESOLVED, lastResolveError: null, resolvedAt },
        });
        break;
      case 'special-prices':
        await prisma.onecStageSpecialPrice.updateMany({
          where: { sessionId, id: { in: resolvedIds } },
          data: { resolveStatus: OnecStageResolveStatus.RESOLVED, lastResolveError: null, resolvedAt },
        });
        break;
      case 'stock':
        await prisma.onecStageStock.updateMany({
          where: { sessionId, id: { in: resolvedIds } },
          data: { resolveStatus: OnecStageResolveStatus.RESOLVED, lastResolveError: null, resolvedAt },
        });
        break;
    }
  }

  const applyIssue = async (stageId: string, status: OnecStageResolveStatus, message: string) => {
    switch (entity) {
      case 'nomenclature':
        await prisma.onecStageNomenclature.update({ where: { id: stageId }, data: { resolveStatus: status, lastResolveError: message, resolvedAt: null } });
        return;
      case 'organizations':
        await prisma.onecStageOrganization.update({ where: { id: stageId }, data: { resolveStatus: status, lastResolveError: message, resolvedAt: null } });
        return;
      case 'warehouses':
        await prisma.onecStageWarehouse.update({ where: { id: stageId }, data: { resolveStatus: status, lastResolveError: message, resolvedAt: null } });
        return;
      case 'counterparties':
        await prisma.onecStageCounterparty.update({ where: { id: stageId }, data: { resolveStatus: status, lastResolveError: message, resolvedAt: null } });
        return;
      case 'contracts':
        await prisma.onecStageContract.update({ where: { id: stageId }, data: { resolveStatus: status, lastResolveError: message, resolvedAt: null } });
        return;
      case 'agreements':
        await prisma.onecStageAgreement.update({ where: { id: stageId }, data: { resolveStatus: status, lastResolveError: message, resolvedAt: null } });
        return;
      case 'product-prices':
        await prisma.onecStageProductPrice.update({ where: { id: stageId }, data: { resolveStatus: status, lastResolveError: message, resolvedAt: null } });
        return;
      case 'special-prices':
        await prisma.onecStageSpecialPrice.update({ where: { id: stageId }, data: { resolveStatus: status, lastResolveError: message, resolvedAt: null } });
        return;
      case 'stock':
        await prisma.onecStageStock.update({ where: { id: stageId }, data: { resolveStatus: status, lastResolveError: message, resolvedAt: null } });
        return;
    }
  };

  for (const [stageId, message] of blockedMap) {
    await applyIssue(stageId, OnecStageResolveStatus.BLOCKED, message);
  }
  for (const [stageId, message] of errorMap) {
    await applyIssue(stageId, OnecStageResolveStatus.ERROR, message);
  }
}

export async function completeOnecSyncSession(body: SessionCompleteBody): Promise<SessionOutcome> {
  const session = await prisma.onecSyncSession.findUnique({
    where: { id: body.sessionId },
    select: {
      id: true,
      replaceMode: true,
      acceptedCount: true,
      selectedEntities: true,
    },
  });

  if (!session) {
    throw new Error(`Sync session ${body.sessionId} not found`);
  }

  const selected = normalizeSelectedEntities((session.selectedEntities as string[] | null) ?? []);
  const entities = selected.length
    ? RECONCILE_ORDER.filter((entity) => selected.includes(entity))
    : RECONCILE_ORDER;
  const syncedAt = now();

  await prisma.onecSyncSession.update({
    where: { id: session.id },
    data: { status: OnecSyncSessionStatus.COMPLETING, lastActivityAt: syncedAt },
  });

  const summaries = new Map<BatchEntityCode, ApplySummary>();
  let notes: string | null = null;
  let status: OnecSyncSessionStatus = OnecSyncSessionStatus.COMPLETED;

  try {
    await prisma.$transaction(
      async (tx) => {
        if (session.replaceMode) {
          for (const entity of entities) {
            await clearEntityInTx(tx, entity);
          }
        }

        for (const entity of entities) {
          let summary: ApplySummary;
          switch (entity) {
            case 'nomenclature':
              summary = await applyStagedNomenclature(tx, session.id, syncedAt);
              break;
            case 'organizations':
              summary = await applyStagedOrganizations(tx, session.id, syncedAt);
              break;
            case 'warehouses':
              summary = await applyStagedWarehouses(tx, session.id, syncedAt);
              break;
            case 'counterparties':
              summary = await applyStagedCounterparties(tx, session.id, syncedAt);
              break;
            case 'contracts':
              summary = await applyStagedContracts(tx, session.id, syncedAt);
              break;
            case 'agreements':
              summary = await applyStagedAgreements(tx, session.id, syncedAt);
              break;
            case 'product-prices':
              summary = await applyStagedProductPrices(tx, session.id, syncedAt);
              break;
            case 'special-prices':
              summary = await applyStagedSpecialPrices(tx, session.id, syncedAt);
              break;
            case 'stock':
              summary = await applyStagedStock(tx, session.id, syncedAt);
              break;
          }
          summaries.set(entity, summary);
        }

        if (entities.includes('counterparties')) {
          const defaultsSummary = await applyCounterpartyDefaultLinks(tx, session.id, syncedAt);
          summaries.set(
            'counterparties',
            mergeApplySummaries(summaries.get('counterparties') ?? emptyApplySummary(), defaultsSummary)
          );
        }

        const blockedCount = [...summaries.values()].reduce((sum, item) => sum + item.blocked.length, 0);
        const errorCount = [...summaries.values()].reduce((sum, item) => sum + item.errors.length, 0);
        if (session.replaceMode && (blockedCount > 0 || errorCount > 0)) {
          notes =
            blockedCount > 0
              ? 'Session has unresolved references. Final promote rolled back.'
              : 'Session failed during promote.';
          throw new Error(notes);
        }
      },
      {
        maxWait: SYNC_SESSION_TX_MAX_WAIT_MS,
        timeout: SYNC_SESSION_TX_TIMEOUT_MS,
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to complete sync session';
    notes =
      notes ??
      (message.includes('expired transaction')
        ? `Session promote transaction timed out after ${SYNC_SESSION_TX_TIMEOUT_MS} ms.`
        : message);
  }

  let resolvedCount = 0;
  let blockedCount = 0;
  let errorCount = 0;
  for (const entity of entities) {
    const summary = summaries.get(entity) ?? { resolvedStageIds: [], blocked: [], errors: [] };
    await updateStageStatuses(session.id, entity, summary, syncedAt);
    resolvedCount += summary.resolvedStageIds.length;
    blockedCount += summary.blocked.length;
    errorCount += summary.errors.length;
  }

  if (notes && session.replaceMode) {
    status = blockedCount > 0 || resolvedCount > 0 ? OnecSyncSessionStatus.PARTIAL : OnecSyncSessionStatus.FAILED;
  } else if (errorCount > 0 && resolvedCount === 0) {
    status = OnecSyncSessionStatus.FAILED;
  } else if (blockedCount > 0 || errorCount > 0) {
    status = OnecSyncSessionStatus.PARTIAL;
  }

  const outcome = await prisma.onecSyncSession.update({
    where: { id: session.id },
    data: {
      status,
      resolvedCount,
      blockedCount,
      errorCount,
      notes,
      completedAt: syncedAt,
      lastActivityAt: syncedAt,
    },
    select: {
      id: true,
      status: true,
      acceptedCount: true,
      resolvedCount: true,
      blockedCount: true,
      errorCount: true,
      notes: true,
    },
  });

  if (entities.some((entity) => entity === 'stock' || entity === 'nomenclature' || entity === 'warehouses' || entity === 'organizations')) {
    await cacheDelPrefix(STOCK_BALANCES_CACHE_PREFIX);
  }

  return {
    sessionId: outcome.id,
    status: outcome.status,
    acceptedCount: outcome.acceptedCount,
    resolvedCount: outcome.resolvedCount,
    blockedCount: outcome.blockedCount,
    errorCount: outcome.errorCount,
    notes: outcome.notes,
  };
}

export function getSyncEntityType(entity: BatchEntityCode): SyncEntityType {
  return ENTITY_SYNC_TYPE[entity];
}
