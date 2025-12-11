import { Prisma } from '@prisma/client';
import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { fromZodError } from 'zod-validation-error';
import prisma from '../../prisma/client';
import {
  agreementsBatchSchema,
  counterpartiesBatchSchema,
  nomenclatureBatchSchema,
  specialPricesBatchSchema,
  stockBatchSchema,
  warehousesBatchSchema,
} from './onec.schemas';

type BatchResult = { key: string; status: 'ok' | 'error'; error?: string };

const toDecimal = (value?: number | null) =>
  value === undefined || value === null ? undefined : new Prisma.Decimal(value);

const handleValidationError = (error: ZodError<unknown>, res: Response) => {
  const validationError = fromZodError(error as any);
  return res.status(400).json({
    error: 'Validation error',
    details: (validationError as any).details ?? validationError.message,
  });
};

export const onecAuthMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const secret = req.body?.secret;
  if (!secret || secret !== process.env.ONEC_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
};

export const handleNomenclatureBatch = async (req: Request, res: Response) => {
  try {
    const parsed = nomenclatureBatchSchema.parse(req.body);
    const results: BatchResult[] = [];

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

          const saved = await tx.productGroup.upsert({
            where: { guid: group.guid },
            create: {
              guid: group.guid,
              name: group.name,
              code: group.code,
              isActive: group.isActive ?? true,
              parentId: parentId ?? null,
            },
            update: {
              name: group.name,
              code: group.code,
              isActive: group.isActive ?? true,
              parentId: parentId ?? null,
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
            const baseUnit = await tx.unit.upsert({
              where: { guid: product.baseUnit.guid },
              create: {
                guid: product.baseUnit.guid,
                name: product.baseUnit.name,
                code: product.baseUnit.code,
                symbol: product.baseUnit.symbol,
              },
              update: {
                name: product.baseUnit.name,
                code: product.baseUnit.code,
                symbol: product.baseUnit.symbol,
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
            },
          });

          if (product.packages?.length) {
            for (const pack of product.packages) {
              const unit = await tx.unit.upsert({
                where: { guid: pack.unit.guid },
                create: {
                  guid: pack.unit.guid,
                  name: pack.unit.name,
                  code: pack.unit.code,
                  symbol: pack.unit.symbol,
                },
                update: {
                  name: pack.unit.name,
                  code: pack.unit.code,
                  symbol: pack.unit.symbol,
                },
              });

              const packageData = {
                productId: savedProduct.id,
                unitId: unit.id,
                name: pack.name,
                multiplier: toDecimal(pack.multiplier) ?? new Prisma.Decimal(1),
                barcode: pack.barcode,
                isDefault: pack.isDefault ?? false,
                sortOrder: pack.sortOrder ?? 0,
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

    return res.json({ success: true, count: results.length, results });
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(error, res);
    }
    console.error('Unexpected error in nomenclature batch', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const handleStockBatch = async (req: Request, res: Response) => {
  try {
    const parsed = stockBatchSchema.parse(req.body);
    const results: BatchResult[] = [];

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
            },
            update: {
              quantity: toDecimal(item.quantity) ?? new Prisma.Decimal(0),
              reserved: toDecimal(item.reserved),
              updatedAt: item.updatedAt,
            },
          });
          results.push({ key, status: 'ok' });
        } catch (err) {
          console.error(`Failed to upsert stock for ${key}`, err);
          results.push({ key, status: 'error', error: 'Failed to upsert stock' });
        }
      }
    });

    return res.json({ success: true, count: results.length, results });
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(error, res);
    }
    console.error('Unexpected error in stock batch', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const handleCounterpartiesBatch = async (req: Request, res: Response) => {
  try {
    const parsed = counterpartiesBatchSchema.parse(req.body);
    const results: BatchResult[] = [];

    await prisma.$transaction(async (tx) => {
      for (const item of parsed.items) {
        try {
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
            },
            update: {
              name: item.name,
              fullName: item.fullName ?? undefined,
              inn: item.inn ?? undefined,
              kpp: item.kpp ?? undefined,
              phone: item.phone ?? undefined,
              email: item.email ?? undefined,
              isActive: item.isActive ?? true,
            },
          });

          if (item.addresses?.length) {
            for (const address of item.addresses) {
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

    return res.json({ success: true, count: results.length, results });
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(error, res);
    }
    console.error('Unexpected error in counterparties batch', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const handleWarehousesBatch = async (req: Request, res: Response) => {
  try {
    const parsed = warehousesBatchSchema.parse(req.body);
    const results: BatchResult[] = [];

    await prisma.$transaction(async (tx) => {
      for (const item of parsed.items) {
        try {
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
            },
            update: {
              name: item.name,
              code: item.code ?? undefined,
              isActive: item.isActive ?? true,
              isDefault: item.isDefault ?? false,
              isPickup: item.isPickup ?? false,
              address: item.address ?? undefined,
            },
          });

          results.push({ key: item.guid, status: 'ok' });
        } catch (err) {
          console.error(`Failed to upsert warehouse ${item.guid}`, err);
          results.push({ key: item.guid, status: 'error', error: 'Failed to upsert warehouse' });
        }
      }
    });

    return res.json({ success: true, count: results.length, results });
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(error, res);
    }
    console.error('Unexpected error in warehouses batch', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const handleAgreementsBatch = async (req: Request, res: Response) => {
  try {
    const parsed = agreementsBatchSchema.parse(req.body);
    const results: BatchResult[] = [];

    await prisma.$transaction(async (tx) => {
      for (const item of parsed.items) {
        const agreementKey = item.agreement.guid;
        try {
          let priceTypeId: string | undefined;
          if (item.priceType) {
            const priceType = await tx.priceType.upsert({
              where: { guid: item.priceType.guid },
              create: {
                guid: item.priceType.guid,
                name: item.priceType.name,
                code: item.priceType.code ?? undefined,
                isActive: item.priceType.isActive ?? true,
              },
              update: {
                name: item.priceType.name,
                code: item.priceType.code ?? undefined,
                isActive: item.priceType.isActive ?? true,
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
            },
            update: {
              counterpartyId: counterparty.id,
              number: item.contract.number,
              date: item.contract.date,
              validFrom: item.contract.validFrom ?? null,
              validTo: item.contract.validTo ?? null,
              isActive: item.contract.isActive ?? true,
              comment: item.contract.comment ?? undefined,
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
            },
            update: {
              name: item.agreement.name,
              counterpartyId: agreementCounterpartyId ?? null,
              contractId: contract.id,
              priceTypeId: agreementPriceTypeId ?? null,
              warehouseId: warehouseId ?? null,
              currency: item.agreement.currency ?? undefined,
              isActive: item.agreement.isActive ?? true,
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

    return res.json({ success: true, count: results.length, results });
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(error, res);
    }
    console.error('Unexpected error in agreements batch', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const handleSpecialPricesBatch = async (req: Request, res: Response) => {
  try {
    const parsed = specialPricesBatchSchema.parse(req.body);
    const results: BatchResult[] = [];

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

    return res.json({ success: true, count: results.length, results });
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(error, res);
    }
    console.error('Unexpected error in special prices batch', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
