import { prepareHelpConversationWindow, HELP_CONTEXT_WINDOW_BYTES } from '../src/modules/help/help.context-window';
import type { HelpContextMessage,HelpContextSummary } from '../src/modules/help/help.context-store';
const hash='a'.repeat(64);
const message=(id:number,text='Сообщение '+id):HelpContextMessage=>({id,sequence:id,role:id%2?'user':'assistant',text,attachments:[]});
const summary:HelpContextSummary={version:1,model:'fixture',coveredThrough:10,fingerprint:hash,items:[{kind:'constraint',text:'Выбран склад Северный',messageIds:[1]}]};
function prepare(messages:HelpContextMessage[],extra:Record<string,unknown>={}){
 const compact=jest.fn(async()=>[{kind:'goal' as const,text:'Продолжить исходную задачу',messageIds:[1]}]);
 return {compact,run:(options:Record<string,unknown>={})=>prepareHelpConversationWindow({snapshot:{messages,totalMessages:messages.length,omittedBefore:0,...extra},model:'fixture',signal:new AbortController().signal,fingerprint:async()=>hash,compact,...options})};
}
test('a short conversation beyond the old 16/100-message cutoff is preserved whole',async()=>{
 const messages=Array.from({length:140},(_,i)=>message(i+1));const p=prepare(messages),result=await p.run();
 expect(result.messages).toEqual(messages);expect(p.compact).not.toHaveBeenCalled();expect(result.coverage.omittedMessages).toBe(0);
});
test('long dialogue creates referenced memory while retaining fresh messages without substrings',async()=>{
 const messages=Array.from({length:80},(_,i)=>message(i+1,'Начало '+i+' '+('я'.repeat(1000))+' Конец '+i));
 const p=prepare(messages),result=await p.run();
 expect(result.summary?.fingerprint).toBe(hash);expect(result.coverage.compaction).toBe('ready');
 expect(result.messages[result.messages.length-1]).toEqual(messages[messages.length-1]);
 for(const m of result.messages)expect(m.text).toBe(messages.find(row=>row.id===m.id)!.text);
 expect(result.summary!.coveredThrough).toBeLessThan(result.messages[0].sequence);
 expect(p.compact).toHaveBeenCalledTimes(1);
});
test('provider compaction failure keeps previous memory and original history remains recoverable',async()=>{
 const messages=Array.from({length:100},(_,i)=>message(i+11,'Полное сообщение '+i+' '+'x'.repeat(1200)));
 const p=prepare(messages,{summary,totalMessages:400,omittedBefore:300});
 const result=await p.run({compact:jest.fn().mockRejectedValue(Error('unavailable'))});
 expect(result.summary).toEqual(summary);expect(result.coverage.compaction).toBe('unavailable');
 expect(result.coverage.omittedMessages).toBeGreaterThan(300);
 expect(result.messages[result.messages.length-1]).toEqual(messages[messages.length-1]);
 expect(Buffer.byteLength(JSON.stringify(result.messages))).toBeLessThanOrEqual(HELP_CONTEXT_WINDOW_BYTES+1000);
});
test('history edits during compaction invalidate the new snapshot instead of persisting stale facts',async()=>{
 const p=prepare(Array.from({length:80},(_,i)=>message(i+1,'я'.repeat(1000))));
 const fingerprint=jest.fn().mockResolvedValueOnce(hash).mockResolvedValueOnce('b'.repeat(64));
 await expect(p.run({fingerprint})).rejects.toMatchObject({code:'HELP_CONTEXT_CHANGED'});
});
test('previous summary is reused after restart and short append needs no extra model call',async()=>{
 const messages=[message(11,'Да, продолжай'),message(12,'Последний вопрос')];const p=prepare(messages,{summary,totalMessages:12});
 const result=await p.run();expect(result.summary).toEqual(summary);expect(p.compact).not.toHaveBeenCalled();expect(result.coverage.summaryThrough).toBe(10);
});
test('cancelled preparation does not start a compaction or return a late window',async()=>{
 const p=prepare([message(1)]),abort=new AbortController();abort.abort();
 await expect(p.run({signal:abort.signal})).rejects.toBeDefined();expect(p.compact).not.toHaveBeenCalled();
});
