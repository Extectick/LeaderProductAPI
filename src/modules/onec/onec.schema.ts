export type OneCSchemaFieldType =
  | 'string'
  | 'boolean'
  | 'number'
  | 'dateTime'
  | 'object';

export type OneCSchemaField = {
  code: string;
  title: string;
  type: OneCSchemaFieldType;
  required: boolean;
  nullable: boolean;
};

export type OneCSchemaSection = {
  code: string;
  title: string;
  multiple: boolean;
  fields: OneCSchemaField[];
};

export type OneCSchemaEntity = {
  code: string;
  title: string;
  method: 'POST';
  path: string;
  wrapper: 'items';
  sections: OneCSchemaSection[];
};

const stringField = (
  code: string,
  title: string,
  options?: Partial<Pick<OneCSchemaField, 'required' | 'nullable'>>
): OneCSchemaField => ({
  code,
  title,
  type: 'string',
  required: options?.required ?? false,
  nullable: options?.nullable ?? false,
});

const booleanField = (
  code: string,
  title: string,
  options?: Partial<Pick<OneCSchemaField, 'required' | 'nullable'>>
): OneCSchemaField => ({
  code,
  title,
  type: 'boolean',
  required: options?.required ?? false,
  nullable: options?.nullable ?? false,
});

const numberField = (
  code: string,
  title: string,
  options?: Partial<Pick<OneCSchemaField, 'required' | 'nullable'>>
): OneCSchemaField => ({
  code,
  title,
  type: 'number',
  required: options?.required ?? false,
  nullable: options?.nullable ?? false,
});

const dateTimeField = (
  code: string,
  title: string,
  options?: Partial<Pick<OneCSchemaField, 'required' | 'nullable'>>
): OneCSchemaField => ({
  code,
  title,
  type: 'dateTime',
  required: options?.required ?? false,
  nullable: options?.nullable ?? false,
});

export const ONEC_SCHEMA_VERSION = '1.0.0';

export const onecSchemaEntities: OneCSchemaEntity[] = [
  {
    code: 'nomenclature',
    title: 'Номенклатура',
    method: 'POST',
    path: '/api/1c/nomenclature/batch',
    wrapper: 'items',
    sections: [
      {
        code: 'group',
        title: 'Группы номенклатуры',
        multiple: true,
        fields: [
          stringField('guid', 'GUID', { required: true }),
          booleanField('isGroup', 'Это группа', { required: true }),
          stringField('parentGuid', 'GUID родителя', { nullable: true }),
          stringField('name', 'Наименование', { required: true }),
          stringField('code', 'Код'),
          booleanField('isActive', 'Активна'),
          dateTimeField('sourceUpdatedAt', 'Дата изменения в 1С'),
        ],
      },
      {
        code: 'product',
        title: 'Товары',
        multiple: true,
        fields: [
          stringField('guid', 'GUID', { required: true }),
          booleanField('isGroup', 'Это группа', { required: true }),
          stringField('parentGuid', 'GUID группы', { nullable: true }),
          stringField('name', 'Наименование', { required: true }),
          stringField('code', 'Код'),
          stringField('article', 'Артикул'),
          stringField('sku', 'SKU'),
          booleanField('isWeight', 'Весовой'),
          booleanField('isService', 'Услуга'),
          booleanField('isActive', 'Активен'),
          dateTimeField('sourceUpdatedAt', 'Дата изменения в 1С'),
        ],
      },
      {
        code: 'baseUnit',
        title: 'Базовая единица',
        multiple: false,
        fields: [
          stringField('guid', 'GUID', { required: true }),
          stringField('name', 'Наименование', { required: true }),
          stringField('code', 'Код'),
          stringField('symbol', 'Символ'),
          dateTimeField('sourceUpdatedAt', 'Дата изменения в 1С'),
        ],
      },
      {
        code: 'packages',
        title: 'Упаковки',
        multiple: true,
        fields: [
          stringField('guid', 'GUID'),
          stringField('name', 'Наименование', { required: true }),
          numberField('multiplier', 'Кратность', { required: true }),
          stringField('barcode', 'Штрихкод'),
          booleanField('isDefault', 'По умолчанию'),
          numberField('sortOrder', 'Порядок'),
          dateTimeField('sourceUpdatedAt', 'Дата изменения в 1С'),
          stringField('unitGuid', 'GUID единицы', { required: true }),
          stringField('unitName', 'Наименование единицы', { required: true }),
          stringField('unitCode', 'Код единицы'),
          stringField('unitSymbol', 'Символ единицы'),
          dateTimeField('unitSourceUpdatedAt', 'Дата изменения единицы в 1С'),
        ],
      },
    ],
  },
  {
    code: 'warehouses',
    title: 'Склады',
    method: 'POST',
    path: '/api/1c/warehouses/batch',
    wrapper: 'items',
    sections: [
      {
        code: 'item',
        title: 'Склад',
        multiple: true,
        fields: [
          stringField('guid', 'GUID', { required: true }),
          stringField('name', 'Наименование', { required: true }),
          stringField('code', 'Код'),
          booleanField('isActive', 'Активен'),
          booleanField('isDefault', 'По умолчанию'),
          booleanField('isPickup', 'Самовывоз'),
          stringField('address', 'Адрес', { nullable: true }),
          dateTimeField('sourceUpdatedAt', 'Дата изменения в 1С'),
        ],
      },
    ],
  },
  {
    code: 'counterparties',
    title: 'Контрагенты',
    method: 'POST',
    path: '/api/1c/counterparties/batch',
    wrapper: 'items',
    sections: [
      {
        code: 'counterparty',
        title: 'Контрагент',
        multiple: true,
        fields: [
          stringField('guid', 'GUID', { required: true }),
          stringField('name', 'Наименование', { required: true }),
          stringField('fullName', 'Полное наименование', { nullable: true }),
          stringField('inn', 'ИНН', { nullable: true }),
          stringField('kpp', 'КПП', { nullable: true }),
          stringField('phone', 'Телефон', { nullable: true }),
          stringField('email', 'Email', { nullable: true }),
          booleanField('isActive', 'Активен'),
          dateTimeField('sourceUpdatedAt', 'Дата изменения в 1С'),
        ],
      },
      {
        code: 'addresses',
        title: 'Адреса доставки',
        multiple: true,
        fields: [
          stringField('guid', 'GUID'),
          stringField('name', 'Наименование'),
          stringField('fullAddress', 'Полный адрес', { required: true }),
          stringField('city', 'Город', { nullable: true }),
          stringField('street', 'Улица', { nullable: true }),
          stringField('house', 'Дом', { nullable: true }),
          stringField('building', 'Корпус', { nullable: true }),
          stringField('apartment', 'Квартира', { nullable: true }),
          stringField('postcode', 'Индекс', { nullable: true }),
          booleanField('isDefault', 'По умолчанию'),
          booleanField('isActive', 'Активен'),
          dateTimeField('sourceUpdatedAt', 'Дата изменения в 1С'),
        ],
      },
    ],
  },
  {
    code: 'agreements',
    title: 'Договоры и соглашения',
    method: 'POST',
    path: '/api/1c/agreements/batch',
    wrapper: 'items',
    sections: [
      {
        code: 'priceType',
        title: 'Тип цены',
        multiple: false,
        fields: [
          stringField('guid', 'GUID', { required: true }),
          stringField('name', 'Наименование', { required: true }),
          stringField('code', 'Код'),
          booleanField('isActive', 'Активен'),
          dateTimeField('sourceUpdatedAt', 'Дата изменения в 1С'),
        ],
      },
      {
        code: 'contract',
        title: 'Договор',
        multiple: false,
        fields: [
          stringField('guid', 'GUID', { required: true }),
          stringField('counterpartyGuid', 'GUID контрагента', { required: true }),
          stringField('number', 'Номер', { required: true }),
          dateTimeField('date', 'Дата', { required: true }),
          dateTimeField('validFrom', 'Действует с'),
          dateTimeField('validTo', 'Действует по'),
          booleanField('isActive', 'Активен'),
          stringField('comment', 'Комментарий', { nullable: true }),
          dateTimeField('sourceUpdatedAt', 'Дата изменения в 1С'),
        ],
      },
      {
        code: 'agreement',
        title: 'Соглашение',
        multiple: false,
        fields: [
          stringField('guid', 'GUID', { required: true }),
          stringField('name', 'Наименование', { required: true }),
          stringField('counterpartyGuid', 'GUID контрагента'),
          stringField('contractGuid', 'GUID договора'),
          stringField('priceTypeGuid', 'GUID типа цены'),
          stringField('warehouseGuid', 'GUID склада'),
          stringField('currency', 'Валюта', { nullable: true }),
          booleanField('isActive', 'Активно'),
          dateTimeField('sourceUpdatedAt', 'Дата изменения в 1С'),
        ],
      },
    ],
  },
  {
    code: 'product-prices',
    title: 'Базовые цены',
    method: 'POST',
    path: '/api/1c/product-prices/batch',
    wrapper: 'items',
    sections: [
      {
        code: 'item',
        title: 'Цена товара',
        multiple: true,
        fields: [
          stringField('guid', 'GUID'),
          stringField('productGuid', 'GUID товара', { required: true }),
          stringField('priceTypeGuid', 'GUID типа цены'),
          numberField('price', 'Цена', { required: true }),
          stringField('currency', 'Валюта'),
          dateTimeField('startDate', 'Начало действия'),
          dateTimeField('endDate', 'Окончание действия'),
          numberField('minQty', 'Минимальное количество'),
          booleanField('isActive', 'Активна'),
          dateTimeField('sourceUpdatedAt', 'Дата изменения в 1С'),
        ],
      },
    ],
  },
  {
    code: 'special-prices',
    title: 'Спеццены',
    method: 'POST',
    path: '/api/1c/special-prices/batch',
    wrapper: 'items',
    sections: [
      {
        code: 'item',
        title: 'Спеццена',
        multiple: true,
        fields: [
          stringField('guid', 'GUID'),
          stringField('productGuid', 'GUID товара', { required: true }),
          stringField('counterpartyGuid', 'GUID контрагента'),
          stringField('agreementGuid', 'GUID соглашения'),
          stringField('priceTypeGuid', 'GUID типа цены'),
          numberField('price', 'Цена', { required: true }),
          stringField('currency', 'Валюта'),
          dateTimeField('startDate', 'Начало действия'),
          dateTimeField('endDate', 'Окончание действия'),
          numberField('minQty', 'Минимальное количество'),
          booleanField('isActive', 'Активна'),
          dateTimeField('sourceUpdatedAt', 'Дата изменения в 1С'),
        ],
      },
    ],
  },
  {
    code: 'stock',
    title: 'Остатки',
    method: 'POST',
    path: '/api/1c/stock/batch',
    wrapper: 'items',
    sections: [
      {
        code: 'item',
        title: 'Остаток',
        multiple: true,
        fields: [
          stringField('productGuid', 'GUID товара', { required: true }),
          stringField('warehouseGuid', 'GUID склада', { required: true }),
          numberField('quantity', 'Количество', { required: true }),
          numberField('reserved', 'Резерв'),
          dateTimeField('updatedAt', 'Дата обновления', { required: true }),
        ],
      },
    ],
  },
];
