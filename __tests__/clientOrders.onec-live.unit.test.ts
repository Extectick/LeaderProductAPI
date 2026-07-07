import {
  findLiveCounterparty,
  getLiveAgreements,
  getLiveClientOrder,
  getLiveClientOrderDefaults,
  getLiveContracts,
  getLiveCounterparties,
  getLiveClientOrders,
  getLiveDeliveryAddresses,
  getLiveOrganizations,
  getLivePriceTypes,
  getLiveProducts,
  getLiveProductsByGuids,
  getLiveReferenceData,
  getLiveWarehouses,
} from '../src/modules/clientOrders/clientOrders.onecLive';
import {
  getOnecLpAppAgreements,
  getOnecLpAppClientOrderDefaults,
  getOnecLpAppClientOrder,
  getOnecLpAppClientOrders,
  getOnecLpAppContracts,
  getOnecLpAppCounterparties,
  getOnecLpAppDeliveryAddresses,
  getOnecLpAppNomenclature,
  getOnecLpAppNomenclatureItem,
  getOnecLpAppOrganizations,
  getOnecLpAppPriceTypes,
  getOnecLpAppWarehouses,
} from '../src/modules/onec/onec.lpApp.client';

jest.mock('../src/modules/onec/onec.lpApp.client', () => ({
  getOnecLpAppAgreements: jest.fn(),
  getOnecLpAppClientOrderDefaults: jest.fn(),
  getOnecLpAppClientOrder: jest.fn(),
  getOnecLpAppClientOrders: jest.fn(),
  getOnecLpAppContracts: jest.fn(),
  getOnecLpAppCounterparties: jest.fn(),
  getOnecLpAppDeliveryAddresses: jest.fn(),
  getOnecLpAppNomenclature: jest.fn(),
  getOnecLpAppNomenclatureItem: jest.fn(),
  getOnecLpAppOrganizations: jest.fn(),
  getOnecLpAppPriceTypes: jest.fn(),
  getOnecLpAppWarehouses: jest.fn(),
}));

const organizationsMock = jest.mocked(getOnecLpAppOrganizations);
const warehousesMock = jest.mocked(getOnecLpAppWarehouses);
const counterpartiesMock = jest.mocked(getOnecLpAppCounterparties);
const contractsMock = jest.mocked(getOnecLpAppContracts);
const agreementsMock = jest.mocked(getOnecLpAppAgreements);
const clientOrderDefaultsMock = jest.mocked(getOnecLpAppClientOrderDefaults);
const clientOrderMock = jest.mocked(getOnecLpAppClientOrder);
const clientOrdersMock = jest.mocked(getOnecLpAppClientOrders);
const deliveryAddressesMock = jest.mocked(getOnecLpAppDeliveryAddresses);
const priceTypesMock = jest.mocked(getOnecLpAppPriceTypes);
const nomenclatureMock = jest.mocked(getOnecLpAppNomenclature);
const nomenclatureItemMock = jest.mocked(getOnecLpAppNomenclatureItem);

function paged(items: unknown[], patch: Partial<{ limit: number; offset: number; hasMore: boolean; total: number }> = {}) {
  return {
    items,
    limit: patch.limit ?? 2,
    offset: patch.offset ?? 0,
    hasMore: patch.hasMore ?? false,
    total: patch.total,
  };
}

function expectFilledEntity(entity: { guid?: unknown; name?: unknown; number?: unknown; fullAddress?: unknown }) {
  expect(typeof entity.guid).toBe('string');
  expect(String(entity.guid)).not.toHaveLength(0);
  const display = entity.name ?? entity.number ?? entity.fullAddress;
  expect(typeof display).toBe('string');
  expect(String(display)).not.toHaveLength(0);
}

describe('clientOrders 1C live adapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('normalizes counterparties from MainConf fields and hides deletion-marked rows by default', async () => {
    counterpartiesMock.mockResolvedValueOnce(
      paged(
        [
          {
            guid: 'counterparty-active',
            name: 'Абдулаева Елена Викторовна ИП',
            fullName: 'Абдулаева Елена Викторовна Индивидуальный предприниматель',
            inn: '540000000001',
            kpp: '540001001',
            phone: '+7 913 000-00-01',
            email: 'counterparty@example.test',
            partnerGuid: 'partner-guid',
            managerGuid: 'manager-guid',
            managerName: 'Manager',
            partnerName: 'Партнер',
            isActive: true,
          },
          {
            guid: 'counterparty-deleted',
            name: 'Удаленный контрагент',
            inn: '540000000002',
            kpp: '540001002',
            deletionMark: true,
          },
        ],
        { limit: 2, offset: 4, hasMore: true }
      )
    );

    const result = await getLiveCounterparties({
      limit: 2,
      offset: 4,
      search: 'Абдулаева',
      includeInactive: false,
    });

    expect(counterpartiesMock).toHaveBeenCalledWith({
      limit: 2,
      offset: 4,
      search: 'Абдулаева',
      includeInactive: false,
      counterpartyGuid: undefined,
      organizationGuid: undefined,
      agreementGuid: undefined,
      contractGuid: undefined,
      warehouseGuid: undefined,
      priceTypeGuid: undefined,
      inStockOnly: undefined,
    });
    expect(result.limit).toBe(2);
    expect(result.offset).toBe(4);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      guid: 'counterparty-active',
      name: 'Абдулаева Елена Викторовна ИП',
      fullName: 'Абдулаева Елена Викторовна Индивидуальный предприниматель',
      inn: '540000000001',
      kpp: '540001001',
      phone: '+7 913 000-00-01',
      email: 'counterparty@example.test',
      managerGuid: 'manager-guid',
      managerName: 'Manager',
      isActive: true,
    });
  });

  it('allows inactive rows only for explicit diagnostic includeInactive queries', async () => {
    counterpartiesMock.mockResolvedValueOnce(
      paged([
        {
          guid: 'counterparty-deleted',
          name: 'Удаленный контрагент',
          deletionMark: true,
        },
      ])
    );

    const result = await getLiveCounterparties({ limit: 25, offset: 0, includeInactive: true });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].isActive).toBe(false);
  });

  it('does not materialize a random row when 1C ignores guid filter', async () => {
    counterpartiesMock.mockResolvedValueOnce(
      paged([
        {
          guid: 'different-guid',
          name: 'Другой контрагент',
          inn: '540000000003',
          kpp: '540001003',
        },
      ])
    );

    await expect(findLiveCounterparty('requested-guid')).resolves.toBeNull();
  });

  it('normalizes every client-order reference list with stable pagination', async () => {
    organizationsMock.mockResolvedValueOnce(paged([{ guid: 'org-guid', name: 'Организация', code: 'ORG' }], { limit: 1, offset: 0 }));
    warehousesMock.mockResolvedValueOnce(paged([{ guid: 'warehouse-guid', name: 'Склад', code: 'WH' }], { limit: 1, offset: 1 }));
    contractsMock.mockResolvedValueOnce(
      paged([{ guid: 'contract-guid', number: 'Д-1', counterpartyGuid: 'counterparty-guid', organizationGuid: 'org-guid', organization: { guid: 'org-guid', name: 'Организация' }, managerGuid: 'manager-guid', managerName: 'Менеджер' }], {
        limit: 1,
        offset: 2,
      })
    );
    agreementsMock.mockResolvedValueOnce(
      paged([
        {
          guid: 'agreement-guid',
          name: 'Соглашение',
          counterpartyGuid: 'counterparty-guid',
          organizationGuid: 'org-guid',
          organization: { guid: 'org-guid', name: 'Организация' },
          managerGuid: 'manager-guid',
          managerName: 'Менеджер',
          warehouseGuid: 'warehouse-guid',
          priceTypeGuid: 'price-type-guid',
          currency: 'RUB',
        },
      ])
    );
    deliveryAddressesMock.mockResolvedValueOnce(
      paged([
        {
          guid: 'address-guid',
          name: 'Основной адрес',
          fullAddress: 'Новосибирск, ул. Ленина, 1',
          address: 'Новосибирск, ул. Ленина, 1',
          deliveryComment: 'с 9:00 - 18:00 79681015385',
          kindName: 'Адрес доставки 1',
          deliveryNumber: '1',
          counterpartyGuid: 'counterparty-guid',
          isDefault: true,
          isActive: true,
        },
        {
          guid: 'deleted-address',
          name: 'Удаленный адрес',
          fullAddress: 'Не показывать',
          counterpartyGuid: 'counterparty-guid',
          deletionMark: true,
        },
      ])
    );
    priceTypesMock.mockResolvedValueOnce(paged([{ guid: 'price-type-guid', name: 'Розничная', code: 'РЦ' }]));

    const organizationPage = await getLiveOrganizations({ limit: 1, offset: 0, search: 'орг' });
    const warehousePage = await getLiveWarehouses({ limit: 1, offset: 1, search: 'склад', includeInactive: false });
    const contractPage = await getLiveContracts({
      limit: 1,
      offset: 2,
      counterpartyGuid: 'counterparty-guid',
      includeInactive: false,
    });
    const agreementPage = await getLiveAgreements({
      limit: 25,
      offset: 0,
      counterpartyGuid: 'counterparty-guid',
      includeInactive: false,
    });
    const addressPage = await getLiveDeliveryAddresses({
      limit: 25,
      offset: 0,
      counterpartyGuid: 'counterparty-guid',
      includeInactive: false,
    });
    const priceTypePage = await getLivePriceTypes({ limit: 25, offset: 0, includeInactive: false });

    [organizationPage.items[0], warehousePage.items[0], contractPage.items[0], agreementPage.items[0], addressPage.items[0], priceTypePage.items[0]].forEach(
      expectFilledEntity
    );
    expect(addressPage.items).toHaveLength(1);
    expect(addressPage.items[0]).toMatchObject({
      guid: 'address-guid',
      fullAddress: 'Новосибирск, ул. Ленина, 1',
      deliveryComment: 'с 9:00 - 18:00 79681015385',
      kindName: 'Адрес доставки 1',
      deliveryNumber: '1',
      counterpartyGuid: 'counterparty-guid',
      isDefault: true,
      isActive: true,
    });
    expect(warehousePage.offset).toBe(1);
    expect(contractPage.offset).toBe(2);
    expect(contractPage.items[0].organization).toMatchObject({ guid: 'org-guid', name: 'Организация' });
    expect(agreementPage.items[0].organization).toMatchObject({ guid: 'org-guid', name: 'Организация' });
    expect(contractPage.items[0]).toMatchObject({ managerGuid: 'manager-guid', managerName: 'Менеджер' });
    expect(agreementPage.items[0]).toMatchObject({ managerGuid: 'manager-guid', managerName: 'Менеджер' });
    expect(contractsMock).toHaveBeenCalledWith(expect.objectContaining({ counterpartyGuid: 'counterparty-guid' }));
  });

  it('passes numeric delivery-address searches as exact delivery address number filters', async () => {
    deliveryAddressesMock.mockResolvedValueOnce(
      paged([
        {
          guid: 'address-33',
          name: 'Адрес',
          fullAddress: 'Омск, ул. Бархатовой, 2',
          kindName: 'Адрес доставки 33',
          counterpartyGuid: 'counterparty-guid',
          isActive: true,
        },
      ])
    );

    const result = await getLiveDeliveryAddresses({
      limit: 25,
      offset: 0,
      counterpartyGuid: 'counterparty-guid',
      search: '33',
      includeInactive: false,
    });

    expect(deliveryAddressesMock).toHaveBeenCalledWith(expect.objectContaining({
      counterpartyGuid: 'counterparty-guid',
      search: '33',
      deliveryAddressNumber: '33',
    }));
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      guid: 'address-33',
      deliveryNumber: '33',
      number: '33',
      kindName: 'Адрес доставки 33',
    });
  });

  it('returns empty scoped lists without calling 1C when required context is missing', async () => {
    await expect(getLiveContracts({ limit: 25, offset: 0, includeInactive: false })).resolves.toMatchObject({ items: [] });
    await expect(getLiveAgreements({ limit: 25, offset: 0, includeInactive: false })).resolves.toMatchObject({ items: [] });
    await expect(getLiveDeliveryAddresses({ limit: 25, offset: 0, includeInactive: false })).resolves.toMatchObject({ items: [] });

    expect(contractsMock).not.toHaveBeenCalled();
    expect(agreementsMock).not.toHaveBeenCalled();
    expect(deliveryAddressesMock).not.toHaveBeenCalled();
  });

  it('normalizes client order defaults from 1C payload', async () => {
    clientOrderDefaultsMock.mockResolvedValueOnce({
      organization: { guid: 'org-guid', name: 'Организация', code: 'ORG' },
      counterparty: {
        guid: 'counterparty-guid',
        name: 'Контрагент',
        fullName: 'Контрагент полное',
        inn: '540000000001',
        kpp: '540001001',
      },
      agreement: {
        guid: 'agreement-guid',
        name: 'Соглашение',
        counterpartyGuid: 'counterparty-guid',
        organizationGuid: 'org-guid',
        organization: { guid: 'org-guid', name: 'Организация' },
        warehouseGuid: 'warehouse-guid',
        priceTypeGuid: 'price-type-guid',
        warehouse: { guid: 'warehouse-guid', name: 'Склад' },
        priceType: { guid: 'price-type-guid', name: 'Розничная' },
        currency: 'RUB',
      },
      contract: { guid: 'contract-guid', number: 'Д-1', counterpartyGuid: 'counterparty-guid', organizationGuid: 'org-guid', organization: { guid: 'org-guid', name: 'Организация' } },
      deliveryAddress: { guid: 'address-guid', fullAddress: 'Новосибирск', counterpartyGuid: 'counterparty-guid' },
      paymentForm: null,
      paymentForms: [
        { code: null, name: 'Любая', label: 'Любая' },
        { code: 'Безналичная', name: 'Безналичная', label: 'Безналичная' },
      ],
      deliveryMethod: 'Самовывоз',
      deliveryMethods: [
        { code: 'Самовывоз', name: 'Самовывоз', label: 'Самовывоз (с нашего склада)' },
        { code: 'ДоКлиента', name: 'ДоКлиента', label: 'Наша транспортная служба до клиента' },
      ],
      currency: 'RUB',
      warnings: ['warning'],
    });

    const result = await getLiveClientOrderDefaults({
      organizationGuid: 'org-guid',
      counterpartyGuid: 'counterparty-guid',
    });

    expect(clientOrderDefaultsMock).toHaveBeenCalledWith(expect.objectContaining({
      organizationGuid: 'org-guid',
      counterpartyGuid: 'counterparty-guid',
      limit: 1,
      offset: 0,
    }));
    expect(result.counterparty).toMatchObject({ inn: '540000000001', kpp: '540001001' });
    expect(result.agreement).toMatchObject({
      guid: 'agreement-guid',
      organization: { guid: 'org-guid', name: 'Организация' },
      warehouse: { guid: 'warehouse-guid', name: 'Склад' },
      priceType: { guid: 'price-type-guid', name: 'Розничная' },
    });
    expect(result.contract).toMatchObject({ guid: 'contract-guid', organization: { guid: 'org-guid', name: 'Организация' } });
    expect(result.deliveryAddress).toMatchObject({ guid: 'address-guid', fullAddress: 'Новосибирск' });
    expect(result.paymentForm).toBeNull();
    expect(result.paymentForms).toEqual([
      { code: null, name: 'Любая', label: 'Любая' },
      { code: 'Наличная', name: 'Наличная', label: 'Наличная' },
    ]);
    expect(result.deliveryMethod).toBe('ДоКлиента');
    expect(result.deliveryMethods).toEqual([
      { code: 'ДоКлиента', name: 'ДоКлиента', label: 'Наша доставка' },
      { code: 'Самовывоз', name: 'Самовывоз', label: 'Самовывоз' },
    ]);
    expect(result.warnings).toEqual(['warning']);
  });

  it('normalizes products with package, price, stock and filters deleted rows', async () => {
    nomenclatureMock.mockResolvedValueOnce(
      paged([
        {
          guid: 'product-guid',
          name: 'Молоко 0,05%',
          code: '41001',
          article: 'YT-00008199',
          baseUnit: { guid: 'unit-guid', name: 'штука', symbol: 'шт' },
          packages: [{ guid: 'package-guid', name: 'кор', multiplier: 12, unit: { guid: 'unit-guid', name: 'штука', symbol: 'шт' } }],
          price: 123.45,
          costPrice: 111.11,
          currency: 'RUB',
          stock: { quantity: 37, reserved: 2, available: 35, freeAvailable: 15, myReserved: 20 },
          isActive: true,
        },
        {
          guid: 'deleted-product',
          name: 'Удаленный товар',
          deletionMark: true,
        },
      ])
    );

    const result = await getLiveProducts({
      limit: 25,
      offset: 0,
      search: 'молоко',
      warehouseGuid: 'warehouse-guid',
      priceTypeGuid: 'price-type-guid',
      managerGuid: 'manager-guid',
      inStockOnly: true,
      includeInactive: false,
    });

    expect(nomenclatureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        search: 'молоко',
        warehouseGuid: 'warehouse-guid',
        priceTypeGuid: 'price-type-guid',
        managerGuid: 'manager-guid',
        inStockOnly: true,
      })
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      guid: 'product-guid',
      name: 'Молоко 0,05%',
      code: '41001',
      article: 'YT-00008199',
      basePrice: 123.45,
      receiptPrice: 111.11,
      currency: 'RUB',
      stock: { quantity: 37, reserved: 2, available: 35, freeAvailable: 15, myReserved: 20 },
    });
    expect(result.items[0].packages[0]).toMatchObject({ guid: 'package-guid', name: 'кор', multiplier: 12 });
  });

  it('finds products by unordered search tokens when 1C phrase search misses', async () => {
    nomenclatureMock
      .mockResolvedValueOnce(paged([]))
      .mockResolvedValueOnce(
        paged([
          { guid: 'product-1', name: 'Филе кеты свежемороженое', code: 'UT-1', isActive: true },
          { guid: 'product-2', name: 'Филе трески', code: 'UT-2', isActive: true },
        ])
      )
      .mockResolvedValueOnce(
        paged([
          { guid: 'product-1', name: 'Филе кеты свежемороженое', code: 'UT-1', isActive: true },
          { guid: 'product-3', name: 'Кета стейк', code: 'UT-3', isActive: true },
        ])
      );

    const result = await getLiveProducts({
      limit: 25,
      offset: 0,
      search: 'кеты филе',
      includeInactive: false,
    });

    expect(nomenclatureMock).toHaveBeenNthCalledWith(1, expect.objectContaining({ search: 'кеты филе' }));
    expect(nomenclatureMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ search: 'кеты' }));
    expect(nomenclatureMock).toHaveBeenNthCalledWith(3, expect.objectContaining({ search: 'филе' }));
    expect(result.items.map((item) => item.guid)).toEqual(['product-1']);
  });

  it('loads missing product details by guid and keeps requested order', async () => {
    nomenclatureMock.mockResolvedValueOnce(
      paged([
        {
          guid: 'product-2',
          name: 'Товар 2',
          price: 200,
        },
      ])
    );
    nomenclatureItemMock.mockResolvedValueOnce({
      item: {
        guid: 'product-1',
        name: 'Товар 1',
        price: 100,
      },
    });

    const result = await getLiveProductsByGuids({
      productGuids: ['product-1', 'product-2'],
      warehouseGuid: 'warehouse-guid',
      priceTypeGuid: 'price-type-guid',
      managerGuid: 'manager-guid',
    });

    expect(nomenclatureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        guids: 'product-1,product-2',
        warehouseGuid: 'warehouse-guid',
        priceTypeGuid: 'price-type-guid',
        managerGuid: 'manager-guid',
      })
    );
    expect(nomenclatureItemMock).toHaveBeenCalledWith(
      'product-1',
      expect.objectContaining({ warehouseGuid: 'warehouse-guid', managerGuid: 'manager-guid' })
    );
    expect(result.map((item) => item.guid)).toEqual(['product-1', 'product-2']);
  });

  it('builds reference-data bundle from live 1C dictionaries', async () => {
    counterpartiesMock.mockResolvedValueOnce(paged([{ guid: 'counterparty-guid', name: 'Контрагент' }]));
    agreementsMock.mockResolvedValueOnce(paged([{ guid: 'agreement-guid', name: 'Соглашение', counterpartyGuid: 'counterparty-guid' }]));
    contractsMock.mockResolvedValueOnce(paged([{ guid: 'contract-guid', name: 'Договор', number: 'Д-1', counterpartyGuid: 'counterparty-guid' }]));
    deliveryAddressesMock.mockResolvedValueOnce(paged([{ guid: 'address-guid', fullAddress: 'Новосибирск', counterpartyGuid: 'counterparty-guid' }]));
    warehousesMock.mockResolvedValueOnce(paged([{ guid: 'warehouse-guid', name: 'Склад' }]));

    const data = await getLiveReferenceData({ counterpartyGuid: 'counterparty-guid', includeInactive: false });

    expect(data.counterparties).toHaveLength(1);
    expect(data.agreements).toHaveLength(1);
    expect(data.contracts).toHaveLength(1);
    expect(data.deliveryAddresses).toHaveLength(1);
    expect(data.warehouses).toHaveLength(1);
  });

  it('normalizes live client orders with appGuid for dedupe and manager scope', async () => {
    clientOrdersMock.mockResolvedValueOnce(
      paged(
        [
          {
            guid: 'onec-document-guid',
            documentGuid: 'onec-document-guid',
            appGuid: 'local-app-guid',
            documentNumber: '00-000123',
            documentDate: '2026-06-25T09:00:00.000Z',
            paymentForm: 'Безналичная',
            deliveryMethod: 'Самовывоз',
            counterparty: { guid: 'counterparty-guid', name: 'Контрагент' },
            organization: { guid: 'org-guid', name: 'Организация' },
            warehouse: { guid: 'warehouse-guid', name: 'Склад' },
            totalAmount: 1250,
            isPosted: true,
            itemsCount: 2,
          },
        ],
        { limit: 20, offset: 0, total: 1 }
      )
    );

    const result = await getLiveClientOrders({
      limit: 20,
      offset: 0,
      managerGuid: 'manager-guid',
      search: '00-000123',
      onlyProblems: false,
    });

    expect(clientOrdersMock).toHaveBeenCalledWith(expect.objectContaining({
      managerGuid: 'manager-guid',
      search: '00-000123',
      limit: 20,
      offset: 0,
    }));
    expect(result.items[0]).toMatchObject({
      guid: 'onec-document-guid',
      documentGuid: 'onec-document-guid',
      appGuid: 'local-app-guid',
      number1c: '00-000123',
      paymentForm: 'Безналичная',
      deliveryMethod: 'Самовывоз',
      syncState: 'SYNCED',
      status: 'CONFIRMED',
      readOnly: false,
      counterparty: { guid: 'counterparty-guid', name: 'Контрагент' },
      itemsCount: 2,
    });
  });

  it('normalizes live client order warehouse from flat summary fields', async () => {
    clientOrdersMock.mockResolvedValueOnce(
      paged(
        [
          {
            guid: 'onec-document-guid',
            documentGuid: 'onec-document-guid',
            appGuid: 'local-app-guid',
            documentNumber: '00-000124',
            documentDate: '2026-06-25T09:00:00.000Z',
            counterparty: { guid: 'counterparty-guid', name: 'Контрагент' },
            organization: { guid: 'org-guid', name: 'Организация' },
            warehouseGuid: 'warehouse-flat-guid',
            warehouseName: 'Склад из строки списка',
            totalAmount: 1250,
            itemsCount: 2,
          },
        ],
        { limit: 20, offset: 0, total: 1 }
      )
    );

    const result = await getLiveClientOrders({
      limit: 20,
      offset: 0,
      managerGuid: 'manager-guid',
      onlyProblems: false,
    });

    expect(result.items[0].warehouse).toEqual({
      guid: 'warehouse-flat-guid',
      name: 'Склад из строки списка',
      code: null,
    });
  });

  it('normalizes live client order detail line guids for stable row matching', async () => {
    clientOrderMock.mockResolvedValueOnce({
      item: {
        guid: 'onec-document-guid',
        documentGuid: 'onec-document-guid',
        appGuid: 'local-app-guid',
        documentNumber: '00-000123',
        documentDate: '2026-06-25T09:00:00.000Z',
        counterparty: { guid: 'counterparty-guid', name: 'Контрагент' },
        totalAmount: 100,
        items: [
          {
            lineGuid: 'line-guid-1',
            product: { guid: 'product-guid', name: 'Товар' },
            quantity: 2,
            quantityBase: 20,
            price: 100,
            basePrice: 100,
            isManualPrice: true,
            manualPrice: 100,
            priceSource: 'manual',
            priceType: null,
            lineAmount: 2000,
            package: { guid: 'box-10', name: 'кор (10 кг)', multiplier: 10 },
            unit: { guid: 'kg', name: 'Килограмм', symbol: 'кг' },
          },
        ],
      },
    });

    const result = await getLiveClientOrder('onec-document-guid', {
      managerGuid: 'manager-guid',
      appGuid: 'local-app-guid',
    });

    expect(clientOrderMock).toHaveBeenCalledWith(
      'onec-document-guid',
      expect.objectContaining({
        managerGuid: 'manager-guid',
        appGuid: 'local-app-guid',
        includeItems: true,
      })
    );
    expect(result.items[0]).toMatchObject({
      lineGuid: 'line-guid-1',
      quantity: 2,
      quantityBase: 20,
      basePrice: 100,
      isManualPrice: true,
      manualPrice: 100,
      priceSource: 'manual',
      priceType: null,
      lineAmount: 2000,
      product: { guid: 'product-guid', name: 'Товар' },
      package: { guid: 'box-10', name: 'кор (10 кг)', multiplier: 10 },
      unit: { guid: 'kg', name: 'Килограмм', symbol: 'кг' },
    });
  });

  it('preserves live 1C order statuses and document price type', async () => {
    clientOrdersMock.mockResolvedValueOnce(
      paged(
        [
          { guid: 'approval', documentNumber: '1', currentState1c: 'Ожидается согласование' },
          { guid: 'advance', documentNumber: '2', currentState1c: 'Ожидается аванс до обеспечения' },
          { guid: 'ready-supply', documentNumber: '3', currentState1c: 'Готов к обеспечению' },
          { guid: 'prepay-ship', documentNumber: '4', currentState1c: 'Ожидается предоплата до отгрузки' },
          { guid: 'awaiting-supply', documentNumber: '5', currentState1c: 'Ожидается обеспечение' },
          { guid: 'ready-ship', documentNumber: '6', currentState1c: 'Готов к отгрузке' },
          { guid: 'shipping', documentNumber: '7', currentState1c: 'В процессе отгрузки' },
          { guid: 'payment-after', documentNumber: '8', currentState1c: 'Ожидается оплата после отгрузки' },
          { guid: 'ready-close', documentNumber: '9', currentState1c: 'Готов к закрытию' },
          {
            guid: 'closed',
            documentNumber: '10',
            currentState1c: 'Закрыт',
            documentStatus1c: 'К отгрузке',
            priceType: { guid: 'price-type-guid', name: 'Оптовая' },
          },
          {
            guid: 'document-status-fallback',
            documentNumber: '11',
            status: 'CONFIRMED',
            documentStatus1c: 'К отгрузке',
          },
          {
            guid: 'legacy-confirmed-text',
            documentNumber: '12',
            status1c: 'Подтвержден',
          },
        ],
        { limit: 20, offset: 0, total: 12 }
      )
    );

    const result = await getLiveClientOrders({
      limit: 20,
      offset: 0,
      managerGuid: 'manager-guid',
      onlyProblems: false,
    });

    expect(result.items.map((item) => item.status)).toEqual([
      'AWAITING_APPROVAL',
      'AWAITING_ADVANCE_BEFORE_SUPPLY',
      'READY_FOR_SUPPLY',
      'AWAITING_PREPAYMENT_BEFORE_SHIPMENT',
      'AWAITING_SUPPLY',
      'READY_FOR_SHIPMENT',
      'SHIPPING_IN_PROGRESS',
      'AWAITING_PAYMENT_AFTER_SHIPMENT',
      'READY_TO_CLOSE',
      'CLOSED',
      'CONFIRMED',
      'CONFIRMED',
    ]);
    expect(result.items[9]).toMatchObject({
      status1c: 'Закрыт',
      currentState1c: 'Закрыт',
      documentStatus1c: 'К отгрузке',
      priceType: { guid: 'price-type-guid', name: 'Оптовая' },
    });
    expect(result.items[10]).toMatchObject({
      status: 'CONFIRMED',
      status1c: null,
      currentState1c: null,
      documentStatus1c: 'К отгрузке',
    });
    expect(result.items[11]).toMatchObject({
      status: 'CONFIRMED',
      status1c: 'Подтвержден',
      currentState1c: null,
    });
  });
});
