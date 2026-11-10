jest.mock('../src/modules/help/help.storage', () => ({ helpBucket: 'private-test', ensureHelpBucket: jest.fn(async () => {}),
  helpS3: { send: jest.fn() }, helpStorageRequest: (work: () => Promise<unknown>) => work() }));
import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { helpS3 } from '../src/modules/help/help.storage';
import { prepareHelpAIFiles, prepareHelpOfficeFiles, prepareHelpHtmlFiles, cleanupHelpAIFiles } from '../src/modules/help/help.ai-files';
import { claimsSavedHelpAIFile, requestsHelpAIFile, validateHelpAIFiles } from '../src/modules/help/help.ai-file-contract';

beforeEach(() => { jest.clearAllMocks(); (helpS3.send as jest.Mock).mockResolvedValue({}); });
test.each(['test.txt', 'отчёт.csv', 'notes.md', 'a.md', 'settings.json'])('validates bounded UTF-8 %s and preserves the actual bytes', name => {
  const content = name.endsWith('.json') ? '{"строка":"пример"}' : 'Тестовый файл\nПример';
  const [file] = validateHelpAIFiles([{ name, content }]);
  expect(file.bytes.toString('utf8')).toBe(content);
  expect(file.mimeType).toMatch(/^(?:text\/|application\/json)/);
});
test.each([
  { name: '../secret.txt', content: 'data' }, { name: 'folder/data.txt', content: 'data' },
  { name: 'script.exe', content: 'data' }, { name: 'CON.txt', content: 'data' },
  { name: 'data.json', content: 'invalid JSON' }, { name: 'data.txt', content: '\u0000' },
  { name: 'data.txt', content: '\ud800' }, { name: 'data.txt', content: '😀'.repeat(9000) },
])('rejects invalid generated file metadata/content', file => { expect(() => validateHelpAIFiles([file])).toThrow(); });
test('rejects URL-only files, duplicate names and oversized aggregate output', () => {
  expect(() => validateHelpAIFiles([{ name: 'test.txt', url: 'https://files.example.test/x' }])).toThrow();
  expect(() => validateHelpAIFiles([{ name: 'same.txt', content: 'a' }, { name: 'SAME.txt', content: 'b' }])).toThrow();
  expect(() => validateHelpAIFiles([{ name: 'a.txt', content: 'я'.repeat(15000) }, { name: 'b.txt', content: 'я'.repeat(15000) }])).toThrow();
});
test('ticket 32 is an actual file request; diagnostics about an existing file are not', () => {
  for (const text of ['Пришли тестовый txt файл', 'У тебя щас есть возможность прислать мне .txt?']) {
    expect(requestsHelpAIFile([{ role: 'user', text }])).toBe(true);
  }
  for (const text of ['Как создать txt файл?', 'Не нужно присылать txt файл', 'Мой txt файл не открывается']) {
    expect(requestsHelpAIFile([{ role: 'user', text }])).toBe(false);
  }
  expect(claimsSavedHelpAIFile('Вот готовый тестовый файл test.txt.')).toBe(true);
  expect(claimsSavedHelpAIFile('Проверю прикреплённое изображение.')).toBe(false);
});
test('uploads real private objects with content hashes and attempt-owned keys', async () => {
  const files = [{ name: 'test.txt', content: 'Тестовый файл\n' }];
  const first = await prepareHelpAIFiles({ ticketId: 32, runId: 'run-32' }, files, new AbortController().signal);
  const second = await prepareHelpAIFiles({ ticketId: 32, runId: 'run-32' }, files, new AbortController().signal);
  expect(first[0].objectKey).not.toBe(second[0].objectKey);
  const command = (helpS3.send as jest.Mock).mock.calls[0][0] as PutObjectCommand;
  expect(command).toBeInstanceOf(PutObjectCommand);
  expect(command.input).toMatchObject({ Bucket: 'private-test', CacheControl: 'private, no-store', ContentType: 'text/plain; charset=utf-8', Body: Buffer.from(files[0].content) });
  expect(first[0]).toMatchObject({ kind: 'FILE', name: 'test.txt', size: Buffer.byteLength(files[0].content), sha256: createHash('sha256').update(files[0].content).digest('hex') });
  await cleanupHelpAIFiles(first);
  const deleted = (helpS3.send as jest.Mock).mock.calls.map(([command]) => command).filter(command => command instanceof DeleteObjectCommand);
  expect(deleted.map(command => command.input.Key)).toEqual([first[0].objectKey]);
});
test('a partially failed upload removes every allocated object and returns no attachments', async () => {
  let puts = 0;
  (helpS3.send as jest.Mock).mockImplementation(async command => { if (command instanceof PutObjectCommand && ++puts === 2) throw new Error('upload failed'); return {}; });
  await expect(prepareHelpAIFiles({ ticketId: 32, runId: 'run-32' }, [{ name: 'a.txt', content: 'a' }, { name: 'b.txt', content: 'b' }], new AbortController().signal)).rejects.toThrow();
  expect((helpS3.send as jest.Mock).mock.calls.filter(([command]) => command instanceof DeleteObjectCommand)).toHaveLength(2);
});
test('a PUT completing after the upload deadline is deleted again', async () => {
  jest.useFakeTimers();
  let finish!: () => void;
  (helpS3.send as jest.Mock).mockImplementation(command => command instanceof PutObjectCommand ? new Promise(resolve => { finish = () => resolve({}); }) : Promise.resolve({}));
  try {
    const work = prepareHelpAIFiles({ ticketId: 32, runId: 'run-32' }, [{ name: 'test.txt', content: 'test' }], new AbortController().signal).catch(() => null);
    await jest.advanceTimersByTimeAsync(10001);
    expect(await work).toBeNull();
    const before = (helpS3.send as jest.Mock).mock.calls.filter(([command]) => command instanceof DeleteObjectCommand).length;
    finish(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect((helpS3.send as jest.Mock).mock.calls.filter(([command]) => command instanceof DeleteObjectCommand).length).toBeGreaterThan(before);
  } finally { jest.useRealTimers(); }
});

test('Office binaries retain their MIME, hash and existing attachment position without a text charset',async()=>{
 const file={name:'Отчёт.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',kind:'FILE' as const,bytes:Buffer.from([80,75,3,4,0,1,2,3])};
 const saved=await prepareHelpOfficeFiles({ticketId:32,runId:'office'},[file],new AbortController().signal,1);
 expect(saved[0]).toMatchObject({name:file.name,kind:'FILE',position:1,size:8,sha256:createHash('sha256').update(file.bytes).digest('hex')});
 const commands=(helpS3.send as jest.Mock).mock.calls.map(([command])=>command).filter(command=>command instanceof PutObjectCommand);
 expect(commands[0].input.ContentType).toBe(file.mimeType);expect(commands[0].input.Body).toEqual(file.bytes);expect(commands[0].input.CacheControl).toBe('private, no-store');
});

test('an eight-card batch uploads all private files with stable positions after other attachments',async()=>{
 const {createHelpHtmlArtifact,helpHtmlFile}=await import('../src/modules/help/help.html');
 const files=Array.from({length:8},(_,index)=>helpHtmlFile(createHelpHtmlArtifact({title:'Карточка '+index,description:'Синтетический пример',compact:{html:'<p>Карточка '+index+'</p>',css:''}})));
 const prepared=await prepareHelpHtmlFiles({ticketId:83,runId:'synthetic'},files,new AbortController().signal,2);
 expect(prepared).toHaveLength(8);expect(prepared.map(file=>file.position)).toEqual([2,3,4,5,6,7,8,9]);
 for(const [index,file] of prepared.entries())expect(file).toMatchObject({name:files[index].name,sha256:createHash('sha256').update(files[index].bytes).digest('hex'),mimeType:'application/vnd.leaderproduct.help-html+json'});
 expect((helpS3.send as jest.Mock).mock.calls.map(([command])=>command.input.CacheControl)).toEqual(Array(8).fill('private, no-store'));
});
test('HTML aggregate over-budget fails before any upload begins',async()=>{
 const {createHelpHtmlArtifact,helpHtmlFile}=await import('../src/modules/help/help.html');
 const files=Array.from({length:13},(_,index)=>helpHtmlFile(createHelpHtmlArtifact({title:'Пример '+index,description:'Условный пример',compact:{html:'<p>Пример</p>',css:''}})));
 await expect(prepareHelpHtmlFiles({ticketId:83,runId:'synthetic'},files,new AbortController().signal)).rejects.toThrow('HELP_HTML_LIMIT');
 expect(helpS3.send).not.toHaveBeenCalled();
});

test.each([
 ['inline',{html:'<section style="height:180px">Example</section>',css:''},{width:null,height:180}],
 ['fractional',{html:'<section style="height:180.5px">Example</section>',css:''},{width:null,height:181}],
 ['css',{html:'<section class="card">Example</section>',css:'.card{height:240px}'},{width:null,height:240}],
 ['square',{html:'<section>Example</section>',css:'section{height:100%}'},{width:1,height:1}],
 ['full-only',undefined,{width:null,height:48}],
] as const)('HTML %s reserves metadata before publication without changing object bytes',async(_name,compact,geometry)=>{
 const {createHelpHtmlArtifact,helpHtmlFile}=await import('../src/modules/help/help.html');
 const file=helpHtmlFile(createHelpHtmlArtifact({title:'Example',description:'Synthetic fixture',...(compact?{compact}:{full:{html:'<p>Full page</p>',css:''}})}));
 const prepared=await prepareHelpHtmlFiles({ticketId:50,runId:'geometry'},[file],new AbortController().signal);
 expect(prepared[0]).toMatchObject(geometry);
 expect(prepared[0].sha256).toBe(createHash('sha256').update(file.bytes).digest('hex'));
 const command=(helpS3.send as jest.Mock).mock.calls.find(([c])=>c instanceof PutObjectCommand)[0];
 expect(command.input.Body).toEqual(file.bytes);
});
