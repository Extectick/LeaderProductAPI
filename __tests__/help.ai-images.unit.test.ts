jest.mock('../src/prisma/client',()=>({__esModule:true,default:{helpMessage:{findMany:jest.fn()},helpAttachment:{findMany:jest.fn()}}}));
jest.mock('../src/modules/help/help.storage',()=>({helpBucket:'fixture-private',helpS3:{send:jest.fn()},helpStorageRequest:(work:()=>Promise<unknown>)=>work()}));
import prisma from '../src/prisma/client';
import {helpS3} from '../src/modules/help/help.storage';
import {helpAIImages, HELP_AI_IMAGES_TIMEOUT_MS} from '../src/modules/help/help.ai-images';
import sharp from 'sharp';
import {createHash} from 'node:crypto';
beforeEach(()=>jest.clearAllMocks());
afterEach(()=>jest.useRealTimers());
test('reads only owner images from the current ticket and sends stripped bounded image bytes',async()=>{
  const bytes=await sharp({create:{width:20,height:10,channels:3,background:'#fff'}}).png().toBuffer();
  (prisma.helpMessage.findMany as jest.Mock).mockResolvedValue([{attachments:[{objectKey:'private-fixture-key',size:bytes.length}]}]);
  (helpS3.send as jest.Mock).mockResolvedValue({ContentLength:bytes.length,Body:(async function*(){yield bytes;})()});
  const result=await helpAIImages(4,7,new AbortController().signal);
  expect((prisma.helpMessage.findMany as jest.Mock).mock.calls[0][0].where).toMatchObject({ticketId:4,authorId:7,attachments:{some:{kind:'IMAGE',ownerId:7}}});
  expect(result.images).toHaveLength(1);expect(result.skipped).toBe(0);
  expect(result.images[0].image_url).toMatch(/^data:image\/jpeg;base64,/);
  expect(JSON.stringify(result)).not.toContain('private-fixture-key');
});
test('oversized, missing and invalid image data produce an explicit skipped count',async()=>{
  (prisma.helpMessage.findMany as jest.Mock).mockResolvedValue([{attachments:[{objectKey:'large',size:6000000},{objectKey:'missing',size:10}]}]);
  (helpS3.send as jest.Mock).mockRejectedValue(Error('private-storage-error'));
  await expect(helpAIImages(4,7,new AbortController().signal)).resolves.toEqual({images:[],skipped:2});
  expect(helpS3.send).toHaveBeenCalledTimes(1);
});

function stalledBody() {
  return { destroy: jest.fn(), [Symbol.asyncIterator]() { return this; },
    next: jest.fn(() => new Promise<IteratorResult<Uint8Array>>(() => {})),
    return: jest.fn(async () => ({ done: true, value: undefined })) };
}
function imageCandidates(count = 1) {
  (prisma.helpMessage.findMany as jest.Mock).mockResolvedValue([{ attachments:
    Array.from({ length: count }, (_, index) => ({ objectKey: `fixture-${index}`, size: 100 })) }]);
}
test('one deadline covers the request and a body that ignores transport cancellation', async () => {
  jest.useFakeTimers(); imageCandidates(2);
  const body = stalledBody();
  (helpS3.send as jest.Mock).mockImplementationOnce(() => new Promise((_resolve, reject) => setTimeout(() => reject(Error('storage')), 6000)))
    .mockResolvedValueOnce({ ContentLength: 100, Body: body });
  const result = helpAIImages(4, 7, new AbortController().signal);
  await jest.advanceTimersByTimeAsync(6000);
  expect(body.next).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(HELP_AI_IMAGES_TIMEOUT_MS - 6000);
  await expect(result).resolves.toEqual({ images: [], skipped: 2 });
  expect(body.destroy).toHaveBeenCalled(); expect(body.return).toHaveBeenCalled();
  expect((helpS3.send as jest.Mock).mock.calls[1][1].abortSignal.aborted).toBe(true);
  expect(jest.getTimerCount()).toBe(0);
});
test('a late request response releases its body after the shared deadline', async () => {
  jest.useFakeTimers(); imageCandidates();
  let finish!: (value: unknown) => void;
  (helpS3.send as jest.Mock).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const result = helpAIImages(4, 7, new AbortController().signal);
  await jest.advanceTimersByTimeAsync(HELP_AI_IMAGES_TIMEOUT_MS);
  await expect(result).resolves.toEqual({ images: [], skipped: 1 });
  const body = stalledBody(); finish({ ContentLength: 100, Body: body });
  await Promise.resolve(); await Promise.resolve();
  expect(body.destroy).toHaveBeenCalled(); expect(body.next).not.toHaveBeenCalled();
});
test('lease loss or shutdown aborts an already accepted S3 body without producing an image', async () => {
  jest.useFakeTimers(); imageCandidates();
  const body = stalledBody(), controller = new AbortController();
  (helpS3.send as jest.Mock).mockResolvedValueOnce({ ContentLength: 100, Body: body });
  const result = helpAIImages(4, 7, controller.signal);
  const rejected = expect(result).rejects.toThrow('HELP_AI_CANCELLED');
  await jest.advanceTimersByTimeAsync(0);
  expect(body.next).toHaveBeenCalled(); controller.abort();
  await rejected; expect(body.destroy).toHaveBeenCalled(); expect(jest.getTimerCount()).toBe(0);
});
test.each([6000000, undefined])('skipped response length %s releases its unread body', async contentLength => {
  imageCandidates(); const body = stalledBody();
  (helpS3.send as jest.Mock).mockResolvedValueOnce({ ContentLength: contentLength, Body: body });
  await expect(helpAIImages(4, 7, new AbortController().signal)).resolves.toEqual({ images: [], skipped: 1 });
  expect(body.destroy).toHaveBeenCalled(); expect(body.next).not.toHaveBeenCalled();
});

const selectedId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const secondId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
async function selectedImage(id=selectedId) {
  const bytes=await sharp({create:{width:12,height:8,channels:3,background:'#abc'}}).png().toBuffer();
  const file={id,objectKey:'private-old-image-'+id,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  return {bytes,file};
}
function sendBytes(bytes:Buffer) {
  return {ContentLength:bytes.length,Body:(async function*(){yield bytes;})()};
}
test('an explicitly selected old image uses the same ticket, owner and snapshot for initial and final reads',async()=>{
  const {bytes,file}=await selectedImage();
  (prisma.helpMessage.findMany as jest.Mock).mockResolvedValue([{attachments:[file]}]);
  (prisma.helpAttachment.findMany as jest.Mock).mockResolvedValue([file]);
  (helpS3.send as jest.Mock).mockResolvedValue(sendBytes(bytes));
  const result=await helpAIImages(4,7,new AbortController().signal,{attachmentIds:[selectedId],throughSequence:22});
  expect(result.images).toHaveLength(1);expect(result.skipped).toBe(0);
  expect((prisma.helpMessage.findMany as jest.Mock).mock.calls[0][0]).toMatchObject({where:{ticketId:4,authorId:7,kind:'TEXT',sequence:{lte:22},ticket:{ownerId:7},attachments:{some:{id:{in:[selectedId]},kind:'IMAGE',ownerId:7}}},select:{attachments:{where:{id:{in:[selectedId]},kind:'IMAGE',ownerId:7},select:{id:true,sha256:true}}}});
  expect(prisma.helpAttachment.findMany).toHaveBeenCalledWith({where:{id:{in:[selectedId]},ownerId:7,kind:'IMAGE',message:{ticketId:4,authorId:7,kind:'TEXT',sequence:{lte:22},ticket:{ownerId:7}}},select:{id:true,objectKey:true,size:true,sha256:true}});
  expect(JSON.stringify(result)).not.toContain(file.objectKey);expect(JSON.stringify(result)).not.toContain(file.sha256);
});

test.each([
  {attachmentIds:[],throughSequence:22},
  {attachmentIds:[selectedId,secondId,'cccccccc-cccc-4ccc-8ccc-cccccccccccc'],throughSequence:22},
  {attachmentIds:[selectedId,selectedId],throughSequence:22},
  {attachmentIds:[selectedId,selectedId.toUpperCase()],throughSequence:22},
  {attachmentIds:['invalid'],throughSequence:22},
  {attachmentIds:[selectedId],throughSequence:0},
])('invalid selection never falls back to latest images: %j',async selection=>{
  await expect(helpAIImages(4,7,new AbortController().signal,selection)).rejects.toThrow('HELP_AI_IMAGE_SELECTION_INVALID');
  expect(prisma.helpMessage.findMany).not.toHaveBeenCalled();expect(helpS3.send).not.toHaveBeenCalled();
});

test('a missing or out-of-scope selected image is reported skipped without requesting storage',async()=>{
  (prisma.helpMessage.findMany as jest.Mock).mockResolvedValue([]);
  await expect(helpAIImages(4,7,new AbortController().signal,{attachmentIds:[selectedId],throughSequence:22})).resolves.toEqual({images:[],skipped:1});
  expect(helpS3.send).not.toHaveBeenCalled();expect(prisma.helpAttachment.findMany).not.toHaveBeenCalled();
});

test.each(['hash','size'])('selected image bytes must match stored %s before conversion',async mismatch=>{
  const {bytes,file}=await selectedImage();
  (prisma.helpMessage.findMany as jest.Mock).mockResolvedValue([{attachments:[{...file,...(mismatch==='hash'?{sha256:'0'.repeat(64)}:{size:file.size+1})}]}]);
  (helpS3.send as jest.Mock).mockResolvedValue(sendBytes(bytes));
  await expect(helpAIImages(4,7,new AbortController().signal,{attachmentIds:[selectedId],throughSequence:22})).resolves.toEqual({images:[],skipped:1});
  expect(prisma.helpAttachment.findMany).not.toHaveBeenCalled();
});

test.each(['deleted','objectKey','size','sha256'])('a selected attachment %s after I/O is not returned',async change=>{
  const {bytes,file}=await selectedImage();
  (prisma.helpMessage.findMany as jest.Mock).mockResolvedValue([{attachments:[file]}]);
  const changed=change==='deleted'?[]:[{...file,...(change==='objectKey'?{objectKey:'other-private-key'}:change==='size'?{size:file.size+1}:{sha256:'0'.repeat(64)})}];
  (prisma.helpAttachment.findMany as jest.Mock).mockResolvedValue(changed);
  (helpS3.send as jest.Mock).mockResolvedValue(sendBytes(bytes));
  await expect(helpAIImages(4,7,new AbortController().signal,{attachmentIds:[selectedId],throughSequence:22})).resolves.toEqual({images:[],skipped:1});
});

test('two selected images are returned in requested order and revalidated only after both I/O operations',async()=>{
  const first=await selectedImage(selectedId),second=await selectedImage(secondId);
  (prisma.helpMessage.findMany as jest.Mock).mockResolvedValue([{attachments:[second.file]},{attachments:[first.file]}]);
  (helpS3.send as jest.Mock).mockImplementation(async(command:any)=>{
    expect(prisma.helpAttachment.findMany).not.toHaveBeenCalled();
    return sendBytes(command.input.Key===first.file.objectKey?first.bytes:second.bytes);
  });
  (prisma.helpAttachment.findMany as jest.Mock).mockResolvedValue([first.file,second.file]);
  const result=await helpAIImages(4,7,new AbortController().signal,{attachmentIds:[selectedId,secondId],throughSequence:22});
  expect(result.images).toHaveLength(2);expect(result.skipped).toBe(0);
  expect((helpS3.send as jest.Mock).mock.calls.map(call=>call[0].input.Key)).toEqual([first.file.objectKey,second.file.objectKey]);
});

test('an image deleted while another is read is withheld by the final attachment snapshot',async()=>{
  const first=await selectedImage(selectedId),second=await selectedImage(secondId);
  (prisma.helpMessage.findMany as jest.Mock).mockResolvedValue([{attachments:[first.file,second.file]}]);
  (helpS3.send as jest.Mock).mockImplementation(async()=>sendBytes(first.bytes));
  (prisma.helpAttachment.findMany as jest.Mock).mockResolvedValue([second.file]);
  const result=await helpAIImages(4,7,new AbortController().signal,{attachmentIds:[selectedId,secondId],throughSequence:22});
  expect(result.images).toHaveLength(1);expect(result.skipped).toBe(1);
});

test('cancellation during the final attachment re-read prevents late selected images',async()=>{
  const {bytes,file}=await selectedImage();const controller=new AbortController();
  (prisma.helpMessage.findMany as jest.Mock).mockResolvedValue([{attachments:[file]}]);
  (helpS3.send as jest.Mock).mockResolvedValue(sendBytes(bytes));
  (prisma.helpAttachment.findMany as jest.Mock).mockImplementation(async()=>{controller.abort();return[file]});
  await expect(helpAIImages(4,7,controller.signal,{attachmentIds:[selectedId],throughSequence:22})).rejects.toThrow('HELP_AI_CANCELLED');
});

test('a stalled selected image uses the existing shared deadline and releases its body',async()=>{
  const {file}=await selectedImage();jest.useFakeTimers();
  (prisma.helpMessage.findMany as jest.Mock).mockResolvedValue([{attachments:[file]}]);
  const body=stalledBody();(helpS3.send as jest.Mock).mockResolvedValue({ContentLength:file.size,Body:body});
  const result=helpAIImages(4,7,new AbortController().signal,{attachmentIds:[selectedId],throughSequence:22});
  await jest.advanceTimersByTimeAsync(HELP_AI_IMAGES_TIMEOUT_MS);
  await expect(result).resolves.toEqual({images:[],skipped:1});expect(body.destroy).toHaveBeenCalled();
  expect(prisma.helpAttachment.findMany).not.toHaveBeenCalled();expect(jest.getTimerCount()).toBe(0);
});
