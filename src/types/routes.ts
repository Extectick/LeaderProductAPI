
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
  message: string;
};

export type AuthVerifyResponse = SuccessResponse<AuthVerifyResponseData> | ErrorResponse;

export type AuthTokenRequest = {
  refreshToken: string;
};

export type AuthTokenResponse = SuccessResponse<{
  accessToken: string;
  refreshToken: string;
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
  description?: string;
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
