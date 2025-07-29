// utils/validateQRData.ts
const validator = require('validator');

export type QRType =
  | 'PHONE'
  | 'LINK'
  | 'EMAIL'
  | 'TEXT'
  | 'WHATSAPP'
  | 'TELEGRAM'
  | 'CONTACT';

export function validateQRData(qrType: QRType, qrData: string): string | null {
  switch (qrType) {
    case 'PHONE':
    case 'WHATSAPP':
      if (!/^[+]\d{5,11}$/.test(qrData)) {
        return 'Номер телефона должен начинаться с + и содержать до 12 символов';
      }
      break;

    case 'EMAIL':
      if (!validator.isEmail(qrData)) {
        return 'Неверный email';
      }
      break;

    case 'LINK':
      if (
        !validator.isURL(qrData, {
          require_protocol: false,
          protocols: ['http', 'https'],
          allow_underscores: true,
        })
      ) {
        return 'Неверный URL';
      }
      break;

    case 'TELEGRAM':
      if (!/^@[a-zA-Z0-9_]{5,32}$/.test(qrData)) {
        return 'Telegram username должен начинаться с @ и быть от 5 до 32 символов';
      }
      break;

    case 'CONTACT':
      try {
        const parsed = JSON.parse(qrData);
        if (!parsed.name || typeof parsed.name !== 'string') {
          return 'Контакт должен содержать поле name';
        }
      } catch {
        return 'Неверный JSON формат контакта';
      }
      break;

    case 'TEXT':
      if (qrData.length > 1000) {
        return 'Слишком длинный текст (макс 1000 символов)';
      }
      break;

    default:
      return 'Неподдерживаемый тип QR';
  }

  return null; // Все прошло
}
