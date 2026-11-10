import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { KnowledgeConfig, KnowledgeError, MAX_FILE_BYTES, MAX_SCAN_ENTRIES, MAX_SCAN_FOLDERS, knowledgePathAllowed } from './knowledge.config';

export type DavEntry = { remoteId: string; path: string; etag: string; size: bigint; mimeType: string; directory: boolean };
const propfind = `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><d:resourcetype/><d:getetag/><d:getcontentlength/><d:getcontenttype/><oc:fileid/><oc:permissions/></d:prop></d:propfind>`;
const array = (value: any): any[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

export async function boundedBody(response: Response, limit: number): Promise<Buffer> {
  if (Number(response.headers.get('content-length') || 0) > limit) {
    await response.body?.cancel(); throw new KnowledgeError(413, 'DOCUMENT_TOO_LARGE');
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(), parts: Buffer[] = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new KnowledgeError(413, 'DOCUMENT_TOO_LARGE'); }
      parts.push(Buffer.from(value));
    }
    return Buffer.concat(parts, size);
  } finally { reader.releaseLock(); }
}

export function parseDav(xml: string, base: URL, requestedPath: string, depth: 0 | 1): DavEntry[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new KnowledgeError(502, 'DAV_INVALID_XML');
  const data = new XMLParser({ removeNSPrefix: true, ignoreAttributes: true, parseTagValue: false,
    processEntities: true, trimValues: false }).parse(xml);
  const rows = array(data?.multistatus?.response);
  if (!rows.length) throw new KnowledgeError(502, 'DAV_EMPTY_RESPONSE');
  const basePath = decodeURIComponent(base.pathname).replace(/\/$/, '');
  const entries: DavEntry[] = [];
  for (const row of rows) {
    if (typeof row.href !== 'string') throw new KnowledgeError(502, 'DAV_INVALID_HREF');
    const href = new URL(row.href, base);
    let decoded: string;
    try { decoded = decodeURIComponent(href.pathname).replace(/\/$/, ''); }
    catch { throw new KnowledgeError(502, 'DAV_INVALID_HREF'); }
    if (href.origin !== base.origin || href.search || href.hash ||
        !(decoded === basePath || decoded.startsWith(basePath + '/'))) throw new KnowledgeError(502, 'DAV_OUTSIDE_ROOT');
    const path = decoded.slice(basePath.length).replace(/^\//, '');
    if (/[\\\x00-\x1f]/.test(path) || path.length > 2000 || path.split('/').some(x => x === '..' || x === '.')) throw new KnowledgeError(502, 'DAV_INVALID_PATH');
    const isSelf = path === requestedPath;
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (!isSelf && (depth === 0 || parent !== requestedPath)) throw new KnowledgeError(502, 'DAV_INVALID_DEPTH');
    if (row.status && !/ 200(?: |$)/.test(row.status)) throw new KnowledgeError(502, 'DAV_PARTIAL_SCAN');
    const stats = array(row.propstat);
    const prop = Object.assign({}, ...stats.filter(x => / 200(?: |$)/.test(x.status || '')).map(x => x.prop));
    // Nextcloud G means readable; R means shareable, and is absent on the reader mount.
    if (!/^\d{1,30}$/.test(String(prop.fileid || '')) || typeof prop.getetag !== 'string' || !prop.getetag || !String(prop.permissions || '').includes('G')) throw new KnowledgeError(502, 'DAV_PARTIAL_SCAN');
    const directory = prop.resourcetype != null && typeof prop.resourcetype === 'object' && 'collection' in prop.resourcetype;
    const bytes = String(prop.getcontentlength || '0');
    if (!/^\d+$/.test(bytes) || bytes.length > 18) throw new KnowledgeError(502, 'DAV_INVALID_SIZE');
    entries.push({ remoteId: String(prop.fileid), path, etag: prop.getetag, size: BigInt(bytes),
      mimeType: typeof prop.getcontenttype === 'string' ? prop.getcontenttype : '', directory });
  }
  if (!entries.some(x => x.path === requestedPath)) throw new KnowledgeError(502, 'DAV_PARTIAL_SCAN');
  return entries;
}

export class KnowledgeDav {
  private base: URL;
  constructor(private config: KnowledgeConfig, private fetcher: typeof fetch = fetch) {
    this.base = new URL(`${config.url}/remote.php/dav/files/${encodeURIComponent(config.user)}/${encodePath(config.root)}/`);
  }
  private async request(path: string, method: string, headers: Record<string, string> = {}, body?: string) {
    if (path.startsWith('/') || path.split('/').some(x => x === '..' || x === '.') || /[\\\x00-\x1f]/.test(path)) throw new KnowledgeError(400, 'DAV_INVALID_PATH');
    // Guard direct reads as well as traversal: an old queued job must not fetch
    // a section excluded by the current environment's ingestion policy.
    if ((path || method !== 'PROPFIND') && !knowledgePathAllowed(this.config, path)) throw new KnowledgeError(403, 'EXCLUDED_SECTION');
    let response: Response;
    try {
      response = await this.fetcher(new URL(encodePath(path), this.base), { method, body, redirect: 'error',
        headers: { Authorization: 'Basic ' + Buffer.from(`${this.config.user}:${this.config.password}`).toString('base64'), ...headers },
        signal: AbortSignal.timeout(25000) });
    } catch { throw new KnowledgeError(503, 'DAV_UNAVAILABLE'); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new KnowledgeError(response.status, ({ 401: 'DAV_UNAUTHORIZED', 403: 'DAV_FORBIDDEN', 404: 'DAV_NOT_FOUND', 412: 'DAV_CHANGED' } as Record<number,string>)[response.status] || 'DAV_REQUEST_FAILED');
    }
    return response;
  }
  async list(path = '', depth: 0 | 1 = 1): Promise<DavEntry[]> {
    const response = await this.request(path, 'PROPFIND', { Depth: String(depth), 'Content-Type': 'application/xml; charset=utf-8' }, propfind);
    if (response.status !== 207) { await response.body?.cancel(); throw new KnowledgeError(502, 'DAV_INVALID_STATUS'); }
    return parseDav((await boundedBody(response, 4 * 1024 * 1024)).toString('utf8'), this.base, path, depth);
  }
  async stat(path: string) { return (await this.list(path, 0))[0]; }
  async download(entry: DavEntry): Promise<Buffer> {
    if (entry.size > BigInt(MAX_FILE_BYTES)) throw new KnowledgeError(413, 'DOCUMENT_TOO_LARGE');
    const response = await this.request(entry.path, 'GET', { 'If-Match': entry.etag });
    if (response.headers.get('etag') && response.headers.get('etag') !== entry.etag) {
      await response.body?.cancel(); throw new KnowledgeError(409, 'DAV_CHANGED');
    }
    return boundedBody(response, MAX_FILE_BYTES);
  }
  async walk(heartbeat: () => Promise<void>): Promise<DavEntry[]> {
    const queue = [''], files: DavEntry[] = [], identities = new Set<string>(), paths = new Set<string>();
    let visited = 0;
    while (queue.length) {
      await heartbeat();
      const folder = queue.shift()!;
      if (++visited > MAX_SCAN_FOLDERS) throw new KnowledgeError(413, 'SOURCE_TOO_LARGE');
      for (const item of await this.list(folder)) {
        if (item.path === folder) continue;
        if (paths.has(item.path) || identities.has(item.remoteId)) throw new KnowledgeError(502, 'DAV_DUPLICATE_IDENTITY');
        paths.add(item.path); identities.add(item.remoteId);
        if (paths.size > MAX_SCAN_ENTRIES) throw new KnowledgeError(413, 'SOURCE_TOO_LARGE');
        if (item.path.split('/').some(part => part.startsWith('.') || part.startsWith('~$'))) continue;
        // Prune before enqueuing folders, so excluded subtrees are never read.
        // A completed scan applies the normal missing-document tombstones.
        if (!knowledgePathAllowed(this.config, item.path)) continue;
        if (item.directory) queue.push(item.path); else files.push(item);
      }
    }
    return files;
  }
}
