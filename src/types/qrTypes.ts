import { ErrorResponse, SuccessResponse } from "utils/apiResponse";

// QR types
export type QRCreateRequest = {
  qrData: string | object;
  description?: string;
  qrType: 'PHONE'|'LINK'|'EMAIL'|'TEXT'|'WHATSAPP'|'TELEGRAM'|'CONTACT';
};

export type QRCreateResponse = SuccessResponse<{
  id: string;
  qrData: string;
  qrType: string;
  description: string | null;
  status: string;
  createdAt: Date;
}> | ErrorResponse;

export type QRUpdateRequest = {
  status?: 'ACTIVE'|'PAUSED'|'DELETED';
  description?: string | null;             // опционально, допускаем null чтобы очистить
  qrData?: unknown;                         // опционально
  qrType?: 'PHONE'|'LINK'|'EMAIL'|'TEXT'|'WHATSAPP'|'TELEGRAM'|'CONTACT'; // опционально
};

export type QRUpdateResponse = SuccessResponse<{
  id: string;
  qrData: string;
  description: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}> | ErrorResponse;

export type QRGetAllRequest = {
  createdById?: string;
  status?: 'ACTIVE'|'PAUSED'|'DELETED';
  limit?: string;
  offset?: string;
};

export type QRGetAllResponse = SuccessResponse<{
  data: Array<{
    id: string;
    qrData: string;
    description: string | null;
    status: string;
    createdAt: Date;
    createdBy?: {
      id: number;
      email: string | null;
    };
  }>;
  meta: {
    total: number;
    limit: string;
    offset: string;
  };
}> | ErrorResponse;

export type QRGetByIdRequest = {
  simple?: boolean;
  width?: number;
  darkColor?: string;
  lightColor?: string;
  margin?: number;
  errorCorrection?: 'L'|'M'|'Q'|'H';
};

export type QRGetByIdResponse = SuccessResponse<{
  id: string;
  qrData: string;
  qrType: string;
  description: string | null;
  status: string;
  createdAt: Date;
  createdBy?: {
    id: number;
    email: string | null;
    firstName?: string | null;
    lastName?: string | null;
  };
  qrImage?: string;
}> | ErrorResponse | string; // Добавлен string для случая simple=true

export type QRAnalyticsResponse = SuccessResponse<Array<{
  device: string;
  browser: string;
  location: string;
  count: number;
}>> | ErrorResponse;

export type QRStatsResponse = SuccessResponse<{
  totalQRCodes: number;
  activeQRCodes: number;
  pausedQRCodes: number;
  deletedQRCodes: number;
  totalScans: number;
}> | ErrorResponse;

export type QRExportResponse = string | ErrorResponse;

export type QRRestoreResponse = SuccessResponse<{
  id: string;
  status: string;
  qrData: string;
  description: string | null;
}> | ErrorResponse;
export type QRAnalyticsQueryRequest = {
  ids?: string;                   // "abc,def"
  from?: string;                  // ISO
  to?: string;                    // ISO
  tz?: string;                    // e.g. "Europe/Warsaw"
  bucket?: 'hour'|'day'|'week'|'month';
  groupBy?: string;               // "device,browser"
  top?: string;                   // "10"
  device?: string;                // "mobile,desktop"
  browser?: string;               // "Chrome,Firefox"
  location?: string;              // "Warsaw,PL"
  include?: string;               // "totals,series,breakdown"
};

export type QRAnalyticsQueryResponse = SuccessResponse<{
  meta: {
    from: string;
    to: string;
    tz: string;
    ids: string[];
  };
  totals?: {
    scans: number;
    uniqueIPs: number;
    uniqueDevices: number; // по (device,browser)
  };
  series?: Array<{ ts: string; scans: number }>;
  breakdown?: {
    by: string[]; // e.g. ["device","browser"]
    rows: Array<{ key: Record<string,string>; scans: number }>;
  };
}> | ErrorResponse;
