jest.mock('node:child_process',()=>({spawn:jest.fn()}));
import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {extractKnowledgeText} from '../src/modules/knowledge/knowledge.extract';

function fakeChild(){
 const child=new EventEmitter() as EventEmitter&{stdin:EventEmitter&{end:jest.Mock};stdout:EventEmitter&{setEncoding:jest.Mock};kill:jest.Mock};
 child.stdin=Object.assign(new EventEmitter(),{end:jest.fn()});
 child.stdout=Object.assign(new EventEmitter(),{setEncoding:jest.fn()});
 child.kill=jest.fn(()=>true);return child;
}
beforeEach(()=>{jest.clearAllMocks();});
afterEach(()=>jest.useRealTimers());
test('an already aborted operation never starts a parser process',async()=>{
 const controller=new AbortController();controller.abort(Error('PRIVATE_REASON'));
 await expect(extractKnowledgeText(Buffer.from('%PDF-fixture'),'pdf',controller.signal)).rejects.toMatchObject({code:'EXTRACTION_CANCELLED',message:'EXTRACTION_CANCELLED'});
 expect(spawn).not.toHaveBeenCalled();
});
test('caller cancellation kills the child and removes timeout/listeners',async()=>{
 jest.useFakeTimers();const child=fakeChild();(spawn as jest.Mock).mockReturnValue(child);
 const controller=new AbortController(),result=extractKnowledgeText(Buffer.from('%PDF-fixture'),'pdf',controller.signal);
 const rejected=expect(result).rejects.toMatchObject({code:'EXTRACTION_CANCELLED'});controller.abort();await rejected;
 expect(child.kill).toHaveBeenCalledWith('SIGKILL');expect(jest.getTimerCount()).toBe(0);
 child.stdout.emit('data',JSON.stringify({text:'LATE_PRIVATE_TEXT'}));child.emit('close',0);
 expect(child.kill).toHaveBeenCalledTimes(1);
});
test('the built-in extraction deadline kills the child',async()=>{
 jest.useFakeTimers();const child=fakeChild();(spawn as jest.Mock).mockReturnValue(child);
 const result=extractKnowledgeText(Buffer.from('%PDF-fixture'),'pdf');const rejected=expect(result).rejects.toMatchObject({code:'EXTRACTION_TIMEOUT'});
 await jest.advanceTimersByTimeAsync(25000);await rejected;expect(child.kill).toHaveBeenCalledWith('SIGKILL');expect(jest.getTimerCount()).toBe(0);
});
test('successful old-style callers still work and no application credentials enter the child environment',async()=>{
 jest.useFakeTimers();const child=fakeChild();(spawn as jest.Mock).mockReturnValue(child);
 const result=extractKnowledgeText(Buffer.from('fixture'),'docx');
 const options=(spawn as jest.Mock).mock.calls[0][2];
 expect(Object.keys(options.env).sort()).toEqual(['LANG','PATH','SystemRoot','TEMP']);
 expect(options.env.OPENAI_API_KEY).toBeUndefined();expect(options.env.DATABASE_URL).toBeUndefined();
 expect(options.stdio).toEqual(['pipe','pipe','ignore']);
 child.stdout.emit('data',JSON.stringify({text:'Document text'}));child.emit('close',0);
 await expect(result).resolves.toBe('Document text');expect(jest.getTimerCount()).toBe(0);expect(child.kill).not.toHaveBeenCalled();
});
