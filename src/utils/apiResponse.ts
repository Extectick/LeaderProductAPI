export enum ErrorCodes {
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  NOT_FOUND = 'NOT_FOUND',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  CONFLICT = 'CONFLICT',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  TOO_MANY_REQUESTS = 'TOO_MANY_REQUESTS',
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',
  REFRESH_TOKEN_INVALID = 'REFRESH_TOKEN_INVALID',
  REFRESH_TOKEN_ROTATED = 'REFRESH_TOKEN_ROTATED',
  DEVICE_SESSION_REVOKED = 'DEVICE_SESSION_REVOKED',
  SERVICE_ACCESS_DENIED = 'SERVICE_ACCESS_DENIED',
  TRACKING_SESSION_NOT_FOUND = 'TRACKING_SESSION_NOT_FOUND'
}

export interface SuccessResponse<T> {
  ok: true;
  message: string;
  data: T;
  meta?: {
    count?: number;
    page?: number;
    total?: number;
  };
}

export interface ErrorResponse {
  ok: false;
  message: string;
  error: {
    code: ErrorCodes;
    details?: any;
  };
}

export function successResponse<T>(
  data: T,
  message: string = 'Success',
  meta?: any
): SuccessResponse<T> {
  return { ok: true, message, data, meta };
}

export function errorResponse(
  message: string,
  code: ErrorCodes,
  details?: any
): ErrorResponse {
  return { 
    ok: false, 
    message, 
    error: { code, details } 
  };
}
