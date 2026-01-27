import type { Request, Response, NextFunction } from 'express';
import { enqueueKafkaMessage, getKafkaTopic, isKafkaEnabled } from '../lib/kafka';

const MAX_BODY = Math.max(1024, Number(process.env.KAFKA_LOG_BODY_LIMIT || 64 * 1024));
const CAPTURE_BODY = process.env.KAFKA_LOG_BODY !== '0';

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-access-token',
  'x-refresh-token',
]);

function sanitizeHeaders(headers: Record<string, any>) {
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (SENSITIVE_HEADERS.has(key.toLowerCase())) {
      out[key] = '[redacted]';
    } else {
      out[key] = value;
    }
  }
  return out;
}

function safeBody(body: any) {
  if (body == null) return null;
  if (typeof body === 'string') return body.length > MAX_BODY ? body.slice(0, MAX_BODY) : body;
  try {
    const str = JSON.stringify(body);
    if (str.length > MAX_BODY) return str.slice(0, MAX_BODY) + '…';
    return body;
  } catch {
    return String(body).slice(0, MAX_BODY);
  }
}

export function kafkaRequestLogger(req: Request, res: Response, next: NextFunction) {
  if (!isKafkaEnabled()) return next();

  const startedAt = new Date().toISOString();
  const start = process.hrtime.bigint();

  let resBodyChunks: Buffer[] = [];
  let resSize = 0;

  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);

  if (CAPTURE_BODY) {
    res.write = (chunk: any, encoding?: any, cb?: any) => {
      if (chunk && resSize < MAX_BODY) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding || 'utf8');
        resSize += buf.length;
        if (resSize <= MAX_BODY) {
          resBodyChunks.push(buf);
        } else {
          const remain = MAX_BODY - (resSize - buf.length);
          if (remain > 0) resBodyChunks.push(buf.subarray(0, remain));
        }
      }
      return originalWrite(chunk, encoding, cb);
    };

    res.end = (chunk?: any, encoding?: any, cb?: any) => {
      if (chunk && resSize < MAX_BODY) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding || 'utf8');
        resSize += buf.length;
        if (resSize <= MAX_BODY) {
          resBodyChunks.push(buf);
        } else {
          const remain = MAX_BODY - (resSize - buf.length);
          if (remain > 0) resBodyChunks.push(buf.subarray(0, remain));
        }
      }
      return finalize(chunk, encoding, cb);
    };
  } else {
    res.end = (chunk?: any, encoding?: any, cb?: any) => finalize(chunk, encoding, cb);
  }

  function finalize(chunk?: any, encoding?: any, cb?: any) {
    const end = process.hrtime.bigint();
    const durationMs = Number(end - start) / 1e6;

    const routePath =
      // @ts-ignore
      (req.route && req.route.path) ||
      // @ts-ignore
      (req.baseUrl ? `${req.baseUrl}${req.route?.path ?? ''}` : undefined);

    let resBody: any = null;
    let bodyTruncated = false;
    if (CAPTURE_BODY && resBodyChunks.length) {
      const buf = Buffer.concat(resBodyChunks);
      bodyTruncated = resSize > MAX_BODY;
      const ct = String(res.getHeader('content-type') || '');
      if (ct.includes('application/json')) {
        try {
          resBody = JSON.parse(buf.toString('utf8'));
        } catch {
          resBody = buf.toString('utf8');
        }
      } else if (ct.startsWith('text/')) {
        resBody = buf.toString('utf8');
      } else {
        resBody = `Buffer(${buf.length} bytes)`;
      }
    }

    const payload = {
      topic: getKafkaTopic(),
      ts: startedAt,
      method: req.method,
      url: req.originalUrl || req.url,
      route: routePath,
      status: res.statusCode,
      durationMs: Number(durationMs.toFixed(3)),
      ip: req.ip,
      req: {
        headers: sanitizeHeaders(req.headers as any),
        params: req.params,
        query: req.query,
        body: safeBody(req.body),
      },
      res: {
        headers: sanitizeHeaders(res.getHeaders() as any),
        body: safeBody(resBody),
        bodyTruncated,
      },
    };

    enqueueKafkaMessage(payload);
    return originalEnd(chunk as any, encoding as any, cb as any);
  }

  next();
}
