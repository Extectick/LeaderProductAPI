import { canEditHelpMessage, canReopenHelpTicket, detectHelpFile, HELP_EDIT_MS, HELP_REOPEN_MS, helpTitle } from '../src/modules/help/help.policy';

describe('Help policy (server authority)',()=>{
  const now=Date.UTC(2026,9,23,12);
  test('editing only by author before one hour, no future timestamp',()=>{
    expect(canEditHelpMessage(1,1,new Date(now-HELP_EDIT_MS+1),now)).toBe(true);
    expect(canEditHelpMessage(1,1,new Date(now-HELP_EDIT_MS),now)).toBe(false);
    expect(canEditHelpMessage(1,2,new Date(now),now)).toBe(false);
    expect(canEditHelpMessage(1,1,new Date(now+1),now)).toBe(false);
  });
  test('reopen deadline inclusive72h, closed timestamp required',()=>{
    expect(canReopenHelpTicket('CLOSED',new Date(now-HELP_REOPEN_MS),now)).toBe(true);
    expect(canReopenHelpTicket('CLOSED',new Date(now-HELP_REOPEN_MS-1),now)).toBe(false);
    expect(canReopenHelpTicket('CLOSED',null,now)).toBe(false);
    expect(canReopenHelpTicket('OPEN',new Date(now),now)).toBe(false);
    expect(canReopenHelpTicket('CLOSED',new Date(now+1),now)).toBe(false);
  });
  test('non-AI title is bounded and normalizes whitespace',()=>{
    expect(helpTitle('  Не\nработает\tпринтер  ',false)).toBe('Не работает принтер');
    expect(helpTitle('',true)).toBe('Обращение с вложениями');
    expect(helpTitle('x'.repeat(200),false)).toHaveLength(100);
  });
  test('file detection rejects empty, HTML, SVG and arbitrary binary',()=>{
    for(const bytes of [Buffer.alloc(0),Buffer.from('<html>test</html>'),Buffer.from('<svg/>'),Buffer.from([0,1,2,3])]) expect(detectHelpFile(bytes)).toBeNull();
    expect(detectHelpFile(Buffer.from('%PDF-1.7'))).toMatchObject({kind:'FILE'});
    expect(detectHelpFile(Buffer.from('Журнал ошибки'))).toMatchObject({kind:'FILE',mimeType:'text/plain'});
  });
  test('content signatures identify images and voice independent of extension',()=>{
    expect(detectHelpFile(Buffer.from([137,80,78,71,13,10,26,10]))).toMatchObject({kind:'IMAGE',mimeType:'image/png'});
    expect(detectHelpFile(Buffer.from('RIFF1234WAVEdata'))).toMatchObject({kind:'AUDIO'});
    expect(detectHelpFile(Buffer.from('RIFF1234WEBPdata'))).toMatchObject({kind:'IMAGE'});
  });
});
