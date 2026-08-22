import type {
  CounterpartyCardAvailability,
  CounterpartyCardBootstrap,
  CounterpartyCardPermissions,
  CounterpartyCommercialTerms,
  CounterpartyContact,
  CounterpartyFinanceSummary,
  CounterpartyFinancialDocument,
  CounterpartyFinancialDocumentsSummary,
  CounterpartyFinancialDocumentsPage,
  CounterpartyIncomingPayment,
  CounterpartyOrganizationSummary,
  CounterpartyPaymentDiscipline,
  CounterpartyPeriodPreset,
  CounterpartyRecentOrder,
  CounterpartySalesSummary,
  CounterpartySectionAvailability,
  CounterpartyUpcomingPayment,
} from './counterparties.types';

type RecordValue = Record<string, unknown>;

const record = (value: unknown): RecordValue | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;

function value(source: RecordValue | null, ...keys: string[]) {
  if (!source) return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) return source[key];
    const actualKey = Object.keys(source).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
    if (actualKey) return source[actualKey];
  }
  return undefined;
}

const object = (source: RecordValue | null, ...keys: string[]) => record(value(source, ...keys));
const array = (source: RecordValue | null, ...keys: string[]) => {
  const candidate = value(source, ...keys);
  return Array.isArray(candidate) ? candidate : [];
};

function text(source: RecordValue | null, keys: string[], fallback: string | null = null) {
  const candidate = value(source, ...keys);
  if (candidate === undefined || candidate === null) return fallback;
  const normalized = String(candidate).trim();
  return normalized || fallback;
}

function numberOrNull(source: RecordValue | null, keys: string[]) {
  const candidate = value(source, ...keys);
  if (typeof candidate === 'number') return Number.isFinite(candidate) ? candidate : null;
  if (typeof candidate !== 'string' || !candidate.trim()) return null;
  const parsed = Number(candidate.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function roundedToOneDecimal(value: number | null) {
  return value === null ? null : Math.round((value + Number.EPSILON) * 10) / 10;
}

function booleanOrNull(source: RecordValue | null, keys: string[]) {
  const candidate = value(source, ...keys);
  if (typeof candidate === 'boolean') return candidate;
  if (typeof candidate === 'number') return candidate !== 0;
  if (typeof candidate === 'string') {
    const normalized = candidate.trim().toLowerCase();
    if (['true', '1', 'yes', 'истина'].includes(normalized)) return true;
    if (['false', '0', 'no', 'ложь'].includes(normalized)) return false;
  }
  return null;
}

function humanOrderStatus(raw: string | null) {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const labels: Record<string, string> = {
    shipment_pr: '\u0412 \u043f\u0440\u043e\u0446\u0435\u0441\u0441\u0435 \u043e\u0442\u0433\u0440\u0443\u0437\u043a\u0438',
    shipment: '\u041a \u043e\u0442\u0433\u0440\u0443\u0437\u043a\u0435',
    to_shipment: '\u041a \u043e\u0442\u0433\u0440\u0443\u0437\u043a\u0435',
    closed: '\u0417\u0430\u043a\u0440\u044b\u0442',
    draft: '\u0427\u0435\u0440\u043d\u043e\u0432\u0438\u043a',
    cancelled: '\u041e\u0442\u043c\u0435\u043d\u0451\u043d',
    canceled: '\u041e\u0442\u043c\u0435\u043d\u0451\u043d',
    has_debt: '\u0415\u0441\u0442\u044c \u0434\u043e\u043b\u0433',
    overdue: '\u0415\u0441\u0442\u044c \u043f\u0440\u043e\u0441\u0440\u043e\u0447\u043a\u0430',
    shipment_prohibited: '\u041e\u0442\u0433\u0440\u0443\u0437\u043a\u0430 \u0437\u0430\u043f\u0440\u0435\u0449\u0435\u043d\u0430',
    ok: '\u0414\u043e\u043b\u0433\u0430 \u043d\u0435\u0442',
    normal: '\u0414\u043e\u043b\u0433\u0430 \u043d\u0435\u0442',
  };
  return labels[normalized] ?? raw;
}

function paymentTypeLabel(code: string | null) {
  if (!code) return null;
  const normalized = code.trim().toUpperCase().replace(/[\s-]+/g, '_');
  const labels: Record<string, string> = {
    BANK_RECEIPT: '\u041f\u043e\u0441\u0442\u0443\u043f\u043b\u0435\u043d\u0438\u0435 \u043d\u0430 \u0431\u0430\u043d\u043a\u043e\u0432\u0441\u043a\u0438\u0439 \u0441\u0447\u0451\u0442',
    BANK_RECIEPT: '\u041f\u043e\u0441\u0442\u0443\u043f\u043b\u0435\u043d\u0438\u0435 \u043d\u0430 \u0431\u0430\u043d\u043a\u043e\u0432\u0441\u043a\u0438\u0439 \u0441\u0447\u0451\u0442',
    CASH_RECEIPT: '\u041f\u043e\u0441\u0442\u0443\u043f\u043b\u0435\u043d\u0438\u0435 \u043d\u0430\u043b\u0438\u0447\u043d\u044b\u0445',
    ACQUIRING_RECEIPT: '\u041e\u043f\u043b\u0430\u0442\u0430 \u043f\u043b\u0430\u0442\u0451\u0436\u043d\u043e\u0439 \u043a\u0430\u0440\u0442\u043e\u0439',
    CARD_RECEIPT: '\u041e\u043f\u043b\u0430\u0442\u0430 \u043f\u043b\u0430\u0442\u0451\u0436\u043d\u043e\u0439 \u043a\u0430\u0440\u0442\u043e\u0439',
    PAYMENT_CARD_RECEIPT: '\u041e\u043f\u043b\u0430\u0442\u0430 \u043f\u043b\u0430\u0442\u0451\u0436\u043d\u043e\u0439 \u043a\u0430\u0440\u0442\u043e\u0439',
    BANK_REFUND: '\u0412\u043e\u0437\u0432\u0440\u0430\u0442 \u043d\u0430 \u0431\u0430\u043d\u043a\u043e\u0432\u0441\u043a\u0438\u0439 \u0441\u0447\u0451\u0442',
    CASH_REFUND: '\u0412\u043e\u0437\u0432\u0440\u0430\u0442 \u043d\u0430\u043b\u0438\u0447\u043d\u044b\u043c\u0438',
    ACQUIRING_REFUND: '\u0412\u043e\u0437\u0432\u0440\u0430\u0442 \u043d\u0430 \u043f\u043b\u0430\u0442\u0451\u0436\u043d\u0443\u044e \u043a\u0430\u0440\u0442\u0443',
    REFUND: '\u0412\u043e\u0437\u0432\u0440\u0430\u0442 \u043a\u043b\u0438\u0435\u043d\u0442\u0443',
  };
  return labels[normalized] ?? code;
}

function periodPresetOrNull(source: RecordValue | null): CounterpartyPeriodPreset | null {
  const candidate = text(source, ['periodPreset', 'period']);
  const normalized = candidate === 'half-year' ? 'halfYear' : candidate;
  return normalized && ['week', 'month', 'quarter', 'halfYear', 'year', 'custom'].includes(normalized)
    ? normalized as CounterpartyPeriodPreset
    : null;
}

function sectionAvailability(
  sections: RecordValue | null,
  keys: string[],
  fallback: CounterpartySectionAvailability
): CounterpartySectionAvailability {
  const section = object(sections, ...keys);
  if (!section) return fallback;
  const explicit = text(section, ['status', 'availability']);
  if (explicit && ['available', 'forbidden', 'unavailable'].includes(explicit.toLowerCase())) {
    return explicit.toLowerCase() as CounterpartySectionAvailability;
  }
  const available = booleanOrNull(section, ['available']);
  return available === true ? 'available' : available === false ? 'unavailable' : fallback;
}

function unwrap(payload: unknown) {
  let current = record(payload);
  for (let depth = 0; current && depth < 4; depth += 1) {
    const candidate = value(current, 'item', 'data', 'result', 'body');
    if (typeof candidate === 'string') {
      try {
        current = record(JSON.parse(candidate));
        continue;
      } catch {
        break;
      }
    }
    const next = record(candidate);
    if (!next) break;
    current = next;
  }
  return current;
}

function mapFinance(source: RecordValue | null): CounterpartyFinanceSummary | null {
  if (!source || booleanOrNull(source, ['available']) === false) return null;
  return {
    debtTotal: numberOrNull(source, ['debtTotal']),
    overdueDebt: numberOrNull(source, ['overdueDebt']),
    notDueDebt: numberOrNull(source, ['notDueDebt']),
    prepayment: numberOrNull(source, ['prepayment']),
    creditLimit: numberOrNull(source, ['creditLimit']),
    availableCreditLimit: numberOrNull(source, ['availableCreditLimit']),
    creditLimitExceeded: booleanOrNull(source, ['creditLimitExceeded']),
    shipmentProhibited: booleanOrNull(source, ['shipmentProhibited']),
    shipmentProhibitionReason: text(source, ['shipmentProhibitionReason']),
    currency: text(source, ['currency']),
    nearestPaymentDate: text(source, ['nearestPaymentDate']),
    nearestPaymentAmount: numberOrNull(source, ['nearestPaymentAmount']),
    maxOverdueDays: numberOrNull(source, ['maxOverdueDays']),
    paymentTermDays: numberOrNull(source, ['paymentTermDays']),
    paymentTermSource: text(source, ['paymentTermSource', 'paymentTermsSource']),
    agreementGuid: text(source, ['agreementGuid']),
    agreementName: text(source, ['agreementName']),
  };
}

function mapSales(source: RecordValue | null): CounterpartySalesSummary | null {
  if (!source || booleanOrNull(source, ['available']) === false) return null;
  const mapChartSeries = (...keys: string[]) => array(source, ...keys).flatMap((candidate) => {
    const point = record(candidate);
    if (!point) return [];
    return [{
      periodFrom: text(point, ['periodFrom', 'dateFrom']),
      periodTo: text(point, ['periodTo', 'dateTo', 'date']),
      label: text(point, ['label']),
      salesAmount: numberOrNull(point, ['salesAmount', 'amount']),
      ordersCount: numberOrNull(point, ['ordersCount', 'salesDocumentsCount']),
      salesDocumentsCount: numberOrNull(point, ['salesDocumentsCount', 'ordersCount']),
      profit: numberOrNull(point, ['profit', 'grossProfit', 'margin']),
      profitabilityPercent: numberOrNull(point, ['profitabilityPercent', 'marginPercent', 'profitability']),
    }];
  });
  return {
    periodPreset: periodPresetOrNull(source),
    chartGranularity: text(source, ['chartGranularity']),
    periodFrom: text(source, ['periodFrom']),
    periodTo: text(source, ['periodTo']),
    compareFrom: text(source, ['compareFrom']),
    compareTo: text(source, ['compareTo']),
    salesAmount: numberOrNull(source, ['salesAmount']),
    previousSalesAmount: numberOrNull(source, ['previousSalesAmount']),
    salesChangePercent: numberOrNull(source, ['salesChangePercent']),
    profit: numberOrNull(source, ['profit', 'grossProfit', 'margin']),
    profitabilityPercent: numberOrNull(source, ['profitabilityPercent', 'marginPercent', 'profitability']),
    previousProfit: numberOrNull(source, ['previousProfit', 'compareProfit', 'priorProfit']),
    previousProfitabilityPercent: numberOrNull(source, [
      'previousProfitabilityPercent', 'previousProfitability', 'compareProfitabilityPercent', 'priorProfitabilityPercent',
    ]),
    comparisonAvailable: booleanOrNull(source, ['comparisonAvailable', 'compareAvailable']),
    comparisonUnavailableReason: text(source, [
      'comparisonUnavailableReason', 'comparisonReason', 'compareUnavailableReason',
    ]),
    dataReliableFrom: text(source, ['dataReliableFrom', 'reliableDataFrom']),
    ordersCount: numberOrNull(source, ['ordersCount']),
    averageCheck: numberOrNull(source, ['averageCheck']),
    lastOrderDate: text(source, ['lastOrderDate']),
    lastOrderAmount: numberOrNull(source, ['lastOrderAmount']),
    daysSinceLastOrder: numberOrNull(source, ['daysSinceLastOrder']),
    averageOrderIntervalDays: roundedToOneDecimal(numberOrNull(source, ['averageOrderIntervalDays'])),
    orderFrequencyDays: roundedToOneDecimal(numberOrNull(source, ['orderFrequencyDays', 'averageOrderIntervalDays'])),
    currency: text(source, ['currency']),
    chartSeries: mapChartSeries('chartSeries', 'series'),
    comparisonChartSeries: mapChartSeries('comparisonChartSeries', 'compareSeries', 'previousChartSeries'),
  };
}

function mapTerms(source: RecordValue | null): CounterpartyCommercialTerms | null {
  if (!source || booleanOrNull(source, ['available']) === false) return null;
  return {
    agreementGuid: text(source, ['agreementGuid']),
    agreementName: text(source, ['agreementName']),
    contractGuid: text(source, ['contractGuid']),
    contractName: text(source, ['contractName']),
    priceTypeGuid: text(source, ['priceTypeGuid']),
    priceTypeName: text(source, ['priceTypeName']),
    currency: text(source, ['currency']),
    paymentForm: text(source, ['paymentForm']),
    paymentTerms: text(source, ['paymentTerms']),
    deliveryMethod: text(source, ['deliveryMethod']),
    deliveryTerms: text(source, ['deliveryTerms']),
  };
}

function mapOrders(source: RecordValue | null): CounterpartyRecentOrder[] {
  return array(source, 'recentOrders', 'orders').flatMap((candidate): CounterpartyRecentOrder[] => {
    const item = record(candidate);
    const guid = text(item, ['guid', 'orderGuid']);
    if (!item || !guid) return [];
    return [{
      guid,
      number: text(item, ['number']),
      date: text(item, ['date']),
      shipmentDate: text(item, ['shipmentDate']),
      status: humanOrderStatus(text(item, ['status', 'statusCode'])),
      amount: numberOrNull(item, ['amount']),
      currency: text(item, ['currency']),
      itemsCount: numberOrNull(item, ['itemsCount']),
    }];
  });
}

function mapOrganizations(root: RecordValue | null, context: RecordValue | null): CounterpartyOrganizationSummary[] {
  const candidates = [
    ...array(root, 'organizationOptions'),
    ...array(context, 'organizationOptions', 'availableOrganizations'),
  ];
  const unique = new Map<string, CounterpartyOrganizationSummary>();
  for (const candidate of candidates) {
    const item = record(candidate);
    const guid = text(item, ['guid', 'organizationGuid']);
    const name = text(item, ['name', 'organizationName']);
    if (guid && name) unique.set(guid.toLowerCase(), { guid, name });
  }
  return [...unique.values()];
}

function mapIncomingPayments(root: RecordValue | null): CounterpartyIncomingPayment[] {
  return array(root, 'incomingPayments', 'payments', 'receipts').flatMap((candidate) => {
    const item = record(candidate);
    const guid = text(item, ['guid', 'paymentGuid', 'documentGuid']);
    if (!item || !guid) return [];
    const typeCode = text(item, ['typeCode', 'type', 'documentType']);
    return [{
      guid,
      number: text(item, ['number', 'documentNumber']),
      date: text(item, ['date', 'documentDate']),
      amount: numberOrNull(item, ['amount']),
      currency: text(item, ['currency']),
      type: typeCode,
      typeCode,
      typeLabel: text(item, ['typeLabel'])
        || text(item, ['documentTypeLabel', 'documentTypeName'])
        || paymentTypeLabel(typeCode),
      organizationGuid: text(item, ['organizationGuid']),
      organizationName: text(item, ['organizationName']),
    }];
  });
}

function mapUpcomingPayments(root: RecordValue | null): CounterpartyUpcomingPayment[] {
  return array(root, 'upcomingPayments', 'scheduledPayments', 'nearestPayments').flatMap((candidate) => {
    const item = record(candidate);
    const guid = text(item, ['guid', 'documentGuid', 'paymentGuid']);
    if (!item || !guid) return [];
    const rawStatus = text(item, ['status'], 'EXPECTED')?.toUpperCase();
    return [{
      guid,
      number: text(item, ['number', 'documentNumber']),
      date: text(item, ['date', 'documentDate']),
      dueDate: text(item, ['dueDate', 'paymentDate', 'dateDue']),
      amount: numberOrNull(item, ['amount', 'paymentAmount']),
      currency: text(item, ['currency']),
      status: rawStatus === 'OVERDUE' ? 'OVERDUE' : 'EXPECTED',
      overdueDays: Math.max(0, numberOrNull(item, ['overdueDays', 'daysOverdue']) ?? 0),
    }];
  });
}

function mapPaymentDiscipline(root: RecordValue | null): CounterpartyPaymentDiscipline | null {
  const source = object(root, 'paymentDiscipline', 'discipline');
  if (!source || booleanOrNull(source, ['available']) === false) return null;
  return {
    available: true,
    periodFrom: text(source, ['periodFrom']),
    periodTo: text(source, ['periodTo']),
    settledDocumentsCount: Math.max(0, numberOrNull(source, ['settledDocumentsCount', 'documentsCount']) ?? 0),
    overdueDocumentsCount: Math.max(0, numberOrNull(source, ['overdueDocumentsCount']) ?? 0),
    paidOnTimePercent: numberOrNull(source, ['paidOnTimePercent', 'onTimePercent']),
    averageDelayDays: numberOrNull(source, ['averageDelayDays', 'averageOverdueDays']),
    totalSettledAmount: numberOrNull(source, ['totalSettledAmount']) ?? 0,
    onTimeSettledAmount: numberOrNull(source, ['onTimeSettledAmount']) ?? 0,
    currency: text(source, ['currency']),
  };
}

function mapFinancialDocuments(
  root: RecordValue | null,
  legacyUpcomingPayments: CounterpartyUpcomingPayment[]
): CounterpartyFinancialDocument[] {
  const sourceDocuments = array(root, 'financialDocuments', 'financeDocuments');
  if (sourceDocuments.length === 0) {
    return legacyUpcomingPayments.map((item) => ({
      documentGuid: item.guid,
      documentTypeCode: null,
      documentTypeName: null,
      number: item.number,
      date: item.date,
      status: item.status,
      dueDate: item.dueDate,
      shipmentDate: null,
      daysOverdue: item.overdueDays,
      daysRemaining: null,
      outstandingAmount: item.amount,
      amount: item.amount,
      currency: item.currency,
      organizationGuid: null,
      organizationName: null,
    }));
  }

  return sourceDocuments.flatMap((candidate): CounterpartyFinancialDocument[] => {
    const item = record(candidate);
    const documentGuid = text(item, ['documentGuid', 'guid', 'paymentGuid']);
    if (!item || !documentGuid) return [];
    const rawStatus = text(item, ['status', 'documentStatus'])?.toUpperCase();
    const status = rawStatus && ['OVERDUE', 'EXPECTED', 'AWAITING_SHIPMENT', 'PAID'].includes(rawStatus)
      ? rawStatus as CounterpartyFinancialDocument['status']
      : null;
    return [{
      documentGuid,
      documentTypeCode: text(item, ['documentTypeCode', 'typeCode', 'documentType', 'type']),
      documentTypeName: text(item, ['documentTypeName', 'typeLabel', 'documentTypeLabel']),
      number: text(item, ['number', 'documentNumber']),
      date: text(item, ['date', 'documentDate']),
      status,
      dueDate: text(item, ['dueDate', 'paymentDate', 'dateDue']),
      shipmentDate: text(item, ['shipmentDate']),
      daysOverdue: numberOrNull(item, ['daysOverdue', 'overdueDays']),
      daysRemaining: numberOrNull(item, ['daysRemaining', 'remainingDays']),
      outstandingAmount: numberOrNull(item, ['outstandingAmount', 'debtAmount', 'remainingAmount']),
      amount: numberOrNull(item, ['amount', 'documentAmount']),
      currency: text(item, ['currency']),
      organizationGuid: text(item, ['organizationGuid']),
      organizationName: text(item, ['organizationName']),
    }];
  });
}

function mapFinancialDocumentsSummary(
  root: RecordValue | null,
  documents: CounterpartyFinancialDocument[]
): CounterpartyFinancialDocumentsSummary {
  const source = object(root, 'financialDocumentsSummary', 'financeDocumentsSummary', 'documentsSummary');
  const fallback = {
    totalCount: documents.length,
    overdueCount: documents.filter((item) => item.status === 'OVERDUE').length,
    pendingCount: documents.filter((item) => item.status === 'EXPECTED' || item.status === 'OVERDUE').length,
    awaitingShipmentCount: documents.filter((item) => item.status === 'AWAITING_SHIPMENT').length,
  };
  if (!source) return fallback;
  return {
    totalCount: Math.max(0, numberOrNull(source, ['totalCount', 'documentsCount']) ?? fallback.totalCount),
    overdueCount: Math.max(0, numberOrNull(source, ['overdueCount', 'overdueDocumentsCount']) ?? fallback.overdueCount),
    pendingCount: Math.max(0, numberOrNull(source, ['pendingCount', 'paymentRequiredCount', 'expectedCount']) ?? fallback.pendingCount),
    awaitingShipmentCount: Math.max(0, numberOrNull(source, [
      'awaitingShipmentCount', 'shipmentPendingCount',
    ]) ?? fallback.awaitingShipmentCount),
  };
}

export function mapOnecCounterpartyFinancialDocumentsPage(payload: unknown): Omit<CounterpartyFinancialDocumentsPage, 'nextCursor' | 'stale'> & { nextOffset: number | null } {
  const root = unwrap(payload);
  if (!root) throw new Error('1C returned an incomplete financial documents page');
  const itemsRoot = { financialDocuments: value(root, 'items', 'financialDocuments') };
  const items = mapFinancialDocuments(itemsRoot, []);
  const summaryRoot = { financialDocumentsSummary: value(root, 'summary', 'financialDocumentsSummary') };
  return {
    items,
    summary: mapFinancialDocumentsSummary(summaryRoot, items),
    hasMore: booleanOrNull(root, ['hasMore']) ?? false,
    nextOffset: numberOrNull(root, ['nextOffset']),
    asOf: text(root, ['calculatedAt', 'asOf'], new Date().toISOString()) ?? new Date().toISOString(),
    sourceVersion: text(root, ['sourceVersion'], 'counterparty-financial-documents-v1') ?? 'counterparty-financial-documents-v1',
  };
}

function mapContacts(source: RecordValue | null): CounterpartyContact[] {
  return array(source, 'contacts').flatMap((candidate): CounterpartyContact[] => {
    const item = record(candidate);
    const contactValue = text(item, ['value', 'presentation']);
    if (!item || !contactValue) return [];
    const kindCode = text(item, ['kindCode', 'kind', 'type']);
    return [{
      kind: kindCode,
      kindCode,
      label: text(item, ['label', 'name']),
      value: contactValue,
      addressType: text(item, ['addressType', 'addressKind', 'purpose']),
      isPrimary: booleanOrNull(item, ['isPrimary', 'primary']) ?? false,
    }];
  });
}

export function mapOnecCounterpartyCard(
  payload: unknown,
  requestedGuid: string,
  requestedOrganizationGuid: string | null,
  permissions: CounterpartyCardPermissions
): CounterpartyCardBootstrap {
  const root = unwrap(payload);
  const identity = object(root, 'identity');
  const context = object(root, 'context');
  const overview = object(root, 'overview');
  const financeSource = object(root, 'financeSummary', 'finance');
  const salesSource = object(root, 'salesSummary', 'sales');
  const termsSource = object(root, 'commercialTerms', 'terms');
  const sections = object(root, 'sections');
  const organizationOptions = mapOrganizations(root, context);
  const counterpartyGuid = text(identity, ['counterpartyGuid', 'guid'], requestedGuid) ?? requestedGuid;
  const name = text(identity, ['name']);
  if (!root || !identity || !name) throw new Error('1C returned an incomplete counterparty card');

  const financeSummary = permissions.viewFinance ? mapFinance(financeSource) : null;
  const salesSummary = permissions.viewSales ? mapSales(salesSource) : null;
  const commercialTerms = mapTerms(termsSource);
  const recentOrders = permissions.viewSales ? mapOrders(root) : [];
  const contacts = permissions.viewContacts ? mapContacts(root) : [];
  const incomingPayments = permissions.viewFinance ? mapIncomingPayments(root) : [];
  const upcomingPayments = permissions.viewFinance ? mapUpcomingPayments(root) : [];
  const paymentDiscipline = permissions.viewFinance ? mapPaymentDiscipline(root) : null;
  const financialDocuments = permissions.viewFinance ? mapFinancialDocuments(root, upcomingPayments) : [];
  const financialDocumentsSummary = mapFinancialDocumentsSummary(root, financialDocuments);
  const availability: CounterpartyCardAvailability = {
    identity: sectionAvailability(sections, ['identity'], 'available'),
    finance: permissions.viewFinance
      ? sectionAvailability(sections, ['finance'], financeSummary ? 'available' : 'unavailable')
      : 'forbidden',
    sales: permissions.viewSales
      ? sectionAvailability(sections, ['sales'], salesSummary ? 'available' : 'unavailable')
      : 'forbidden',
    commercialTerms: sectionAvailability(sections, ['commercialTerms', 'terms'], commercialTerms ? 'available' : 'unavailable'),
    orders: permissions.viewSales
      ? sectionAvailability(sections, ['orders'], recentOrders.length ? 'available' : 'available')
      : 'forbidden',
    contacts: permissions.viewContacts
      ? sectionAvailability(sections, ['contacts'], contacts.length ? 'available' : 'available')
      : 'forbidden',
    organizationOptions: sectionAvailability(
      sections,
      ['organizationOptions'],
      organizationOptions.length ? 'available' : 'unavailable'
    ),
    payments: permissions.viewFinance
      ? sectionAvailability(sections, ['payments', 'incomingPayments'], incomingPayments.length ? 'available' : 'available')
      : 'forbidden',
    upcomingPayments: permissions.viewFinance
      ? sectionAvailability(sections, ['upcomingPayments'], 'available')
      : 'forbidden',
    paymentDiscipline: permissions.viewFinance
      ? sectionAvailability(sections, ['paymentDiscipline'], paymentDiscipline ? 'available' : 'unavailable')
      : 'forbidden',
    financialDocuments: permissions.viewFinance
      ? sectionAvailability(sections, ['financialDocuments', 'financeDocuments'], 'available')
      : 'forbidden',
  };

  return {
    identity: {
      counterpartyGuid,
      name,
      fullName: text(identity, ['fullName']),
      inn: text(identity, ['inn']),
      kpp: text(identity, ['kpp']),
      legalType: text(identity, ['legalType']),
      partnerGuid: text(identity, ['partnerGuid']),
      partnerName: text(identity, ['partnerName']),
      isActive: booleanOrNull(identity, ['isActive']),
    },
    context: {
      organizationGuid: text(context, ['organizationGuid'], requestedOrganizationGuid),
      organizationName: text(context, ['organizationName']),
      availableOrganizations: organizationOptions,
      managerGuid: text(context, ['managerGuid']),
      managerName: text(context, ['managerName']),
      regionGuid: text(context, ['regionGuid']),
      regionName: text(context, ['regionName']),
      zoneGuid: text(context, ['zoneGuid']),
      zoneName: text(context, ['zoneName']),
    },
    organizationOptions,
    overview: {
      status: humanOrderStatus(text(overview, ['status', 'statusCode'])),
      debtTotal: numberOrNull(overview, ['debtTotal']),
      overdueDebt: numberOrNull(overview, ['overdueDebt']),
      maxOverdueDays: numberOrNull(overview, ['maxOverdueDays']),
      availableCreditLimit: numberOrNull(overview, ['availableCreditLimit']),
      salesAmount: numberOrNull(overview, ['salesAmount']),
      previousSalesAmount: numberOrNull(overview, ['previousSalesAmount']),
      salesChangePercent: numberOrNull(overview, ['salesChangePercent']),
      lastOrderDate: text(overview, ['lastOrderDate']),
      lastOrderAmount: numberOrNull(overview, ['lastOrderAmount']),
      averageCheck: numberOrNull(overview, ['averageCheck']),
    },
    financeSummary,
    salesSummary,
    commercialTerms,
    recentOrders,
    contacts,
    incomingPayments,
    upcomingPayments,
    paymentDiscipline,
    financialDocuments,
    financialDocumentsSummary,
    permissions,
    availability,
    asOf: text(root, ['calculatedAt', 'asOf'], new Date().toISOString()) ?? new Date().toISOString(),
    stale: false,
    sourceVersion: text(root, ['sourceVersion'], 'counterparty-card-v1') ?? 'counterparty-card-v1',
  };
}
