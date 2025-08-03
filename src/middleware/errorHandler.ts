import { Request, Response, NextFunction } from 'express';
import { errorResponse, ErrorCodes } from '../utils/apiResponse';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) {
  console.error(err.stack);
  
  const response = errorResponse(
    'Internal server error',
    ErrorCodes.INTERNAL_ERROR,
    process.env.NODE_ENV === 'development' ? err.stack : undefined
  );

  res.status(500).json(response);
}

export function notFoundHandler(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const response = errorResponse(
    'Resource not found',
    ErrorCodes.NOT_FOUND
  );
  res.status(404).json(response);
}
