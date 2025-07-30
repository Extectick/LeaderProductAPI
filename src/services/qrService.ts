import QRCode from 'qrcode';

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
