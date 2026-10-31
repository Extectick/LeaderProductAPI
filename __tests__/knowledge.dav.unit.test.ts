import { KnowledgeDav, parseDav, boundedBody } from '../src/modules/knowledge/knowledge.dav';
import { chunkKnowledgeText } from '../src/modules/knowledge/knowledge.extract';
import { documentSection, supportedExtension } from '../src/modules/knowledge/knowledge.config';

const config = { key: 'knowledge-test', name: 'test', fingerprint: 'test', url: 'https://cloud.example.org', user: 'reader', password: 'test', root: 'База знаний' };
const base = new URL(config.url + '/remote.php/dav/files/reader/' + encodeURIComponent(config.root) + '/');
const row = (path: string, id: number, directory = false, permission = 'MG') => `<d:response><d:href>${base.pathname}${path.split('/').map(encodeURIComponent).join('/')}</d:href><d:propstat><d:prop><oc:fileid>${id}</oc:fileid><oc:permissions>${permission}</oc:permissions><d:getetag>&quot;revision-${id}&quot;</d:getetag><d:getcontentlength>10</d:getcontentlength><d:resourcetype>${directory ? '<d:collection/>' : ''}</d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop><nc:optional/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>`;
const xml = (...rows: string[]) => `<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">${rows.join('')}</d:multistatus>`;

test('read-only Nextcloud MG permissions are readable; absent optional properties are normal', () => {
  const result = parseDav(xml(row('', 1, true), row('Инструкция & пример.md', 2)), base, '', 1);
  expect(result[1]).toMatchObject({ remoteId: '2', path: 'Инструкция & пример.md', etag: '"revision-2"', size: 10n });
  expect(result[0].directory).toBe(true);
});
test('partial access, malformed XML and cross-root hrefs abort the snapshot', () => {
  expect(() => parseDav(xml(row('', 1, true), row('hidden.md', 2, false, 'M')), base, '', 1)).toThrow('DAV_PARTIAL_SCAN');
  expect(() => parseDav('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>' + xml(row('', 1, true)), base, '', 1)).toThrow('DAV_INVALID_XML');
  expect(() => parseDav(xml(row('', 1, true).replace(base.pathname, '/other/')), base, '', 1)).toThrow('DAV_OUTSIDE_ROOT');
  expect(() => parseDav(xml(row('', 1, true), row('folder/nested.md', 2)), base, '', 1)).toThrow('DAV_INVALID_DEPTH');
});
test('conditional downloads never accept changed bytes and never follow redirects', async () => {
  const fetcher = jest.fn().mockResolvedValue(new Response('changed', { status: 412 }));
  const client = new KnowledgeDav(config, fetcher);
  await expect(client.download({ remoteId:'2',path:'Материалы компании/file.md',etag:'"v1"',size:5n,mimeType:'text/plain',directory:false })).rejects.toThrow('DAV_CHANGED');
  expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect:'error',headers:{'If-Match':'"v1"'} });
});
test('a complete scan must include the requested folder and unique remote identities', async () => {
  const client = new KnowledgeDav(config, jest.fn().mockResolvedValue(new Response(xml(row('',1,true),row('a.md',2),row('b.md',2)), { status:207 })));
  await expect(client.walk(async()=>{})).rejects.toThrow('DAV_DUPLICATE_IDENTITY');
  expect(()=>parseDav(xml(row('a.md',2)),base,'',1)).toThrow('DAV_PARTIAL_SCAN');
});
test('response limits cover streamed bodies without a Content-Length', async () => {
  await expect(boundedBody(new Response('123456'),5)).rejects.toThrow('DOCUMENT_TOO_LARGE');
});
test('archive and AI drafts cannot be classified as company sources by a similar prefix', () => {
  expect(documentSection('Архив/Материалы компании/a.md')).toBe('ARCHIVE');
  expect(documentSection('Материалы компании старые/a.md')).toBe('OTHER');
  expect(documentSection('Рабочая область ИИ/На проверке/a.md')).toBe('AI_WORKSPACE');
  expect(supportedExtension('manual.DOCX')).toBe('docx');
  expect(supportedExtension('payload.exe')).toBeNull();
});
test('chunking retains the tail and useful overlap without splitting surrogate pairs', () => {
  const text=('Принтер 🖨️: проверьте кабель и бумагу.\n').repeat(100)+'Последняя строка 999';
  const chunks=chunkKnowledgeText(text,500,100);
  expect(chunks.length).toBeGreaterThan(3);
  expect(chunks[chunks.length - 1]).toContain('Последняя строка 999');
  expect(chunks.every(x=>x.length<=500&&!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(x))).toBe(true);
});
