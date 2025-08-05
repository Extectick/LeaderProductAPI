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
