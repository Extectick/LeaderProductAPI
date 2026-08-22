export type CounterpartySectionAvailability = 'available' | 'forbidden' | 'unavailable';
export type CounterpartyPeriodPreset = 'week' | 'month' | 'quarter' | 'halfYear' | 'year' | 'custom';

export type CounterpartyOrganizationSummary = {
  guid: string;
  name: string;
};

export type CounterpartyIdentity = {
  counterpartyGuid: string;
  name: string;
  fullName: string | null;
  inn: string | null;
  kpp: string | null;
  legalType: string | null;
  partnerGuid: string | null;
  partnerName: string | null;
  isActive: boolean | null;
};

export type CounterpartyContext = {
  organizationGuid: string | null;
  organizationName: string | null;
  availableOrganizations: CounterpartyOrganizationSummary[];
  managerGuid: string | null;
  managerName: string | null;
  regionGuid: string | null;
  regionName: string | null;
  zoneGuid: string | null;
  zoneName: string | null;
};

export type CounterpartyOverview = {
  status: string | null;
  debtTotal: number | null;
  overdueDebt: number | null;
  maxOverdueDays: number | null;
  availableCreditLimit: number | null;
  salesAmount: number | null;
  previousSalesAmount: number | null;
  salesChangePercent: number | null;
  lastOrderDate: string | null;
  lastOrderAmount: number | null;
  averageCheck: number | null;
};

export type CounterpartyFinanceSummary = {
  debtTotal: number | null;
  overdueDebt: number | null;
  notDueDebt: number | null;
  prepayment: number | null;
  creditLimit: number | null;
  availableCreditLimit: number | null;
  creditLimitExceeded: boolean | null;
  shipmentProhibited: boolean | null;
  shipmentProhibitionReason: string | null;
  currency: string | null;
  nearestPaymentDate: string | null;
  nearestPaymentAmount: number | null;
  maxOverdueDays: number | null;
  paymentTermDays: number | null;
  paymentTermSource: string | null;
  agreementGuid: string | null;
  agreementName: string | null;
};

export type CounterpartySalesChartPoint = {
  periodFrom: string | null;
  periodTo: string | null;
  label: string | null;
  salesAmount: number | null;
  ordersCount: number | null;
  salesDocumentsCount: number | null;
  profit: number | null;
  profitabilityPercent: number | null;
};

export type CounterpartySalesSummary = {
  periodPreset: CounterpartyPeriodPreset | null;
  chartGranularity: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  compareFrom: string | null;
  compareTo: string | null;
  salesAmount: number | null;
  previousSalesAmount: number | null;
  salesChangePercent: number | null;
  profit: number | null;
  profitabilityPercent: number | null;
  previousProfit: number | null;
  previousProfitabilityPercent: number | null;
  comparisonAvailable: boolean | null;
  comparisonUnavailableReason: string | null;
  dataReliableFrom: string | null;
  ordersCount: number | null;
  averageCheck: number | null;
  lastOrderDate: string | null;
  lastOrderAmount: number | null;
  daysSinceLastOrder: number | null;
  averageOrderIntervalDays: number | null;
  orderFrequencyDays: number | null;
  currency: string | null;
  chartSeries: CounterpartySalesChartPoint[];
  comparisonChartSeries: CounterpartySalesChartPoint[];
};

export type CounterpartyFinancialDocumentStatus = 'OVERDUE' | 'EXPECTED' | 'AWAITING_SHIPMENT' | 'PAID';

export type CounterpartyFinancialDocument = {
  documentGuid: string;
  documentTypeCode: string | null;
  documentTypeName: string | null;
  number: string | null;
  date: string | null;
  status: CounterpartyFinancialDocumentStatus | null;
  dueDate: string | null;
  shipmentDate: string | null;
  daysOverdue: number | null;
  daysRemaining: number | null;
  outstandingAmount: number | null;
  amount: number | null;
  currency: string | null;
  organizationGuid: string | null;
  organizationName: string | null;
};

export type CounterpartyFinancialDocumentsSummary = {
  totalCount: number;
  overdueCount: number;
  pendingCount: number;
  awaitingShipmentCount: number;
};

export type CounterpartyFinancialDocumentsPage = {
  items: CounterpartyFinancialDocument[];
  summary: CounterpartyFinancialDocumentsSummary;
  hasMore: boolean;
  nextCursor: string | null;
  asOf: string;
  stale: boolean;
  sourceVersion: string;
};

export type CounterpartyIncomingPayment = {
  guid: string;
  number: string | null;
  date: string | null;
  amount: number | null;
  currency: string | null;
  type: string | null;
  typeCode: string | null;
  typeLabel: string | null;
  organizationGuid: string | null;
  organizationName: string | null;
};

export type CounterpartyUpcomingPayment = {
  guid: string;
  number: string | null;
  date: string | null;
  dueDate: string | null;
  amount: number | null;
  currency: string | null;
  status: 'OVERDUE' | 'EXPECTED';
  overdueDays: number;
};

export type CounterpartyPaymentDiscipline = {
  available: boolean;
  periodFrom: string | null;
  periodTo: string | null;
  settledDocumentsCount: number;
  overdueDocumentsCount: number;
  paidOnTimePercent: number | null;
  averageDelayDays: number | null;
  totalSettledAmount: number;
  onTimeSettledAmount: number;
  currency: string | null;
};

export type CounterpartyCommercialTerms = {
  agreementGuid: string | null;
  agreementName: string | null;
  contractGuid: string | null;
  contractName: string | null;
  priceTypeGuid: string | null;
  priceTypeName: string | null;
  currency: string | null;
  paymentForm: string | null;
  paymentTerms: string | null;
  deliveryMethod: string | null;
  deliveryTerms: string | null;
};

export type CounterpartyContact = {
  kind: string | null;
  kindCode: string | null;
  label: string | null;
  value: string;
  addressType: string | null;
  isPrimary: boolean;
};

export type CounterpartyRecentOrder = {
  guid: string;
  number: string | null;
  date: string | null;
  shipmentDate: string | null;
  status: string | null;
  amount: number | null;
  currency: string | null;
  itemsCount: number | null;
};

export type CounterpartyCardPermissions = {
  viewFinance: boolean;
  viewSales: boolean;
  viewContacts: boolean;
  createOrder: boolean;
};

export type CounterpartyCardAvailability = {
  identity: CounterpartySectionAvailability;
  finance: CounterpartySectionAvailability;
  sales: CounterpartySectionAvailability;
  commercialTerms: CounterpartySectionAvailability;
  orders: CounterpartySectionAvailability;
  contacts: CounterpartySectionAvailability;
  organizationOptions: CounterpartySectionAvailability;
  payments: CounterpartySectionAvailability;
  upcomingPayments: CounterpartySectionAvailability;
  paymentDiscipline: CounterpartySectionAvailability;
  financialDocuments: CounterpartySectionAvailability;
};

export type CounterpartyCardBootstrap = {
  identity: CounterpartyIdentity;
  context: CounterpartyContext;
  organizationOptions: CounterpartyOrganizationSummary[];
  overview: CounterpartyOverview;
  financeSummary: CounterpartyFinanceSummary | null;
  salesSummary: CounterpartySalesSummary | null;
  commercialTerms: CounterpartyCommercialTerms | null;
  recentOrders: CounterpartyRecentOrder[];
  contacts: CounterpartyContact[];
  incomingPayments: CounterpartyIncomingPayment[];
  upcomingPayments: CounterpartyUpcomingPayment[];
  paymentDiscipline: CounterpartyPaymentDiscipline | null;
  financialDocuments: CounterpartyFinancialDocument[];
  financialDocumentsSummary: CounterpartyFinancialDocumentsSummary;
  permissions: CounterpartyCardPermissions;
  availability: CounterpartyCardAvailability;
  asOf: string;
  stale: boolean;
  sourceVersion: string;
};

export type CounterpartyCardPeriods = {
  date: string;
  preset: CounterpartyPeriodPreset;
  periodFrom: string;
  periodTo: string;
  compareFrom: string;
  compareTo: string;
};
