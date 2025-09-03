import type { Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import express from 'express';

type Span = { label: string; ms: number };
type LogEntry = {
  id: number;
  ts: string; // ISO
  method: string;
  url: string;
  route?: string;
  status: number;
  durationMs: number;
  req: {
    headers: Record<string, any>;
    params: any;
    query: any;
    body: any;
  };
  res: {
    headers: Record<string, any>;
    body: any; // string|object|"Buffer(n bytes)"
    bodyTruncated: boolean;
  };
  spans?: Span[]; // optional profiling chunks
};

const MAX_ENTRIES = Number(process.env.DEBUG_REQUESTS_KEEP ?? 200);
const MAX_RES_BODY = Number(process.env.DEBUG_RES_BODY_LIMIT ?? 64 * 1024); // 64 KB
let CAPTURE_ENABLED = true;

const entries: LogEntry[] = [];
let counter = 1;

function push(entry: LogEntry) {
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
}

export function requestDebugMiddleware(req: Request, res: Response, next: NextFunction) {
  // НЕ логируем сам UI/JSON/сервисные debug-роуты
  if (req.path.startsWith('/_debug')) return next();
  if (!CAPTURE_ENABLED) return next();

  const start = process.hrtime.bigint();

  // перехватываем тело ответа
  let resBodyChunks: Buffer[] = [];
  let bodySize = 0;

  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);

  res.write = (chunk: any, encoding?: any, cb?: any) => {
    if (chunk && bodySize < MAX_RES_BODY) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding || 'utf8');
      bodySize += buf.length;
      if (bodySize <= MAX_RES_BODY) {
        resBodyChunks.push(buf);
      } else {
        const remain = MAX_RES_BODY - (bodySize - buf.length);
        if (remain > 0) resBodyChunks.push(buf.subarray(0, remain));
      }
    }
    return originalWrite(chunk, encoding, cb);
  };

  res.end = (chunk?: any, encoding?: any, cb?: any) => {
    if (chunk && bodySize < MAX_RES_BODY) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding || 'utf8');
      bodySize += buf.length;
      if (bodySize <= MAX_RES_BODY) {
        resBodyChunks.push(buf);
      } else {
        const remain = MAX_RES_BODY - (bodySize - buf.length);
        if (remain > 0) resBodyChunks.push(buf.subarray(0, remain));
      }
    }

    const end = process.hrtime.bigint();
    const durationMs = Number(end - start) / 1e6;

    const routePath =
      // @ts-ignore
      (req.route && req.route.path) ||
      // @ts-ignore
      (req.baseUrl ? `${req.baseUrl}${req.route?.path ?? ''}` : undefined);

    let resBody: any = null;
    let truncated = false;
    if (resBodyChunks.length) {
      const buf = Buffer.concat(resBodyChunks);
      truncated = bodySize > MAX_RES_BODY;
      const ct = res.getHeader('content-type')?.toString() || '';
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

    // опциональные «спаны» — если в коде где-то сделать res.locals.__spans = [{label,ms}, ...]
    const spans: Span[] | undefined = Array.isArray((res as any).locals?.__spans)
      ? (res as any).locals.__spans
      : undefined;

    const entry: LogEntry = {
      id: counter++,
      ts: new Date().toISOString(),
      method: req.method,
      url: req.originalUrl || req.url,
      route: routePath,
      status: res.statusCode,
      durationMs: Number(durationMs.toFixed(3)),
      req: {
        headers: req.headers as any,
        params: req.params,
        query: req.query,
        body: req.body,
      },
      res: {
        headers: Object.fromEntries(
          Object.entries(res.getHeaders()).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v)])
        ),
        body: resBody,
        bodyTruncated: truncated,
      },
      spans,
    };

    push(entry);
    return originalEnd(chunk as any, encoding as any, cb as any);
  };

  next();
}

function guard(req: Request): string | null {
  const token = process.env.DEBUG_DASH_TOKEN;
  if (process.env.NODE_ENV === 'production') return 'Disabled in production';
  if (process.env.DEBUG_REQUESTS !== '1') return 'DEBUG_REQUESTS=1 is required';
  if (token && req.headers['x-debug-token'] !== token) return 'Missing or invalid x-debug-token';
  return null;
}

export function requestDebugRoutes(app: import('express').Express) {
  const uiDir = path.resolve(__dirname, 'debug-ui');

  // статика (css/js)
  app.use('/_debug', express.static(uiDir, { index: false, cacheControl: false }));

  // JSON с данными
  app.get('/_debug/requests.json', (req, res) => {
    const err = guard(req);
    if (err) return res.status(403).json({ ok: false, error: err });
    res.json({ ok: true, total: entries.length, entries: [...entries].reverse() });
  });

  // capture status
  app.get('/_debug/capture/status', (req, res) => {
    const err = guard(req);
    if (err) return res.status(403).json({ ok: false, error: err });
    res.json({ ok: true, enabled: CAPTURE_ENABLED });
  });

  // enable/disable capture (?enabled=1|0)
  app.get('/_debug/capture', (req, res) => {
    const err = guard(req);
    if (err) return res.status(403).json({ ok: false, error: err });
    const enabled = String(req.query.enabled ?? '').trim();
    if (enabled === '1' || enabled.toLowerCase() === 'true') CAPTURE_ENABLED = true;
    if (enabled === '0' || enabled.toLowerCase() === 'false') CAPTURE_ENABLED = false;
    res.json({ ok: true, enabled: CAPTURE_ENABLED });
  });

  // HTML страница
  app.get('/_debug/requests', (req, res) => {
    const err = guard(req);
    if (err) return res.status(403).send(`<pre>403: ${escapeHtml(err)}</pre>`);

    try {
      const htmlPath = path.join(uiDir, 'requests.html');
      let html = fs.readFileSync(htmlPath, 'utf8');
      html = html
        .replace(/__DEBUG_TOKEN__/g, String(process.env.DEBUG_DASH_TOKEN || ''))
        .replace(/__MAX_RES_BODY__/g, String(MAX_RES_BODY))
        .replace(/__ENTRIES_COUNT__/g, String(entries.length));
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch (e: any) {
      res.status(500).send(`<pre>500: failed to load UI (${escapeHtml(e?.message || String(e))})</pre>`);
    }
  });
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
