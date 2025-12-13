
import { ErrorResponse, SuccessResponse } from '../utils/apiResponse';
import { AuthRequest } from '../middleware/auth';
import { ProfileType, ProfileStatus } from '@prisma/client';
import { Profile } from './userTypes';

// Auth types
export type AuthLoginRequest = {
  email: string;
  password: string;
};

export type AuthLoginResponseData = {
  accessToken: string;
  refreshToken: string;
  profile: Profile;
  message: string;
};

export type AuthLoginResponse = SuccessResponse<AuthLoginResponseData> | ErrorResponse;

export type AuthRegisterRequest = {
  email: string;
  password: string;
  name: string;
};

export type AuthRegisterResponse = SuccessResponse<{
  id?: string;
  email?: string;
  name?: string;
} | null> | ErrorResponse;

export type AuthVerifyRequest = {
  email: string;
  code: string;
};

export type AuthVerifyResponseData = {
  accessToken: string;
  refreshToken: string;
  profile: Profile | null;
  message: string;
};

export type AuthVerifyResponse = SuccessResponse<AuthVerifyResponseData> | ErrorResponse;

export type AuthTokenRequest = {
  refreshToken: string;
};

export type AuthTokenResponse = SuccessResponse<{
  accessToken: string;
  refreshToken: string;
  profile: Profile | null;
}> | ErrorResponse;

export type AuthLogoutRequest = {
  refreshToken: string;
};

export type AuthLogoutResponse = SuccessResponse<{
  message: string;
}> | ErrorResponse;

// User types
export type UserGetAllResponse = SuccessResponse<Array<{
  id: string;
  email: string;
  name: string;
  role: string;
}>> | ErrorResponse;

export type UserGetByIdResponse = SuccessResponse<{
  id: string;
  email: string;
  name: string;
  role: string;
}> | ErrorResponse;

// Password reset types
export type PasswordResetRequestRequest = {
  email: string;
};

export type PasswordResetSubmitRequest = {
  email: string;
  code: string;
  newPassword: string;
};

export type PasswordResetSubmitResponse = SuccessResponse<{
  message: string;
}> | ErrorResponse;

export type PasswordResetRequestResponse = SuccessResponse<null> | ErrorResponse;

export type PasswordResetVerifyResponse = SuccessResponse<null> | ErrorResponse;

// User profile types
export type UserProfileRequest = AuthRequest;

export type UserProfileResponse = SuccessResponse<{
  profile: Profile;
}> | ErrorResponse;

export type DepartmentResponse = SuccessResponse<Array<{
  id: number;
  name: string;
}>> | ErrorResponse;

// User department types
export type UpdateUserDepartmentRequest = {
  departmentId: number;
};

export type UpdateUserDepartmentResponse = SuccessResponse<{
  message: string;
}> | ErrorResponse;

export type AssignDepartmentManagerRequest = {
  userId: string;
  departmentId: string;
};

export type AssignDepartmentManagerResponse = SuccessResponse<{
  message: string;
}> | ErrorResponse;

// Profile creation types
export type CreateClientProfileRequest = {
  user: {
    firstName: string;
    lastName?: string;
    middleName?: string;
  };
  phone?: string;
  address?: {
    street: string;
    city: string;
    state?: string;
    postalCode?: string;
    country: string;
  };
};

export type CreateSupplierProfileRequest = {
  user: {
    firstName: string;
    lastName?: string;
    middleName?: string;
  };
  phone?: string;
  address?: {
    street: string;
    city: string;
    state?: string;
    postalCode?: string;
    country: string;
  };
};

export type CreateEmployeeProfileRequest = {
  user: {
    firstName: string;
    lastName: string;
    middleName?: string;
  };
  phone?: string;
  departmentId: number;
};

export type CreateProfileResponse = SuccessResponse<{
  profile: Profile
}> | ErrorResponse;




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
      email: string;
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
    email: string;
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

// Tracking (routes & coordinates) types
export type TrackingPointInput = {
  latitude: number;
  longitude: number;
  recordedAt: string; // ISO string
  eventType?: 'MOVE' | 'STOP';
  accuracy?: number;
  speed?: number;
  heading?: number;
  stayDurationSeconds?: number;
};

export type SaveTrackingPointsRequest = {
  points: TrackingPointInput[];
};

export type SaveTrackingPointsResponse = SuccessResponse<{
  routeId: number;
  createdPoints: number;
  routeStatus: 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
}> | ErrorResponse;

export type TrackingRouteSummary = {
  id: number;
  status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  startedAt: string;
  endedAt?: string | null;
  pointsCount: number;
};

export type GetUserRoutesQuery = {
  from?: string;
  to?: string;
  limit?: string;
  offset?: string;
};

export type GetUserRoutesResponse = SuccessResponse<{
  routes: TrackingRouteSummary[];
}> | ErrorResponse;

export type GetRoutePointsQuery = {
  from?: string;
  to?: string;
  eventType?: 'MOVE' | 'STOP';
  limit?: string;
  offset?: string;
  maxAccuracy?: string;
  maxPoints?: string;
};

export type RoutePointDto = {
  id: number;
  routeId?: number;
  latitude: number;
  longitude: number;
  recordedAt: string;
  eventType: 'MOVE' | 'STOP';
  accuracy?: number | null;
  speed?: number | null;
  heading?: number | null;
  stayDurationSeconds?: number | null;
  sequence?: number | null;
};

export type GetRoutePointsResponse = SuccessResponse<{
  route: {
    id: number;
    status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
    startedAt: string;
    endedAt?: string | null;
  };
  points: RoutePointDto[];
}> | ErrorResponse;

export type GetUserPointsQuery = {
  from?: string;
  to?: string;
  eventType?: 'MOVE' | 'STOP';
  maxAccuracy?: string;
  maxPoints?: string;
};

export type GetUserPointsResponse = SuccessResponse<{
  user: { id: number };
  points: RoutePointDto[];
}> | ErrorResponse;

export type DailyTrackingStat = {
  date: string;
  totalDistanceMeters: number;
  movingDurationSeconds: number;
  stoppedDurationSeconds: number;
  routesCount: number;
};

export type GetDailyTrackingStatsQuery = {
  from?: string;
  to?: string;
};

export type GetDailyTrackingStatsResponse = SuccessResponse<{
  stats: DailyTrackingStat[];
}> | ErrorResponse;

// Admin/manager view: routes with points for a user and period
export type GetUserRoutesWithPointsQuery = {
  from?: string;
  to?: string;
  maxAccuracy?: string;
  maxPoints?: string;
};

export type GetUserRoutesWithPointsResponse = SuccessResponse<{
  user: { id: number };
  routes: Array<{
    id: number;
    status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
    startedAt: string;
    endedAt?: string | null;
    points: RoutePointDto[];
  }>;
}> | ErrorResponse;
