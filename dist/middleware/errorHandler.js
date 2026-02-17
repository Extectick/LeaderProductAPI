"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.errorHandler = errorHandler;
exports.notFoundHandler = notFoundHandler;
const apiResponse_1 = require("../utils/apiResponse");
function errorHandler(err, req, res, next) {
    console.error(err.stack);
    const anyErr = err;
    if (anyErr?.type === 'entity.too.large') {
        return res.status(413).json((0, apiResponse_1.errorResponse)('Request body too large', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
    }
    if (err instanceof SyntaxError && anyErr?.status === 400 && 'body' in anyErr) {
        return res.status(400).json((0, apiResponse_1.errorResponse)('Invalid JSON body', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
    }
    const response = (0, apiResponse_1.errorResponse)('Internal server error', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? err.stack : undefined);
    res.status(500).json(response);
}
function notFoundHandler(req, res, next) {
    const response = (0, apiResponse_1.errorResponse)('Resource not found', apiResponse_1.ErrorCodes.NOT_FOUND);
    res.status(404).json(response);
}
