import { ErrorResponse, SuccessResponse } from '../utils/apiResponse';

export type UpdateCheckQuery = {
  platform?: string;
  versionCode?: string;
  version?: string;
  channel?: string;
  deviceId?: string;
};

export type UpdateCheckResponse = SuccessResponse<{
  updateAvailable: boolean;
  mandatory: boolean;
  latestId?: number;
  latestVersionCode?: number;
  latestVersionName?: string;
  minSupportedVersionCode?: number;
  rolloutPercent?: number;
  releaseNotes?: string | null;
  storeUrl?: string | null;
  downloadUrl?: string | null;
  fileSize?: number | null;
  checksum?: string | null;
  checksumMd5?: string | null;
}> | ErrorResponse;

export type CreateUpdateRequest = {
  platform: string;
  channel?: string;
  versionCode: number;
  versionName: string;
  minSupportedVersionCode: number;
  isMandatory?: boolean;
  rolloutPercent?: number;
  isActive?: boolean;
  releaseNotes?: string | null;
  storeUrl?: string | null;
  apkKey?: string | null;
  fileSize?: number | null;
  checksum?: string | null;
  checksumMd5?: string | null;
};

export type CreateUpdateResponse = SuccessResponse<{
  id: number;
  platform: string;
  channel: string;
  versionCode: number;
  versionName: string;
  minSupportedVersionCode: number;
  isMandatory: boolean;
  rolloutPercent: number;
  isActive: boolean;
  releaseNotes?: string | null;
  storeUrl?: string | null;
  apkKey?: string | null;
  fileSize?: number | null;
  checksum?: string | null;
  checksumMd5?: string | null;
  createdAt: string;
}> | ErrorResponse;

export type UpdateEventRequest = {
  eventType:
    | 'CHECK'
    | 'PROMPT_SHOWN'
    | 'UPDATE_CLICK'
    | 'DISMISS'
    | 'DOWNLOAD_START'
    | 'DOWNLOAD_DONE'
    | 'VERIFY_FAILED'
    | 'INSTALL_CLICK'
    | 'OTA_READY'
    | 'OTA_RELOAD';
  platform: string;
  channel?: string;
  versionCode: number;
  versionName?: string;
  deviceId?: string;
  updateId?: number;
};

export type UpdateEventResponse = SuccessResponse<{
  id: number;
}> | ErrorResponse;
