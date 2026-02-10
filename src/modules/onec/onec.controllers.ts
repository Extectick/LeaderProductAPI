import {
  OrderStatus,
  Prisma,
  SyncDirection,
  SyncEntityType,
  SyncItemStatus,
  SyncStatus,
} from '@prisma/client';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { fromZodError } from 'zod-validation-error';
import prisma from '../../prisma/client';
import {
  agreementsBatchSchema,
  counterpartiesBatchSchema,
  nomenclatureBatchSchema,
  orderAckSchema,
  ordersStatusBatchSchema,
  productPricesBatchSchema,
  specialPricesBatchSchema,
  stockBatchSchema,
  warehousesBatchSchema,
} from './onec.schemas';

type BatchResult = { key: string; status: 'ok' | 'error'; error?: string };

const toDecimal = (value?: number | null) =>
  value === undefined || value === null ? undefined : new Prisma.Decimal(value);

const decimalToNumber = (value: Prisma.Decimal | number | string | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  return value.toNumber();
};

const now = () => new Date();
const toSingleString = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
};

const mapItemStatus = (status: BatchResult['status']): SyncItemStatus =>
  status === 'ok' ? SyncItemStatus.OK : SyncItemStatus.ERROR;

const calcRunStatus = (successCount: number, errorCount: number): SyncStatus => {
  if (errorCount === 0) return SyncStatus.COMPLETED;
  if (successCount === 0) return SyncStatus.FAILED;
  return SyncStatus.PARTIAL;
};

async function startSyncRun(entity: SyncEntityType, direction: SyncDirection, meta?: Prisma.JsonObject) {
  const requestId = randomUUID();
  return prisma.syncRun.create({
    data: {
      requestId,
      entity,
      direction,
      status: SyncStatus.STARTED,
      meta: meta ? (meta as Prisma.InputJsonValue) : undefined,
    },
    select: { id: true, requestId: true },
  });
}

async function completeSyncRun(
  runId: string,
  results: BatchResult[],
  meta?: Prisma.JsonObject,
  notes?: string
) {
  const successCount = results.filter((r) => r.status === 'ok').length;
  const errorCount = results.length - successCount;
  const status = calcRunStatus(successCount, errorCount);

  if (results.length > 0) {
    await prisma.syncRunItem.createMany({
      data: results.map((r) => ({
        runId,
        key: r.key,
        status: mapItemStatus(r.status),
        error: r.error,
      })),
    });
  }

  await prisma.syncRun.update({
    where: { id: runId },
    data: {
      totalCount: results.length,
      successCount,
      errorCount,
      status,
      notes,
      meta: meta ? (meta as Prisma.InputJsonValue) : undefined,
      finishedAt: now(),
    },
  });
}

async function failSyncRun(runId: string, error: unknown, meta?: Prisma.JsonObject) {
  const message = error instanceof Error ? error.message : String(error);
  await prisma.syncRun.update({
    where: { id: runId },
    data: {
      status: SyncStatus.FAILED,
      notes: message,
      meta: meta
        ? ({ ...meta, error: message } as Prisma.InputJsonValue)
        : ({ error: message } as Prisma.InputJsonValue),
      finishedAt: now(),
    },
  });
}

async function safeCompleteSyncRun(
  runId: string | undefined,
  results: BatchResult[],
  meta?: Prisma.JsonObject,
  notes?: string
) {
  if (!runId) return;
  try {
    await completeSyncRun(runId, results, meta, notes);
  } catch (e) {
    console.error('Failed to complete sync run', e);
  }
}

async function safeFailSyncRun(runId: string | undefined, error: unknown, meta?: Prisma.JsonObject) {
  if (!runId) return;
  try {
    await failSyncRun(runId, error, meta);
  } catch (e) {
    console.error('Failed to fail sync run', e);
  }
}

const handleValidationError = (error: ZodError<unknown>, res: Response) => {
  const validationError = fromZodError(error as any);
  return res.status(400).json({
    error: 'Validation error',
    details: (validationError as any).details ?? validationError.message,
  });
};

export const onecAuthMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const rawSecret = (req.body?.secret ?? req.query?.secret) as unknown;
  const secret = Array.isArray(rawSecret) ? rawSecret[0] : rawSecret;
  if (!secret || secret !== process.env.ONEC_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
};

export const handleNomenclatureBatch = async (req: Request, res: Response) => {
  const rawCount = Array.isArray(req.body?.items) ? req.body.items.length : 0;
  const baseMeta = { rawCount };
  let runId: string | undefined;

  try {
    runId = (await startSyncRun(SyncEntityType.NOMENCLATURE, SyncDirection.IMPORT, baseMeta)).id;
  } catch (e) {
    console.error('Failed to start sync run for nomenclature', e);
  }

  try {
    const parsed = nomenclatureBatchSchema.parse(req.body);
    const results: BatchResult[] = [];
    const syncedAt = now();

    await prisma.$transaction(async (tx) => {
      const groups = parsed.items.filter((item) => item.isGroup);
      const products = parsed.items.filter((item) => !item.isGroup);

      const groupCache = new Map<string, string>();

      const parentResolver = async (guid?: string | null): Promise<string | undefined> => {
        if (!guid) return undefined;
        if (groupCache.has(guid)) return groupCache.get(guid);

        const found = await tx.productGroup.findUnique({ where: { guid } });
        if (found) {
          groupCache.set(guid, found.id);
          return found.id;
        }
        return undefined;
      };

      for (const group of groups) {
        try {
          const parentId = await parentResolver(group.parentGuid ?? undefined);
          if (group.parentGuid && !parentId) {
            // Решение: если родитель не найден, создаём группу без parentId, чтобы не блокировать приём батча
            console.warn(`Parent group ${group.parentGuid} not found. Creating ${group.guid} without parent.`);
          }

          const sourceUpdatedAt = group.sourceUpdatedAt ?? syncedAt;
          const saved = await tx.productGroup.upsert({
            where: { guid: group.guid },
            create: {
              guid: group.guid,
              name: group.name,
              code: group.code,
              isActive: group.isActive ?? true,
              parentId: parentId ?? null,
              sourceUpdatedAt,
              lastSyncedAt: syncedAt,
            },
            update: {
              name: group.name,
              code: group.code,
              isActive: group.isActive ?? true,
              parentId: parentId ?? null,
              sourceUpdatedAt,
              lastSyncedAt: syncedAt,
            },
          });
          groupCache.set(saved.guid, saved.id);
          results.push({ key: group.guid, status: 'ok' });
        } catch (err) {
          console.error(`Failed to upsert group ${group.guid}`, err);
          results.push({ key: group.guid, status: 'error', error: 'Failed to upsert group' });
        }
      }

      for (const product of products) {
        try {
          let baseUnitId: string | undefined;
          if (product.baseUnit) {
            const baseUnitSourceUpdatedAt =
              product.baseUnit.sourceUpdatedAt ?? product.sourceUpdatedAt ?? syncedAt;
            const baseUnit = await tx.unit.upsert({
              where: { guid: product.baseUnit.guid },
              create: {
                guid: product.baseUnit.guid,
                name: product.baseUnit.name,
                code: product.baseUnit.code,
                symbol: product.baseUnit.symbol,
                sourceUpdatedAt: baseUnitSourceUpdatedAt,
                lastSyncedAt: syncedAt,
              },
              update: {
                name: product.baseUnit.name,
                code: product.baseUnit.code,
                symbol: product.baseUnit.symbol,
                sourceUpdatedAt: baseUnitSourceUpdatedAt,
                lastSyncedAt: syncedAt,
              },
            });
            baseUnitId = baseUnit.id;
          }

          const groupId = await parentResolver(product.parentGuid ?? undefined);
          if (product.parentGuid && !groupId) {
            console.warn(
              `Group ${product.parentGuid} for product ${product.guid} not found. Product will be created without group.`
            );
          }

          const productSourceUpdatedAt = product.sourceUpdatedAt ?? syncedAt;
          const savedProduct = await tx.product.upsert({
            where: { guid: product.guid },
            create: {
              guid: product.guid,
              name: product.name,
              code: product.code,
              article: product.article,
              sku: product.sku,
              isWeight: product.isWeight ?? false,
              isService: product.isService ?? false,
              isActive: product.isActive ?? true,
              groupId: groupId ?? null,
              baseUnitId: baseUnitId ?? null,
              sourceUpdatedAt: productSourceUpdatedAt,
              lastSyncedAt: syncedAt,
            },
            update: {
              name: product.name,
              code: product.code,
              article: product.article,
              sku: product.sku,
              isWeight: product.isWeight ?? false,
              isService: product.isService ?? false,
              isActive: product.isActive ?? true,
              groupId: groupId ?? null,
              baseUnitId: baseUnitId ?? null,
              sourceUpdatedAt: productSourceUpdatedAt,
              lastSyncedAt: syncedAt,
            },
          });

          if (product.packages?.length) {
            for (const pack of product.packages) {
              const packUnitSourceUpdatedAt =
                pack.unit.sourceUpdatedAt ?? pack.sourceUpdatedAt ?? product.sourceUpdatedAt ?? syncedAt;
              const unit = await tx.unit.upsert({
                where: { guid: pack.unit.guid },
                create: {
                  guid: pack.unit.guid,
                  name: pack.unit.name,
                  code: pack.unit.code,
                  symbol: pack.unit.symbol,
                  sourceUpdatedAt: packUnitSourceUpdatedAt,
                  lastSyncedAt: syncedAt,
                },
                update: {
                  name: pack.unit.name,
                  code: pack.unit.code,
                  symbol: pack.unit.symbol,
                  sourceUpdatedAt: packUnitSourceUpdatedAt,
                  lastSyncedAt: syncedAt,
                },
              });

              const packSourceUpdatedAt = pack.sourceUpdatedAt ?? product.sourceUpdatedAt ?? syncedAt;
              const packageData = {
                productId: savedProduct.id,
                unitId: unit.id,
                name: pack.name,
                multiplier: toDecimal(pack.multiplier) ?? new Prisma.Decimal(1),
                barcode: pack.barcode,
                isDefault: pack.isDefault ?? false,
                sortOrder: pack.sortOrder ?? 0,
                sourceUpdatedAt: packSourceUpdatedAt,
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

          results.push({ key: product.guid, status: 'ok' });
        } catch (err) {
          console.error(`Failed to upsert product ${product.guid}`, err);
          results.push({ key: product.guid, status: 'error', error: 'Failed to upsert product' });
        }
      }
    });

    await safeCompleteSyncRun(runId, results, { rawCount, parsedCount: parsed.items.length });
    return res.json({ success: true, count: results.length, results });
  } catch (error) {
    if (error instanceof ZodError) {
      await safeFailSyncRun(runId, error, baseMeta);
      return handleValidationError(error, res);
    }
    await safeFailSyncRun(runId, error, baseMeta);
    console.error('Unexpected error in nomenclature batch', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const handleStockBatch = async (req: Request, res: Response) => {
  const rawCount = Array.isArray(req.body?.items) ? req.body.items.length : 0;
  const baseMeta = { rawCount };
  let runId: string | undefined;

  try {
    runId = (await startSyncRun(SyncEntityType.STOCK, SyncDirection.IMPORT, baseMeta)).id;
  } catch (e) {
    console.error('Failed to start sync run for stock', e);
  }

  try {
    const parsed = stockBatchSchema.parse(req.body);
    const results: BatchResult[] = [];
    const syncedAt = now();

    await prisma.$transaction(async (tx) => {
      const productGuids = Array.from(new Set(parsed.items.map((i) => i.productGuid)));
      const warehouseGuids = Array.from(new Set(parsed.items.map((i) => i.warehouseGuid)));

      const [products, warehouses] = await Promise.all([
        productGuids.length
          ? tx.product.findMany({ where: { guid: { in: productGuids } } })
          : Promise.resolve([]),
        warehouseGuids.length
          ? tx.warehouse.findMany({ where: { guid: { in: warehouseGuids } } })
          : Promise.resolve([]),
      ]);

      const productMap = new Map(products.map((p) => [p.guid, p.id]));
      const warehouseMap = new Map(warehouses.map((w) => [w.guid, w.id]));

      for (const item of parsed.items) {
        const key = `${item.productGuid}:${item.warehouseGuid}`;
        const productId = productMap.get(item.productGuid);
        const warehouseId = warehouseMap.get(item.warehouseGuid);

        if (!productId || !warehouseId) {
          console.warn(
            `Stock item skipped for product ${item.productGuid} or warehouse ${item.warehouseGuid}`
          );
          results.push({
            key,
            status: 'error',
            error: 'Product or warehouse not found',
          });
          continue;
        }

        try {
          await tx.stockBalance.upsert({
            where: { productId_warehouseId: { productId, warehouseId } },
            create: {
              productId,
              warehouseId,
              quantity: toDecimal(item.quantity) ?? new Prisma.Decimal(0),
              reserved: toDecimal(item.reserved),
              updatedAt: item.updatedAt,
              sourceUpdatedAt: item.updatedAt,
              lastSyncedAt: syncedAt,
            },
            update: {
              quantity: toDecimal(item.quantity) ?? new Prisma.Decimal(0),
              reserved: toDecimal(item.reserved),
              updatedAt: item.updatedAt,
              sourceUpdatedAt: item.updatedAt,
              lastSyncedAt: syncedAt,
            },
          });
          results.push({ key, status: 'ok' });
        } catch (err) {
          console.error(`Failed to upsert stock for ${key}`, err);
          results.push({ key, status: 'error', error: 'Failed to upsert stock' });
        }
      }
    });

    await safeCompleteSyncRun(runId, results, { rawCount, parsedCount: parsed.items.length });
    return res.json({ success: true, count: results.length, results });
  } catch (error) {
    if (error instanceof ZodError) {
      await safeFailSyncRun(runId, error, baseMeta);
      return handleValidationError(error, res);
    }
    await safeFailSyncRun(runId, error, baseMeta);
    console.error('Unexpected error in stock batch', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const handleCounterpartiesBatch = async (req: Request, res: Response) => {
  const rawCount = Array.isArray(req.body?.items) ? req.body.items.length : 0;
  const baseMeta = { rawCount };
  let runId: string | undefined;

  try {
    runId = (await startSyncRun(SyncEntityType.COUNTERPARTIES, SyncDirection.IMPORT, baseMeta)).id;
  } catch (e) {
    console.error('Failed to start sync run for counterparties', e);
  }

  try {
    const parsed = counterpartiesBatchSchema.parse(req.body);
    const results: BatchResult[] = [];
    const syncedAt = now();

    await prisma.$transaction(async (tx) => {
      for (const item of parsed.items) {
        try {
          const counterpartySourceUpdatedAt = item.sourceUpdatedAt ?? syncedAt;
          const counterparty = await tx.counterparty.upsert({
            where: { guid: item.guid },
            create: {
              guid: item.guid,
              name: item.name,
              fullName: item.fullName ?? undefined,
              inn: item.inn ?? undefined,
              kpp: item.kpp ?? undefined,
              phone: item.phone ?? undefined,
              email: item.email ?? undefined,
              isActive: item.isActive ?? true,
              sourceUpdatedAt: counterpartySourceUpdatedAt,
              lastSyncedAt: syncedAt,
            },
            update: {
              name: item.name,
              fullName: item.fullName ?? undefined,
              inn: item.inn ?? undefined,
              kpp: item.kpp ?? undefined,
              phone: item.phone ?? undefined,
              email: item.email ?? undefined,
              isActive: item.isActive ?? true,
              sourceUpdatedAt: counterpartySourceUpdatedAt,
              lastSyncedAt: syncedAt,
            },
          });

          if (item.addresses?.length) {
            for (const address of item.addresses) {
              const addressSourceUpdatedAt = address.sourceUpdatedAt ?? item.sourceUpdatedAt ?? syncedAt;
              const addressData = {
                counterpartyId: counterparty.id,
                guid: address.guid ?? null,
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
                sourceUpdatedAt: addressSourceUpdatedAt,
                lastSyncedAt: syncedAt,
              };

              if (address.guid) {
                await tx.deliveryAddress.upsert({
                  where: { guid: address.guid },
                  create: addressData,
                  update: addressData,
                });
              } else {
                await tx.deliveryAddress.create({ data: addressData });
              }
            }
          }

          results.push({ key: item.guid, status: 'ok' });
        } catch (err) {
          console.error(`Failed to upsert counterparty ${item.guid}`, err);
          results.push({
            key: item.guid,
            status: 'error',
            error: 'Failed to upsert counterparty',
          });
        }
      }
    });

    await safeCompleteSyncRun(runId, results, { rawCount, parsedCount: parsed.items.length });
    return res.json({ success: true, count: results.length, results });
  } catch (error) {
    if (error instanceof ZodError) {
      await safeFailSyncRun(runId, error, baseMeta);
      return handleValidationError(error, res);
    }
    await safeFailSyncRun(runId, error, baseMeta);
    console.error('Unexpected error in counterparties batch', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const handleWarehousesBatch = async (req: Request, res: Response) => {
  const rawCount = Array.isArray(req.body?.items) ? req.body.items.length : 0;
  const baseMeta = { rawCount };
  let runId: string | undefined;

  try {
    runId = (await startSyncRun(SyncEntityType.WAREHOUSES, SyncDirection.IMPORT, baseMeta)).id;
  } catch (e) {
    console.error('Failed to start sync run for warehouses', e);
  }

  try {
    const parsed = warehousesBatchSchema.parse(req.body);
    const results: BatchResult[] = [];
    const syncedAt = now();

    await prisma.$transaction(async (tx) => {
      for (const item of parsed.items) {
        try {
          const sourceUpdatedAt = item.sourceUpdatedAt ?? syncedAt;
          await tx.warehouse.upsert({
            where: { guid: item.guid },
            create: {
              guid: item.guid,
              name: item.name,
              code: item.code ?? undefined,
              isActive: item.isActive ?? true,
              isDefault: item.isDefault ?? false,
              isPickup: item.isPickup ?? false,
              address: item.address ?? undefined,
              sourceUpdatedAt,
              lastSyncedAt: syncedAt,
            },
            update: {
              name: item.name,
              code: item.code ?? undefined,
              isActive: item.isActive ?? true,
              isDefault: item.isDefault ?? false,
              isPickup: item.isPickup ?? false,
              address: item.address ?? undefined,
              sourceUpdatedAt,
              lastSyncedAt: syncedAt,
            },
          });

          results.push({ key: item.guid, status: 'ok' });
        } catch (err) {
          console.error(`Failed to upsert warehouse ${item.guid}`, err);
          results.push({ key: item.guid, status: 'error', error: 'Failed to upsert warehouse' });
        }
      }
    });

    await safeCompleteSyncRun(runId, results, { rawCount, parsedCount: parsed.items.length });
    return res.json({ success: true, count: results.length, results });
  } catch (error) {
    if (error instanceof ZodError) {
      await safeFailSyncRun(runId, error, baseMeta);
      return handleValidationError(error, res);
    }
    await safeFailSyncRun(runId, error, baseMeta);
    console.error('Unexpected error in warehouses batch', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const handleAgreementsBatch = async (req: Request, res: Response) => {
  const rawCount = Array.isArray(req.body?.items) ? req.body.items.length : 0;
  const baseMeta = { rawCount };
  let runId: string | undefined;

  try {
    runId = (await startSyncRun(SyncEntityType.AGREEMENTS, SyncDirection.IMPORT, baseMeta)).id;
  } catch (e) {
    console.error('Failed to start sync run for agreements', e);
  }

  try {
    const parsed = agreementsBatchSchema.parse(req.body);
    const results: BatchResult[] = [];
    const syncedAt = now();

    await prisma.$transaction(async (tx) => {
      for (const item of parsed.items) {
        const agreementKey = item.agreement.guid;
        try {
          let priceTypeId: string | undefined;
          if (item.priceType) {
            const priceTypeSourceUpdatedAt = item.priceType.sourceUpdatedAt ?? syncedAt;
            const priceType = await tx.priceType.upsert({
              where: { guid: item.priceType.guid },
              create: {
                guid: item.priceType.guid,
                name: item.priceType.name,
                code: item.priceType.code ?? undefined,
                isActive: item.priceType.isActive ?? true,
                sourceUpdatedAt: priceTypeSourceUpdatedAt,
                lastSyncedAt: syncedAt,
              },
              update: {
                name: item.priceType.name,
                code: item.priceType.code ?? undefined,
                isActive: item.priceType.isActive ?? true,
                sourceUpdatedAt: priceTypeSourceUpdatedAt,
                lastSyncedAt: syncedAt,
              },
            });
            priceTypeId = priceType.id;
          }

          const counterparty = await tx.counterparty.findUnique({
            where: { guid: item.contract.counterpartyGuid },
          });

          if (!counterparty) {
            results.push({
              key: agreementKey,
              status: 'error',
              error: `Counterparty ${item.contract.counterpartyGuid} not found`,
            });
              continue;
          }

          const contractSourceUpdatedAt = item.contract.sourceUpdatedAt ?? syncedAt;
          const contract = await tx.clientContract.upsert({
            where: { guid: item.contract.guid },
            create: {
              guid: item.contract.guid,
              counterpartyId: counterparty.id,
              number: item.contract.number,
              date: item.contract.date,
              validFrom: item.contract.validFrom ?? null,
              validTo: item.contract.validTo ?? null,
              isActive: item.contract.isActive ?? true,
              comment: item.contract.comment ?? undefined,
              sourceUpdatedAt: contractSourceUpdatedAt,
              lastSyncedAt: syncedAt,
            },
            update: {
              counterpartyId: counterparty.id,
              number: item.contract.number,
              date: item.contract.date,
              validFrom: item.contract.validFrom ?? null,
              validTo: item.contract.validTo ?? null,
              isActive: item.contract.isActive ?? true,
              comment: item.contract.comment ?? undefined,
              sourceUpdatedAt: contractSourceUpdatedAt,
              lastSyncedAt: syncedAt,
            },
          });

          let agreementPriceTypeId = priceTypeId;
          if (item.agreement.priceTypeGuid) {
            const foundPriceType = await tx.priceType.findUnique({
              where: { guid: item.agreement.priceTypeGuid },
            });
            if (!foundPriceType) {
              results.push({
                key: agreementKey,
                status: 'error',
                error: `Price type ${item.agreement.priceTypeGuid} not found`,
              });
              continue;
            }
            agreementPriceTypeId = foundPriceType.id;
          }

          let warehouseId: string | undefined;
          if (item.agreement.warehouseGuid) {
            const warehouse = await tx.warehouse.findUnique({
              where: { guid: item.agreement.warehouseGuid },
            });
            if (!warehouse) {
              results.push({
                key: agreementKey,
                status: 'error',
                error: `Warehouse ${item.agreement.warehouseGuid} not found`,
              });
              continue;
            }
            warehouseId = warehouse.id;
          }

          let agreementCounterpartyId: string | undefined = counterparty.id;
          if (item.agreement.counterpartyGuid) {
            const foundCounterparty = await tx.counterparty.findUnique({
              where: { guid: item.agreement.counterpartyGuid },
            });
            if (!foundCounterparty) {
              results.push({
                key: agreementKey,
                status: 'error',
                error: `Counterparty ${item.agreement.counterpartyGuid} not found`,
              });
              continue;
            }
            agreementCounterpartyId = foundCounterparty.id;
          }

          const agreementSourceUpdatedAt = item.agreement.sourceUpdatedAt ?? syncedAt;
          await tx.clientAgreement.upsert({
            where: { guid: item.agreement.guid },
            create: {
              guid: item.agreement.guid,
              name: item.agreement.name,
              counterpartyId: agreementCounterpartyId ?? null,
              contractId: contract.id,
              priceTypeId: agreementPriceTypeId ?? null,
              warehouseId: warehouseId ?? null,
              currency: item.agreement.currency ?? undefined,
              isActive: item.agreement.isActive ?? true,
              sourceUpdatedAt: agreementSourceUpdatedAt,
              lastSyncedAt: syncedAt,
            },
            update: {
              name: item.agreement.name,
              counterpartyId: agreementCounterpartyId ?? null,
              contractId: contract.id,
              priceTypeId: agreementPriceTypeId ?? null,
              warehouseId: warehouseId ?? null,
              currency: item.agreement.currency ?? undefined,
              isActive: item.agreement.isActive ?? true,
              sourceUpdatedAt: agreementSourceUpdatedAt,
              lastSyncedAt: syncedAt,
            },
          });

          results.push({ key: agreementKey, status: 'ok' });
        } catch (err) {
          console.error(`Failed to upsert agreement ${agreementKey}`, err);
          results.push({
            key: agreementKey,
            status: 'error',
            error: 'Failed to upsert agreement set',
          });
        }
      }
    });

    await safeCompleteSyncRun(runId, results, { rawCount, parsedCount: parsed.items.length });
    return res.json({ success: true, count: results.length, results });
  } catch (error) {
    if (error instanceof ZodError) {
      await safeFailSyncRun(runId, error, baseMeta);
      return handleValidationError(error, res);
    }
    await safeFailSyncRun(runId, error, baseMeta);
    console.error('Unexpected error in agreements batch', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const handleSpecialPricesBatch = async (req: Request, res: Response) => {
  const rawCount = Array.isArray(req.body?.items) ? req.body.items.length : 0;
  const baseMeta = { rawCount };
  let runId: string | undefined;

  try {
    runId = (await startSyncRun(SyncEntityType.SPECIAL_PRICES, SyncDirection.IMPORT, baseMeta)).id;
  } catch (e) {
    console.error('Failed to start sync run for special prices', e);
  }

  try {
    const parsed = specialPricesBatchSchema.parse(req.body);
    const results: BatchResult[] = [];
    const syncedAt = now();

    await prisma.$transaction(async (tx) => {
      const productGuids = Array.from(new Set(parsed.items.map((i) => i.productGuid)));
      const counterpartyGuids = Array.from(
        new Set(parsed.items.map((i) => i.counterpartyGuid).filter(Boolean) as string[])
      );
      const agreementGuids = Array.from(
        new Set(parsed.items.map((i) => i.agreementGuid).filter(Boolean) as string[])
      );
      const priceTypeGuids = Array.from(
        new Set(parsed.items.map((i) => i.priceTypeGuid).filter(Boolean) as string[])
      );

      const [products, counterparties, agreements, priceTypes] = await Promise.all([
        productGuids.length
          ? tx.product.findMany({ where: { guid: { in: productGuids } } })
          : Promise.resolve([]),
        counterpartyGuids.length
          ? tx.counterparty.findMany({ where: { guid: { in: counterpartyGuids } } })
          : Promise.resolve([]),
        agreementGuids.length
          ? tx.clientAgreement.findMany({ where: { guid: { in: agreementGuids } } })
          : Promise.resolve([]),
        priceTypeGuids.length
          ? tx.priceType.findMany({ where: { guid: { in: priceTypeGuids } } })
          : Promise.resolve([]),
      ]);

      const productMap = new Map(products.map((p) => [p.guid, p.id]));
      const counterpartyMap = new Map(counterparties.map((c) => [c.guid, c.id]));
      const agreementMap = new Map(agreements.map((a) => [a.guid, a.id]));
      const priceTypeMap = new Map(priceTypes.map((p) => [p.guid, p.id]));

      for (const item of parsed.items) {
        const key = item.guid ?? `${item.productGuid}:${item.counterpartyGuid ?? 'all'}`;
        const productId = productMap.get(item.productGuid);
        if (!productId) {
          results.push({
            key,
            status: 'error',
            error: `Product ${item.productGuid} not found`,
          });
          continue;
        }

        const counterpartyId =
          item.counterpartyGuid !== undefined
            ? counterpartyMap.get(item.counterpartyGuid) ?? null
            : null;
        const agreementId =
          item.agreementGuid !== undefined ? agreementMap.get(item.agreementGuid) ?? null : null;
        const priceTypeId =
          item.priceTypeGuid !== undefined ? priceTypeMap.get(item.priceTypeGuid) ?? null : null;

        if (item.counterpartyGuid && counterpartyId === null) {
          results.push({
            key,
            status: 'error',
            error: `Counterparty ${item.counterpartyGuid} not found`,
          });
          continue;
        }
        if (item.agreementGuid && agreementId === null) {
          results.push({
            key,
            status: 'error',
            error: `Agreement ${item.agreementGuid} not found`,
          });
          continue;
        }
        if (item.priceTypeGuid && priceTypeId === null) {
          results.push({
            key,
            status: 'error',
            error: `Price type ${item.priceTypeGuid} not found`,
          });
          continue;
        }

        const sourceUpdatedAt = item.sourceUpdatedAt ?? syncedAt;
        const data = {
          productId,
          counterpartyId,
          agreementId,
          priceTypeId,
          price: toDecimal(item.price) ?? new Prisma.Decimal(0),
          currency: item.currency ?? undefined,
          startDate: item.startDate ?? null,
          endDate: item.endDate ?? null,
          minQty: toDecimal(item.minQty),
          isActive: item.isActive ?? true,
          sourceUpdatedAt,
          lastSyncedAt: syncedAt,
        };

        const where: Prisma.SpecialPriceWhereUniqueInput = item.guid
          ? { guid: item.guid }
          : ({
              productId_counterpartyId_agreementId_priceTypeId_startDate: {
                productId,
                counterpartyId: counterpartyId ?? null,
                agreementId: agreementId ?? null,
                priceTypeId: priceTypeId ?? null,
                startDate: item.startDate ?? null,
              },
            } as Prisma.SpecialPriceWhereUniqueInput); // cast because prisma types expect non-null strings even when fields are nullable

        try {
          await tx.specialPrice.upsert({
            where,
            create: {
              guid: item.guid ?? null,
              ...data,
            },
            update: data,
          });
          results.push({ key, status: 'ok' });
        } catch (err) {
          console.error(`Failed to upsert special price ${key}`, err);
          results.push({ key, status: 'error', error: 'Failed to upsert special price' });
        }
      }
    });

    await safeCompleteSyncRun(runId, results, { rawCount, parsedCount: parsed.items.length });
    return res.json({ success: true, count: results.length, results });
  } catch (error) {
    if (error instanceof ZodError) {
      await safeFailSyncRun(runId, error, baseMeta);
      return handleValidationError(error, res);
    }
    await safeFailSyncRun(runId, error, baseMeta);
    console.error('Unexpected error in special prices batch', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const handleProductPricesBatch = async (req: Request, res: Response) => {
  const rawCount = Array.isArray(req.body?.items) ? req.body.items.length : 0;
  const baseMeta = { rawCount };
  let runId: string | undefined;

  try {
    runId = (await startSyncRun(SyncEntityType.PRODUCT_PRICES, SyncDirection.IMPORT, baseMeta)).id;
  } catch (e) {
    console.error('Failed to start sync run for product prices', e);
  }

  try {
    const parsed = productPricesBatchSchema.parse(req.body);
    const results: BatchResult[] = [];
    const syncedAt = now();

    await prisma.$transaction(async (tx) => {
      const productGuids = Array.from(new Set(parsed.items.map((i) => i.productGuid)));
      const priceTypeGuids = Array.from(
        new Set(parsed.items.map((i) => i.priceTypeGuid).filter(Boolean) as string[])
      );

      const [products, priceTypes] = await Promise.all([
        productGuids.length
          ? tx.product.findMany({ where: { guid: { in: productGuids } } })
          : Promise.resolve([]),
        priceTypeGuids.length
          ? tx.priceType.findMany({ where: { guid: { in: priceTypeGuids } } })
          : Promise.resolve([]),
      ]);

      const productMap = new Map(products.map((p) => [p.guid, p.id]));
      const priceTypeMap = new Map(priceTypes.map((p) => [p.guid, p.id]));

      for (const item of parsed.items) {
        const key = item.guid ?? `${item.productGuid}:${item.priceTypeGuid ?? 'base'}`;
        const productId = productMap.get(item.productGuid);
        if (!productId) {
          results.push({
            key,
            status: 'error',
            error: `Product ${item.productGuid} not found`,
          });
          continue;
        }

        const priceTypeId =
          item.priceTypeGuid !== undefined ? priceTypeMap.get(item.priceTypeGuid) ?? null : null;

        if (item.priceTypeGuid && priceTypeId === null) {
          results.push({
            key,
            status: 'error',
            error: `Price type ${item.priceTypeGuid} not found`,
          });
          continue;
        }

        const sourceUpdatedAt = item.sourceUpdatedAt ?? syncedAt;
        const data = {
          productId,
          priceTypeId,
          price: toDecimal(item.price) ?? new Prisma.Decimal(0),
          currency: item.currency ?? undefined,
          startDate: item.startDate ?? null,
          endDate: item.endDate ?? null,
          minQty: toDecimal(item.minQty),
          isActive: item.isActive ?? true,
          sourceUpdatedAt,
          lastSyncedAt: syncedAt,
        };

        const where: Prisma.ProductPriceWhereUniqueInput = item.guid
          ? { guid: item.guid }
          : ({
              productId_priceTypeId_startDate: {
                productId,
                priceTypeId: priceTypeId ?? null,
                startDate: item.startDate ?? null,
              },
            } as Prisma.ProductPriceWhereUniqueInput);

        try {
          await tx.productPrice.upsert({
            where,
            create: {
              guid: item.guid ?? null,
              ...data,
            },
            update: data,
          });
          results.push({ key, status: 'ok' });
        } catch (err) {
          console.error(`Failed to upsert product price ${key}`, err);
          results.push({ key, status: 'error', error: 'Failed to upsert product price' });
        }
      }
    });

    await safeCompleteSyncRun(runId, results, { rawCount, parsedCount: parsed.items.length });
    return res.json({ success: true, count: results.length, results });
  } catch (error) {
    if (error instanceof ZodError) {
      await safeFailSyncRun(runId, error, baseMeta);
      return handleValidationError(error, res);
    }
    await safeFailSyncRun(runId, error, baseMeta);
    console.error('Unexpected error in product prices batch', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const handleOrdersQueued = async (req: Request, res: Response) => {
  const includeSentRaw = String(req.query.includeSent ?? '').toLowerCase();
  const includeSent = includeSentRaw === '1' || includeSentRaw === 'true' || includeSentRaw === 'yes';
  const requestedLimit = Number(req.query.limit);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 200)
    : 50;

  const statuses = includeSent ? [OrderStatus.QUEUED, OrderStatus.SENT_TO_1C] : [OrderStatus.QUEUED];
  const baseMeta = { includeSent, limit, statuses };
  let runId: string | undefined;

  try {
    runId = (await startSyncRun(SyncEntityType.ORDERS_EXPORT, SyncDirection.EXPORT, baseMeta)).id;
  } catch (e) {
    console.error('Failed to start sync run for orders export', e);
  }

  try {
    const orders = await prisma.order.findMany({
      where: { status: { in: statuses } },
      orderBy: [{ queuedAt: 'asc' }, { createdAt: 'asc' }],
      take: limit,
      select: {
        id: true,
        guid: true,
        status: true,
        queuedAt: true,
        sentTo1cAt: true,
        deliveryDate: true,
        comment: true,
        currency: true,
        totalAmount: true,
        exportAttempts: true,
        lastExportError: true,
        counterparty: {
          select: { guid: true, name: true, inn: true, kpp: true, isActive: true },
        },
        agreement: {
          select: { guid: true, name: true, isActive: true },
        },
        contract: {
          select: { guid: true, number: true, date: true, isActive: true },
        },
        warehouse: {
          select: { guid: true, name: true, isActive: true, isDefault: true, isPickup: true },
        },
        deliveryAddress: {
          select: { guid: true, name: true, fullAddress: true, isActive: true },
        },
        items: {
          orderBy: [{ createdAt: 'asc' }],
          select: {
            id: true,
            quantity: true,
            quantityBase: true,
            price: true,
            discountPercent: true,
            lineAmount: true,
            comment: true,
            product: { select: { guid: true, name: true, sku: true, article: true, isActive: true } },
            package: { select: { guid: true, name: true, isDefault: true } },
            unit: { select: { guid: true, name: true, symbol: true } },
          },
        },
      },
    });

    const payload = orders.map((order) => ({
      guid: order.guid ?? order.id,
      status: order.status,
      queuedAt: order.queuedAt,
      sentTo1cAt: order.sentTo1cAt,
      deliveryDate: order.deliveryDate,
      comment: order.comment,
      currency: order.currency,
      totalAmount: decimalToNumber(order.totalAmount),
      exportAttempts: order.exportAttempts,
      lastExportError: order.lastExportError,
      counterparty: order.counterparty,
      agreement: order.agreement,
      contract: order.contract,
      warehouse: order.warehouse,
      deliveryAddress: order.deliveryAddress,
      items: order.items.map((item) => ({
        id: item.id,
        product: item.product,
        package: item.package,
        unit: item.unit,
        quantity: decimalToNumber(item.quantity),
        quantityBase: decimalToNumber(item.quantityBase),
        price: decimalToNumber(item.price),
        discountPercent: decimalToNumber(item.discountPercent),
        lineAmount: decimalToNumber(item.lineAmount),
        comment: item.comment,
      })),
    }));

    const results: BatchResult[] = payload.map((order) => ({ key: String(order.guid), status: 'ok' }));
    await safeCompleteSyncRun(runId, results, { ...baseMeta, exportedCount: payload.length });

    return res.json({
      success: true,
      count: payload.length,
      orders: payload,
    });
  } catch (error) {
    await safeFailSyncRun(runId, error, baseMeta);
    console.error('Unexpected error in orders queued export', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const handleOrderAck = async (req: Request, res: Response) => {
  const orderGuid = toSingleString(req.params.guid);
  if (!orderGuid) {
    return res.status(400).json({ error: 'Invalid order guid' });
  }
  const baseMeta = { orderGuid };
  let runId: string | undefined;

  try {
    runId = (await startSyncRun(SyncEntityType.ORDERS_EXPORT, SyncDirection.EXPORT, baseMeta)).id;
  } catch (e) {
    console.error('Failed to start sync run for order ack', e);
  }

  try {
    const parsed = orderAckSchema.parse(req.body);
    const syncedAt = now();
    const order = await prisma.order.findUnique({ where: { guid: orderGuid }, select: { id: true, guid: true } });

    if (!order) {
      const results: BatchResult[] = [{ key: orderGuid, status: 'error', error: 'Order not found' }];
      await safeCompleteSyncRun(runId, results, baseMeta, 'Order not found');
      return res.status(404).json({ error: 'Order not found' });
    }

    if (parsed.error) {
      await prisma.order.update({
        where: { id: order.id },
        data: {
          status: OrderStatus.QUEUED,
          exportAttempts: { increment: 1 },
          lastExportError: parsed.error,
          sentTo1cAt: null,
          lastSyncedAt: syncedAt,
          sourceUpdatedAt: parsed.sourceUpdatedAt ?? syncedAt,
        },
      });
      const results: BatchResult[] = [{ key: order.guid ?? orderGuid, status: 'error', error: parsed.error }];
      await safeCompleteSyncRun(runId, results, baseMeta, 'Order export acknowledged with error');
      return res.json({ success: true, acknowledged: true, error: parsed.error });
    }

    const nextStatus = parsed.status ?? OrderStatus.SENT_TO_1C;
    await prisma.order.update({
      where: { id: order.id },
      data: {
        status: nextStatus,
        number1c: parsed.number1c ?? undefined,
        date1c: parsed.date1c ?? undefined,
        sentTo1cAt: parsed.sentTo1cAt ?? syncedAt,
        lastStatusSyncAt: syncedAt,
        exportAttempts: { increment: 1 },
        lastExportError: null,
        lastSyncedAt: syncedAt,
        sourceUpdatedAt: parsed.sourceUpdatedAt ?? syncedAt,
      },
    });

    const results: BatchResult[] = [{ key: order.guid ?? orderGuid, status: 'ok' }];
    await safeCompleteSyncRun(runId, results, { ...baseMeta, status: nextStatus });

    return res.json({ success: true, acknowledged: true, status: nextStatus });
  } catch (error) {
    if (error instanceof ZodError) {
      await safeFailSyncRun(runId, error, baseMeta);
      return handleValidationError(error, res);
    }
    await safeFailSyncRun(runId, error, baseMeta);
    console.error('Unexpected error in order ack', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const handleOrdersStatusBatch = async (req: Request, res: Response) => {
  const rawCount = Array.isArray(req.body?.items) ? req.body.items.length : 0;
  const baseMeta = { rawCount };
  let runId: string | undefined;

  try {
    runId = (await startSyncRun(SyncEntityType.ORDERS_STATUS, SyncDirection.IMPORT, baseMeta)).id;
  } catch (e) {
    console.error('Failed to start sync run for orders status', e);
  }

  try {
    const parsed = ordersStatusBatchSchema.parse(req.body);
    const results: BatchResult[] = [];
    const syncedAt = now();

    await prisma.$transaction(async (tx) => {
      for (const item of parsed.items) {
        const order = await tx.order.findUnique({
          where: { guid: item.guid },
          select: { id: true, guid: true },
        });

        if (!order) {
          results.push({ key: item.guid, status: 'error', error: 'Order not found' });
          continue;
        }

        const data: Prisma.OrderUpdateInput = {
          status: item.status,
          lastStatusSyncAt: syncedAt,
          lastSyncedAt: syncedAt,
          sourceUpdatedAt: item.sourceUpdatedAt ?? syncedAt,
        };

        if (item.number1c !== undefined) data.number1c = item.number1c;
        if (item.date1c !== undefined) data.date1c = item.date1c;
        if (item.comment !== undefined) data.comment = item.comment ?? null;
        if (item.totalAmount !== undefined) data.totalAmount = toDecimal(item.totalAmount);
        if (item.currency !== undefined) data.currency = item.currency;

        try {
          await tx.order.update({ where: { id: order.id }, data });
          results.push({ key: order.guid ?? item.guid, status: 'ok' });
        } catch (err) {
          console.error(`Failed to update order status ${item.guid}`, err);
          results.push({ key: item.guid, status: 'error', error: 'Failed to update order status' });
        }
      }
    });

    await safeCompleteSyncRun(runId, results, { rawCount, parsedCount: parsed.items.length });
    return res.json({ success: true, count: results.length, results });
  } catch (error) {
    if (error instanceof ZodError) {
      await safeFailSyncRun(runId, error, baseMeta);
      return handleValidationError(error, res);
    }
    await safeFailSyncRun(runId, error, baseMeta);
    console.error('Unexpected error in orders status batch', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

const parseEnum = <T extends Record<string, string>>(value: unknown, enumObj: T): T[keyof T] | undefined => {
  if (!value) return undefined;
  const raw = Array.isArray(value) ? value[0] : value;
  const str = String(raw);
  return Object.values(enumObj).includes(str) ? (str as T[keyof T]) : undefined;
};

export const handleSyncRunsList = async (req: Request, res: Response) => {
  const requestedLimit = Number(req.query.limit);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 200)
    : 50;

  const entity = parseEnum(req.query.entity, SyncEntityType);
  const direction = parseEnum(req.query.direction, SyncDirection);
  const status = parseEnum(req.query.status, SyncStatus);

  if (req.query.entity && !entity) {
    return res.status(400).json({ error: 'Invalid entity value' });
  }
  if (req.query.direction && !direction) {
    return res.status(400).json({ error: 'Invalid direction value' });
  }
  if (req.query.status && !status) {
    return res.status(400).json({ error: 'Invalid status value' });
  }

  const where: Prisma.SyncRunWhereInput = {
    ...(entity ? { entity } : {}),
    ...(direction ? { direction } : {}),
    ...(status ? { status } : {}),
  };

  try {
    const runs = await prisma.syncRun.findMany({
      where,
      orderBy: [{ startedAt: 'desc' }],
      take: limit,
      select: {
        id: true,
        requestId: true,
        entity: true,
        direction: true,
        status: true,
        totalCount: true,
        successCount: true,
        errorCount: true,
        startedAt: true,
        finishedAt: true,
        notes: true,
        meta: true,
      },
    });

    const payload = runs.map((run) => ({
      ...run,
      itemsCount: run.totalCount,
    }));

    return res.json({ success: true, count: payload.length, runs: payload });
  } catch (error) {
    console.error('Unexpected error in sync runs list', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const handleSyncRunDetail = async (req: Request, res: Response) => {
  const runId = toSingleString(req.params.runId);
  if (!runId) {
    return res.status(400).json({ error: 'Invalid run id' });
  }
  const includeItemsRaw = String(req.query.includeItems ?? '').toLowerCase();
  const includeItems =
    includeItemsRaw === '1' || includeItemsRaw === 'true' || includeItemsRaw === 'yes';
  const requestedLimit = Number(req.query.itemsLimit);
  const itemsLimit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 500)
    : 200;

  try {
    const run = await prisma.syncRun.findUnique({
      where: { id: runId },
      select: {
        id: true,
        requestId: true,
        entity: true,
        direction: true,
        status: true,
        totalCount: true,
        successCount: true,
        errorCount: true,
        startedAt: true,
        finishedAt: true,
        notes: true,
        meta: true,
        items: includeItems
          ? {
              take: itemsLimit,
              orderBy: [{ createdAt: 'desc' }],
              select: {
                id: true,
                key: true,
                status: true,
                error: true,
                createdAt: true,
              },
            }
          : false,
      },
    });

    if (!run) {
      return res.status(404).json({ error: 'Sync run not found' });
    }

    const payload = {
      ...run,
      itemsCount: run.totalCount,
    };

    return res.json({ success: true, run: payload });
  } catch (error) {
    console.error('Unexpected error in sync run detail', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
