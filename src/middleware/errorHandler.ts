import { Request, Response, NextFunction } from 'express';
import { errorResponse, ErrorCodes } from '../utils/apiResponse';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) {
  console.error(err.stack);

  const anyErr = err as any;
  if (anyErr?.type === 'entity.too.large') {
    return res.status(413).json(
      errorResponse('Request body too large', ErrorCodes.VALIDATION_ERROR)
    );
  }

  if (err instanceof SyntaxError && anyErr?.status === 400 && 'body' in anyErr) {
    return res.status(400).json(
      errorResponse('Invalid JSON body', ErrorCodes.VALIDATION_ERROR)
    );
  }
  
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
