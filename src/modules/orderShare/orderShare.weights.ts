import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';

export type WeightReferences = Record<string, string>;
const number = (value: unknown) => {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  try { const result = new Prisma.Decimal(String(value)); return result.isFinite() && result.gt(0) ? result : null; }
  catch { return null; }
};
const normalize = (value: unknown) => typeof value === 'string' ? value.trim().toLowerCase().replace(/[.\s]/g, '') : '';
const guid = (value: any) => normalize(value?.guid);

/** Only explicit mass units. Never extract a weight from a product/package name. */
function unitKg(unit: any): Prisma.Decimal | null {
  const names = [unit?.symbol, unit?.name, unit?.code].map(normalize);
  if (names.some(name => ['кг','kg','килограмм','килограммы','166'].includes(name))) return new Prisma.Decimal(1);
  if (names.some(name => ['г','g','гр','грамм','граммы','163'].includes(name))) return new Prisma.Decimal('0.001');
  if (names.some(name => ['т','t','тонна','тонны','168'].includes(name))) return new Prisma.Decimal(1000);
  return null;
}
function explicitKg(value: unknown, unit: any) {
  const weight = number(value);
  if (!weight) return null;
  // Existing LP App weight/packageWeight values are kg when weightUnit is absent.
  const factor = unit == null ? new Prisma.Decimal(1) : unitKg(unit);
  return factor ? weight.mul(factor) : null;
}
const multiplier = (item: any) => item.package ? number(item.package.multiplier ?? 1) : new Prisma.Decimal(1);

/** Identity excludes quantity so editing quantity recomputes, never reuses a line total. */
export function orderWeightKey(item: any) {
  return createHash('sha256').update(JSON.stringify([
    normalize(item.product?.guid), guid(item.product?.baseUnit),
    guid(item.package), guid(item.package?.unit), guid(item.unit),
    normalize(item.package?.name), normalize(item.unit?.symbol || item.unit?.name), multiplier(item)?.toString() ?? null,
  ])).digest('hex');
}

export function orderUnitWeightKg(item: any): Prisma.Decimal | null {
  const coefficient = multiplier(item);
  if (!coefficient) return null;
  const packWeight = explicitKg(item.package?.weight, item.package?.weightUnit);
  if (packWeight) return packWeight;
  // A direct kg/g/t quantity is already a mass, not a count of catalog pieces.
  // A named package is not itself a kilogram just because its contained unit is kg.
  if (!item.package) {
    const lineMassUnit = unitKg(item.unit);
    if (lineMassUnit) return lineMassUnit;
  }
  const baseWeight = explicitKg(item.product?.weight, item.product?.weightUnit) ?? unitKg(item.product?.baseUnit);
  if (baseWeight) return baseWeight.mul(coefficient);
  return null;
}

export function orderLineWeightKg(item: any, references: unknown = {}): string | null {
  if (item.isCancelled) return null;
  const quantity = number(item.quantity);
  if (!quantity) return null;
  const cached = references && typeof references === 'object' && !Array.isArray(references)
    ? number((references as WeightReferences)[orderWeightKey(item)]) : null;
  const perUnit = orderUnitWeightKg(item) ?? cached;
  return perUnit ? quantity.mul(perUnit).toString() : null;
}

export function summarizeShareWeights(items: Array<{ weightKg?: unknown }>) {
  let total = new Prisma.Decimal(0);
  let known = 0;
  for (const item of items) {
    const weight = number(item.weightKg);
    if (weight) { total = total.add(weight); known++; }
  }
  return { totalWeightKg: known || !items.length ? total.toString() : null,
    weightComplete: known === items.length, missingWeightItems: items.length - known };
}

/** Only exact product/package identities from the already-authorized order. */
export function collectWeightReferences(items: any[], products: any[]): WeightReferences {
  const byGuid = new Map(products.map(product => [normalize(product.guid), product]));
  const result: WeightReferences = {};
  for (const item of items.filter(row => !row.isCancelled)) {
    const product = byGuid.get(normalize(item.product?.guid));
    if (!product) continue;
    const originalBaseUnit = item.product?.baseUnit;
    if (guid(originalBaseUnit) && guid(product.baseUnit) && guid(originalBaseUnit) !== guid(product.baseUnit)) continue;
    const livePackage = item.package?.guid
      ? product.packages?.find((pack: any) => guid(pack) === guid(item.package)) : null;
    // Never apply a redefined package's mass to an older, different coefficient.
    const samePackageUnit = !guid(item.package?.unit) || !guid(livePackage?.unit)
      || guid(item.package.unit) === guid(livePackage.unit);
    const samePackage = livePackage && samePackageUnit && number(livePackage.multiplier)?.eq(multiplier(item) ?? -1);
    const unitWeight = orderUnitWeightKg({ ...item, product,
      package: item.package ? { ...item.package, weight: samePackage ? livePackage.weight : null,
        weightUnit: samePackage ? livePackage.weightUnit : null } : null });
    if (unitWeight) result[orderWeightKey(item)] = unitWeight.toString();
  }
  return result;
}
