/** 1C delivery dates are calendar values; never shift them by the host timezone. */
export function orderCalendarDate(value: Date | string | null | undefined): string | null {
  const text = value instanceof Date ? (Number.isFinite(value.getTime()) ? value.toISOString() : '') : String(value || '');
  const key = /^(\d{4}-\d{2}-\d{2})(?:T|$)/.exec(text)?.[1];
  if (!key) return null;
  const date = new Date(`${key}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === key ? key : null;
}
export function matchesDeliveryDateRange(value: Date | string | null | undefined, from?: Date, to?: Date) {
  const date = orderCalendarDate(value), start = orderCalendarDate(from), end = orderCalendarDate(to);
  return (!start || (!!date && date >= start)) && (!end || (!!date && date <= end));
}
