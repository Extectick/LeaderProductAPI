import { mapOnecCounterpartyCard } from '../src/modules/counterparties/counterparties.mapper';

const permissions = {
  viewFinance: true,
  viewSales: true,
  viewContacts: true,
  createOrder: true,
};

describe('counterparty card mapper', () => {
  it('unwraps 1C payload and preserves unknown metrics as null', () => {
    const card = mapOnecCounterpartyCard({
      status: 'success',
      data: {
        item: {
          identity: {
            counterpartyGuid: '11111111-1111-4111-8111-111111111111',
            name: 'Тестовый клиент',
            inn: '1234567890',
            isActive: true,
          },
          context: {
            organizationGuid: '22222222-2222-4222-8222-222222222222',
            organizationName: 'Организация',
          },
          overview: { status: 'NORMAL', debtTotal: '1 250,50' },
          financeSummary: { available: true, debtTotal: '1250.50', overdueDebt: null },
          salesSummary: { available: false },
          sections: { finance: { available: true }, sales: { available: false } },
          calculatedAt: '2026-08-12T10:00:00',
          sourceVersion: 'counterparty-card-v1',
        },
      },
    }, '11111111-1111-4111-8111-111111111111', null, permissions);

    expect(card.identity.name).toBe('Тестовый клиент');
    expect(card.overview.debtTotal).toBe(1250.5);
    expect(card.overview.salesAmount).toBeNull();
    expect(card.financeSummary?.overdueDebt).toBeNull();
    expect(card.salesSummary).toBeNull();
    expect(card.availability.sales).toBe('unavailable');
    expect(card.stale).toBe(false);
  });

  it('does not expose forbidden sections', () => {
    const card = mapOnecCounterpartyCard({ item: {
      identity: { guid: '11111111-1111-4111-8111-111111111111', name: 'Клиент' },
      financeSummary: { debtTotal: 100 },
      salesSummary: { salesAmount: 500 },
      contacts: [{ value: '+79990000000' }],
    } }, '11111111-1111-4111-8111-111111111111', null, {
      viewFinance: false,
      viewSales: false,
      viewContacts: false,
      createOrder: false,
    });

    expect(card.financeSummary).toBeNull();
    expect(card.salesSummary).toBeNull();
    expect(card.recentOrders).toEqual([]);
    expect(card.contacts).toEqual([]);
    expect(card.availability.finance).toBe('forbidden');
    expect(card.availability.contacts).toBe('forbidden');
  });

  it('maps v3 additions and converts raw shipment status to a human label', () => {
    const card = mapOnecCounterpartyCard({ item: {
      identity: { guid: '11111111-1111-4111-8111-111111111111', name: 'РљР»РёРµРЅС‚' },
      context: { availableOrganizations: [{ guid: '22222222-2222-4222-8222-222222222222', name: 'Org' }] },
      organizationOptions: [{ organizationGuid: '22222222-2222-4222-8222-222222222222', organizationName: 'Org' }],
      overview: { status: 'shipment_PR' },
      financeSummary: {
        nearestPaymentAmount: 1500,
        paymentTermDays: 14,
        paymentTermSource: 'AGREEMENT',
        agreementGuid: '55555555-5555-4555-8555-555555555555',
        agreementName: 'Main agreement',
      },
      salesSummary: {
        periodPreset: 'half-year', lastOrderAmount: 500,
        orderFrequencyDays: 8.266, averageOrderIntervalDays: '6,64',
        salesAmount: 125, previousSalesAmount: 100, salesChangePercent: 25,
        profit: 25, profitabilityPercent: 20,
        chartSeries: [{
          periodFrom: '2026-01-01', periodTo: '2026-01-31', label: 'Jan', salesAmount: 100,
          salesDocumentsCount: 2, profit: 20, profitabilityPercent: 20,
        }],
        comparisonChartSeries: [{
          periodFrom: '2025-07-01', periodTo: '2025-07-31', label: 'Jul', salesAmount: 80,
          salesDocumentsCount: 1,
        }],
      },
      recentOrders: [{ guid: '33333333-3333-4333-8333-333333333333', status: 'shipment_PR' }],
      contacts: [{ kindCode: 'ADDRESS', label: 'Delivery', value: 'Omsk', addressType: 'DELIVERY' }],
      incomingPayments: [{ guid: '44444444-4444-4444-8444-444444444444', number: '1', amount: 200, type: 'BANK_RECEIPT' }],
      upcomingPayments: [{
        guid: '55555555-5555-4555-8555-555555555555', number: 'НОУТ-H1', amount: 300,
        dueDate: '2026-08-10', status: 'OVERDUE', overdueDays: 4,
      }],
      paymentDiscipline: {
        available: true, settledDocumentsCount: 10, overdueDocumentsCount: 2,
        periodFrom: '2026-01-01', periodTo: '2026-08-14',
        paidOnTimePercent: 80, averageDelayDays: 1.5, totalSettledAmount: 1000,
        onTimeSettledAmount: 800,
      },
    } }, '11111111-1111-4111-8111-111111111111', null, permissions);

    expect(card.organizationOptions).toEqual([{ guid: '22222222-2222-4222-8222-222222222222', name: 'Org' }]);
    expect(card.overview.status).toBe('\u0412 \u043f\u0440\u043e\u0446\u0435\u0441\u0441\u0435 \u043e\u0442\u0433\u0440\u0443\u0437\u043a\u0438');
    expect(card.recentOrders[0].status).toBe('\u0412 \u043f\u0440\u043e\u0446\u0435\u0441\u0441\u0435 \u043e\u0442\u0433\u0440\u0443\u0437\u043a\u0438');
    expect(card.financeSummary).toMatchObject({ nearestPaymentAmount: 1500, paymentTermDays: 14 });
    expect(card.salesSummary).toMatchObject({
      periodPreset: 'halfYear', lastOrderAmount: 500,
      orderFrequencyDays: 8.3, averageOrderIntervalDays: 6.6,
      salesChangePercent: 25, profit: 25, profitabilityPercent: 20,
    });
    expect(card.financeSummary).toMatchObject({
      paymentTermDays: 14,
      paymentTermSource: 'AGREEMENT',
      agreementGuid: '55555555-5555-4555-8555-555555555555',
      agreementName: 'Main agreement',
    });
    expect(card.salesSummary?.chartSeries).toEqual([expect.objectContaining({
      ordersCount: 2, salesDocumentsCount: 2, profit: 20, profitabilityPercent: 20,
    })]);
    expect(card.salesSummary?.comparisonChartSeries).toEqual([expect.objectContaining({
      salesAmount: 80, ordersCount: 1, salesDocumentsCount: 1,
    })]);
    expect(card.incomingPayments).toHaveLength(1);
    expect(card.upcomingPayments).toEqual([expect.objectContaining({
      number: 'НОУТ-H1', status: 'OVERDUE', overdueDays: 4, amount: 300,
    })]);
    expect(card.paymentDiscipline).toMatchObject({
      settledDocumentsCount: 10, overdueDocumentsCount: 2,
      paidOnTimePercent: 80, averageDelayDays: 1.5,
      periodFrom: '2026-01-01', periodTo: '2026-08-14', totalSettledAmount: 1000,
    });
    expect(card.incomingPayments[0]).toMatchObject({
      type: 'BANK_RECEIPT',
      typeCode: 'BANK_RECEIPT',
      typeLabel: '\u041f\u043e\u0441\u0442\u0443\u043f\u043b\u0435\u043d\u0438\u0435 \u043d\u0430 \u0431\u0430\u043d\u043a\u043e\u0432\u0441\u043a\u0438\u0439 \u0441\u0447\u0451\u0442',
    });
    expect(card.contacts[0]).toMatchObject({
      kind: 'ADDRESS', kindCode: 'ADDRESS', addressType: 'DELIVERY', value: 'Omsk',
    });
  });

  it.each([
    ['BANK_RECIEPT', '\u041f\u043e\u0441\u0442\u0443\u043f\u043b\u0435\u043d\u0438\u0435 \u043d\u0430 \u0431\u0430\u043d\u043a\u043e\u0432\u0441\u043a\u0438\u0439 \u0441\u0447\u0451\u0442'],
    ['CASH_RECEIPT', '\u041f\u043e\u0441\u0442\u0443\u043f\u043b\u0435\u043d\u0438\u0435 \u043d\u0430\u043b\u0438\u0447\u043d\u044b\u0445'],
    ['ACQUIRING_RECEIPT', '\u041e\u043f\u043b\u0430\u0442\u0430 \u043f\u043b\u0430\u0442\u0451\u0436\u043d\u043e\u0439 \u043a\u0430\u0440\u0442\u043e\u0439'],
    ['BANK_REFUND', '\u0412\u043e\u0437\u0432\u0440\u0430\u0442 \u043d\u0430 \u0431\u0430\u043d\u043a\u043e\u0432\u0441\u043a\u0438\u0439 \u0441\u0447\u0451\u0442'],
  ])('maps payment code %s while preserving it', (typeCode, expectedLabel) => {
    const card = mapOnecCounterpartyCard({ item: {
      identity: { guid: '11111111-1111-4111-8111-111111111111', name: 'Client' },
      incomingPayments: [{ guid: '22222222-2222-4222-8222-222222222222', type: typeCode }],
    } }, '11111111-1111-4111-8111-111111111111', null, permissions);
    expect(card.incomingPayments[0]).toMatchObject({ type: typeCode, typeCode, typeLabel: expectedLabel });
  });

  it('uses the 1C document name when the explicit payment label is empty', () => {
    const card = mapOnecCounterpartyCard({ item: {
      identity: { guid: '11111111-1111-4111-8111-111111111111', name: 'Client' },
      incomingPayments: [{
        guid: '22222222-2222-4222-8222-222222222222',
        type: 'BANK_RECEIPT',
        typeLabel: '',
        documentTypeName: 'Поступление безналичных денежных средств',
      }],
    } }, '11111111-1111-4111-8111-111111111111', null, permissions);

    expect(card.incomingPayments[0].typeLabel).toBe('Поступление безналичных денежных средств');
  });

  it('preserves real zero profit and supports upstream aliases', () => {
    const card = mapOnecCounterpartyCard({ item: {
      identity: { guid: '11111111-1111-4111-8111-111111111111', name: 'Client' },
      salesSummary: { grossProfit: 0, marginPercent: 0, chartSeries: [{ margin: 0, profitability: 0 }] },
    } }, '11111111-1111-4111-8111-111111111111', null, permissions);
    expect(card.salesSummary?.profit).toBe(0);
    expect(card.salesSummary?.profitabilityPercent).toBe(0);
    expect(card.salesSummary?.chartSeries[0]).toMatchObject({ profit: 0, profitabilityPercent: 0 });
  });

  it('keeps upstream formula results nullable and does not derive percentages', () => {
    const card = mapOnecCounterpartyCard({ item: {
      identity: { guid: '11111111-1111-4111-8111-111111111111', name: 'Client' },
      salesSummary: {
        salesAmount: 200,
        previousSalesAmount: 100,
        salesChangePercent: null,
        profit: null,
        profitabilityPercent: null,
        chartSeries: [{ salesAmount: 200, ordersCount: 3 }],
      },
    } }, '11111111-1111-4111-8111-111111111111', null, permissions);

    expect(card.salesSummary).toMatchObject({
      salesAmount: 200,
      previousSalesAmount: 100,
      salesChangePercent: null,
      profit: null,
      profitabilityPercent: null,
    });
    expect(card.salesSummary?.chartSeries[0]).toMatchObject({
      ordersCount: 3,
      salesDocumentsCount: 3,
      profit: null,
      profitabilityPercent: null,
    });
  });

  it('maps v11 comparison metrics and unified financial documents without losing old arrays', () => {
    const card = mapOnecCounterpartyCard({ item: {
      identity: { guid: '11111111-1111-4111-8111-111111111111', name: 'Client' },
      salesSummary: {
        previousProfit: '1 250,50',
        previousProfitabilityPercent: 12.5,
        comparisonAvailable: false,
        comparisonUnavailableReason: 'COMPARISON_BEFORE_RELIABLE_DATA',
        dataReliableFrom: '2025-01-01',
      },
      financialDocuments: [{
        documentGuid: '22222222-2222-4222-8222-222222222222',
        documentTypeCode: 'CUSTOMER_ORDER',
        documentTypeName: 'Order',
        number: '42',
        date: '2026-08-14T10:00:00',
        status: 'AWAITING_SHIPMENT',
        shipmentDate: '2026-08-15',
        daysRemaining: '1',
        outstandingAmount: '750,25',
        amount: 1000,
        currency: 'RUB',
        organizationGuid: '33333333-3333-4333-8333-333333333333',
        organizationName: 'Org',
      }],
      financialDocumentsSummary: {
        totalCount: 1, overdueCount: 0, pendingCount: 0, awaitingShipmentCount: 1,
      },
      upcomingPayments: [{
        guid: '44444444-4444-4444-8444-444444444444', status: 'EXPECTED', amount: 500,
      }],
    } }, '11111111-1111-4111-8111-111111111111', null, permissions);

    expect(card.salesSummary).toMatchObject({
      previousProfit: 1250.5,
      previousProfitabilityPercent: 12.5,
      comparisonAvailable: false,
      comparisonUnavailableReason: 'COMPARISON_BEFORE_RELIABLE_DATA',
      dataReliableFrom: '2025-01-01',
    });
    expect(card.financialDocuments).toEqual([expect.objectContaining({
      documentGuid: '22222222-2222-4222-8222-222222222222',
      status: 'AWAITING_SHIPMENT',
      daysRemaining: 1,
      outstandingAmount: 750.25,
    })]);
    expect(card.financialDocumentsSummary).toEqual({
      totalCount: 1, overdueCount: 0, pendingCount: 0, awaitingShipmentCount: 1,
    });
    expect(card.upcomingPayments).toHaveLength(1);
  });

  it('tolerates v10 aliases and builds a summary without inventing unknown statuses', () => {
    const card = mapOnecCounterpartyCard({ item: {
      identity: { guid: '11111111-1111-4111-8111-111111111111', name: 'Client' },
      salesSummary: {
        priorProfit: 100,
        previousProfitability: 10,
        compareAvailable: true,
        reliableDataFrom: '2024-01-01',
      },
      financeDocuments: [
        { guid: '22222222-2222-4222-8222-222222222222', status: 'OVERDUE', debtAmount: 50 },
        { guid: '33333333-3333-4333-8333-333333333333', status: 'NEW_STATUS', debtAmount: 20 },
      ],
    } }, '11111111-1111-4111-8111-111111111111', null, permissions);

    expect(card.salesSummary).toMatchObject({
      previousProfit: 100,
      previousProfitabilityPercent: 10,
      comparisonAvailable: true,
      dataReliableFrom: '2024-01-01',
    });
    expect(card.financialDocuments[1].status).toBeNull();
    expect(card.financialDocumentsSummary).toEqual({
      totalCount: 2, overdueCount: 1, pendingCount: 1, awaitingShipmentCount: 0,
    });
  });

  it('converts technical counterparty statuses to user-facing labels', () => {
    const card = mapOnecCounterpartyCard({ item: {
      identity: { guid: '11111111-1111-4111-8111-111111111111', name: 'Клиент' },
      overview: { status: 'HAS_DEBT', debtTotal: 500 },
    } }, '11111111-1111-4111-8111-111111111111', null, permissions);

    expect(card.overview.status).toBe('Есть долг');
  });
});
