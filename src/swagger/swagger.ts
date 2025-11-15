// src/swagger/swagger.ts
import swaggerJSDoc from 'swagger-jsdoc';
import appealsSchemas from './schemas/appeals.schema';
import qrSchemas from './schemas/qr.schema';
import usersSchemas from './schemas/users.schema';
import trackingSchemas from './schemas/tracking.schema';

export const swaggerSpec = swaggerJSDoc({
  definition: {
    openapi: '3.0.0',
    info: { title: 'API', version: '1.0.0' },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
      schemas: {
        ApiSuccess: {
          type: 'object',
          required: ['success'],
          properties: {
            success: { type: 'boolean', example: true },
            message: { type: 'string', nullable: true, example: 'OK' },
            data: {
              nullable: true,
              oneOf: [
                { type: 'object', additionalProperties: true },
                { type: 'array', items: {} },
                { type: 'string' },
                { type: 'number' },
                { type: 'boolean' },
                { type: 'null' }
              ]
            }
          }
        },
        ApiError: {
          type: 'object',
          required: ['success', 'error'],
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: {
                code: { type: 'string', example: 'VALIDATION_ERROR' },
                message: { type: 'string', example: 'Поле email обязательно' },
                details: {
                  nullable: true,
                  oneOf: [
                    { type: 'object', additionalProperties: true },
                    { type: 'array', items: {} },
                    { type: 'string' }
                  ]
                }
              }
            }
          }
        },

        // ВАЖНО: подключаем схемы appeals именно сюда
        ...appealsSchemas,
        ...qrSchemas,
        ...usersSchemas,
        ...trackingSchemas
      },
    },
  },
  apis: ['src/routes/**/*.ts'],
});
