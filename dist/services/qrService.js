"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateQRCode = void 0;
const qrcode_1 = __importDefault(require("qrcode"));
/**
 * Генерирует QR код в формате Base64
 * @param data Данные для кодирования в QR
 * @param options Опции генерации
 * @returns Promise с Data URL (base64) изображения QR кода
 * @throws Ошибка генерации QR кода
 */
const generateQRCode = async (data, options = {}) => {
    try {
        const defaultOptions = {
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
        return await qrcode_1.default.toDataURL(data, defaultOptions);
    }
    catch (error) {
        console.error('Ошибка генерации QR кода:', error);
        throw new Error(`Не удалось сгенерировать QR код: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`);
    }
};
exports.generateQRCode = generateQRCode;
/**
 * Валидация опций генерации QR кода
 */
const validateOptions = (options) => {
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
