import QRCode from 'qrcode';
import { validateQRData } from '../utils/validateQRData';

interface QRCodeOptions {
  width?: number;
  color?: {
    dark?: string;
    light?: string;
  };
  errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
}

/**
 * Генерирует QR код в формате Base64
 * @param data Данные для кодирования в QR
 * @param options Опции генерации
 * @returns Promise с Data URL (base64) изображения QR кода
 * @throws Ошибка генерации QR кода
 */
export const generateQRCode = async (
  data: string,
  options: QRCodeOptions = {}
): Promise<string> => {
  try {
    const defaultOptions: QRCode.QRCodeToDataURLOptions = {
      width: 200,
      color: {
        dark: '#000000',
        light: '#ffffff'
      },
      errorCorrectionLevel: 'M',
      ...options
    };

    if (!data || typeof data !== 'string') {
      throw new Error('Данные для QR кода должны быть непустой строкой');
    }

    return await QRCode.toDataURL(data, defaultOptions);
  } catch (error) {
    console.error('Ошибка генерации QR кода:', error);
    throw new Error(
      `Не удалось сгенерировать QR код: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`
    );
  }
};

/**
 * Валидация опций генерации QR кода
 */
const validateOptions = (options: QRCodeOptions): void => {
  if (options.width && (options.width < 50 || options.width > 1000)) {
    throw new Error('Ширина QR кода должна быть между 50 и 1000 пикселями');
  }
  
  if (options.color?.dark && !/^#[0-9A-F]{6}$/i.test(options.color.dark)) {
    throw new Error('Некорректный формат цвета (dark)');
  }

  if (options.color?.light && !/^#[0-9A-F]{6}$/i.test(options.color.light)) {
    throw new Error('Некорректный формат цвета (light)');
  }
};

function generateVCard(contact: Record<string, any>): string {
  const escapeValue = (value: string) =>
    value.replace(/\n/g, '\\n').replace(/,/g, '\\,');

  let vCard = 'BEGIN:VCARD\nVERSION:3.0\n';

  if (contact.name) vCard += `FN:${escapeValue(contact.name)}\n`;
  if (contact.phone) vCard += `TEL:${escapeValue(contact.phone)}\n`;
  if (contact.email) vCard += `EMAIL:${escapeValue(contact.email)}\n`;
  if (contact.org) vCard += `ORG:${escapeValue(contact.org)}\n`;
  if (contact.title) vCard += `TITLE:${escapeValue(contact.title)}\n`;
  if (contact.address) vCard += `ADR:${escapeValue(contact.address)}\n`;
  if (contact.url) vCard += `URL:${escapeValue(contact.url)}\n`;
  if (contact.note) vCard += `NOTE:${escapeValue(contact.note)}\n`;
  if (contact.birthday) vCard += `BDAY:${escapeValue(contact.birthday)}\n`;
  if (contact.fax) vCard += `FAX:${escapeValue(contact.fax)}\n`;
  if (contact.photo) vCard += `PHOTO:${escapeValue(contact.photo)}\n`;

  vCard += 'END:VCARD';

  return vCard;
}



const ALLOWED_QR_TYPES = ['PHONE','LINK','EMAIL','TEXT','WHATSAPP','TELEGRAM','CONTACT'] as const;
type AllowedQrType = typeof ALLOWED_QR_TYPES[number];

export function toStringData(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object') return JSON.stringify(raw);
  return String(raw ?? '');
}

export function normalizeAndValidate(qrType: AllowedQrType, qrDataRaw: unknown): string {
  // приведение к строке/JSON
  let data = toStringData(qrDataRaw);

  // CONTACT: разрешаем JSON -> VCARD, либо уже готовый VCARD
  if (qrType === 'CONTACT') {
    if (data.startsWith('BEGIN:VCARD')) {
      // уже VCARD
    } else {
      try {
        const contactObj = JSON.parse(data);
        data = generateVCard(contactObj);
      } catch (e) {
        throw new Error('Неверный формат контактных данных');
      }
    }
    return data;
  }

  // для не-CONTACT: валидация строкой
  if (typeof data !== 'string') {
    throw new Error('qrData должен быть строкой или объектом');
  }

  // Спец-нормализация под типы
  if (qrType === 'PHONE' || qrType === 'WHATSAPP') {
    let cleaned = data.replace(/[^\d+]/g, '');
    if (!cleaned.startsWith('+')) cleaned = '+' + cleaned.replace(/[^\d]/g, '');
    data = cleaned.slice(0, 12);
  }

  if (qrType === 'TELEGRAM') {
    if (!data.startsWith('@')) data = '@' + data.replace(/^@+/, '');
  }

  const validationError = validateQRData(qrType, data);
  if (validationError) throw new Error(validationError);

  return data;
}

export function assertQrType(type?: string): asserts type is AllowedQrType {
  if (!type || !ALLOWED_QR_TYPES.includes(type as AllowedQrType)) {
    throw new Error('Неверный тип qrType');
  }
}

