jest.mock('../src/prisma/client',()=>({__esModule:true,default:{helpAttachment:{findUnique:jest.fn()}}}));
jest.mock('../src/modules/help/help.service',()=>({
  HelpError:class extends Error{constructor(public status:number,public code:string,message:string){super(message);}},
  helpActor:jest.fn(),requireHelpTicket:jest.fn(),
}));
jest.mock('../src/modules/help/help.ai-audio',()=>({helpAIAudio:jest.fn()}));
import prisma from '../src/prisma/client';
import {helpActor,requireHelpTicket} from '../src/modules/help/help.service';
import {helpAIAudio} from '../src/modules/help/help.ai-audio';
import {helpAttachmentTranscript} from '../src/modules/help/help.audio-transcript';
const id='11111111-1111-4111-8111-111111111111';
const actor={userId:10,canManage:false};
const file={id,ownerId:10,kind:'AUDIO',message:{ticketId:87,sequence:3,authorId:10,kind:'TEXT'}};
const signal=new AbortController().signal;
let validate:()=>Promise<void>;
beforeEach(()=>{
 jest.clearAllMocks();
 (prisma.helpAttachment.findUnique as jest.Mock).mockResolvedValue(file);
 (helpActor as jest.Mock).mockResolvedValue(actor);
 (requireHelpTicket as jest.Mock).mockResolvedValue({id:87,ownerId:10});
 (helpAIAudio as jest.Mock).mockImplementation((_ticket,_owner,_sequence,check)=>{
  validate=check;return{read:async()=>{await check();return{attachmentId:id,status:'transcribed',text:'saved'};},transcribe:async()=>{await check();return{attachmentId:id,status:'transcribed',text:'new'};}};
 });
});
test('GET reads an authorized saved transcript without recognition',async()=>{
 expect(await helpAttachmentTranscript(id,actor,false,signal)).toMatchObject({text:'saved'});
 expect(helpAIAudio).toHaveBeenCalledWith(87,10,3,expect.any(Function),expect.any(Function),undefined,10);
 expect(helpActor).toHaveBeenCalledWith(10);
});
test('unbound/foreign message author is never transcribed',async()=>{
 for(const value of [{...file,message:null},{...file,message:{...file.message,authorId:20}},{...file,kind:'FILE'}]){
  (prisma.helpAttachment.findUnique as jest.Mock).mockResolvedValue(value);
  await expect(helpAttachmentTranscript(id,actor,true,signal)).rejects.toMatchObject({status:404});
 }
 expect(helpAIAudio).not.toHaveBeenCalled();
});
test('ticket access denial never starts recognition',async()=>{
 (requireHelpTicket as jest.Mock).mockRejectedValue(new Error('denied'));
 await expect(helpAttachmentTranscript(id,actor,true,signal)).rejects.toThrow('denied');
 expect(helpAIAudio).not.toHaveBeenCalled();
});
test('IT may read permitted ticket audio, but a revoked manager is rechecked before text disclosure',async()=>{
 const it={userId:99,canManage:true};
 (helpActor as jest.Mock).mockResolvedValue(it);
 await expect(helpAttachmentTranscript(id,it,false,signal)).resolves.toMatchObject({text:'saved'});
 expect(helpActor).toHaveBeenCalledWith(99);
 (helpActor as jest.Mock).mockRejectedValue(new Error('revoked'));
 await expect(validate()).rejects.toThrow('revoked');
});
test('changed ownership after initial authorization invalidates disclosure',async()=>{
 (requireHelpTicket as jest.Mock).mockResolvedValueOnce({id:87,ownerId:10}).mockResolvedValue({id:87,ownerId:11});
 await expect(helpAttachmentTranscript(id,actor,false,signal)).rejects.toMatchObject({status:409});
});

test('closing the requesting view does not cancel or duplicate initiated recognition',async()=>{
 const abort=new AbortController();let workSignal:AbortSignal|undefined;
 (helpAIAudio as jest.Mock).mockImplementation((_ticket,_owner,_sequence,check)=>({
  transcribe:async(_id:string,signal:AbortSignal)=>{workSignal=signal;abort.abort();await check();signal.throwIfAborted();return{attachmentId:id,status:'transcribed',text:'persisted'};},
 }));
 await expect(helpAttachmentTranscript(id,actor,true,abort.signal)).resolves.toMatchObject({text:'persisted'});
 expect(abort.signal.aborted).toBe(true);expect(workSignal?.aborted).toBe(false);
 expect(helpActor).toHaveBeenCalledWith(actor.userId);
});
test('already cancelled requests do not start recognition',async()=>{
 const abort=new AbortController();abort.abort();
 await expect(helpAttachmentTranscript(id,actor,true,abort.signal)).rejects.toThrow();
 expect(helpAIAudio).not.toHaveBeenCalled();
});
