"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ErrorCodes = void 0;
exports.successResponse = successResponse;
exports.errorResponse = errorResponse;
var ErrorCodes;
(function (ErrorCodes) {
    ErrorCodes["VALIDATION_ERROR"] = "VALIDATION_ERROR";
    ErrorCodes["NOT_FOUND"] = "NOT_FOUND";
    ErrorCodes["UNAUTHORIZED"] = "UNAUTHORIZED";
    ErrorCodes["FORBIDDEN"] = "FORBIDDEN";
    ErrorCodes["CONFLICT"] = "CONFLICT";
    ErrorCodes["INTERNAL_ERROR"] = "INTERNAL_ERROR";
    ErrorCodes["TOO_MANY_REQUESTS"] = "TOO_MANY_REQUESTS";
    ErrorCodes["TOKEN_EXPIRED"] = "TOKEN_EXPIRED";
    ErrorCodes["REFRESH_TOKEN_INVALID"] = "REFRESH_TOKEN_INVALID";
    ErrorCodes["REFRESH_TOKEN_ROTATED"] = "REFRESH_TOKEN_ROTATED";
    ErrorCodes["DEVICE_SESSION_REVOKED"] = "DEVICE_SESSION_REVOKED";
    ErrorCodes["SERVICE_ACCESS_DENIED"] = "SERVICE_ACCESS_DENIED";
    ErrorCodes["TRACKING_SESSION_NOT_FOUND"] = "TRACKING_SESSION_NOT_FOUND";
})(ErrorCodes || (exports.ErrorCodes = ErrorCodes = {}));
function successResponse(data, message = 'Success', meta) {
    return { ok: true, message, data, meta };
}
function errorResponse(message, code, details) {
    return {
        ok: false,
        message,
        error: { code, details }
    };
}
