import {prepareScheduleReply, scheduleReply} from '../src/modules/help/help.schedule-dialogue';

describe('daily stock request in a Help chat', () => {
  const request='Каждый день утром в 12:00 присылай мне если есть отрицательные остатки.';
  it('only proposes a task and uses the device zone', () => {
    expect(scheduleReply(request,'Asia/Novosibirsk')?.state.scheduleDraft).toEqual({
      time:'12:00',timeZone:'Asia/Novosibirsk',warehouse:'all',metric:'inStock',
    });
    expect(scheduleReply('Покажи отрицательные остатки','Asia/Novosibirsk')).toBeUndefined();
    expect(scheduleReply('Как создать вид документа?',undefined)).toBeUndefined();
  });
  it('continues the previous clarification from the same conversation',async()=>{
    const prior=scheduleReply('Создай регламентное задание проверять отрицательные остатки','Europe/Moscow');
    const load=jest.fn().mockResolvedValue(prior?.state);
    const reply=await prepareScheduleReply({inputs:[{text:'каждый день в 7:30',sequence:4}]},load);
    expect(reply?.state.scheduleDraft?.time).toBe('07:30');
    expect(reply?.state.scheduleDraft?.timeZone).toBe('Europe/Moscow');
    expect(load).toHaveBeenCalledWith(4);
  });
  it('preserves explicit filters and requests clarification about unsupported schedules',()=>{
    const reply=scheduleReply(request+' На складе «Торговый зал» с учётом резервов.', 'UTC');
    expect(reply?.state.scheduleDraft).toMatchObject({warehouse:'Торговый зал',metric:'available'});
    expect(scheduleReply('Создай регламентное задание по будням в 9:30 проверять отрицательные остатки.', 'UTC')?.state.scheduleDraft).toBeUndefined();
    expect(scheduleReply(request+' На складе офиса.', 'UTC')?.state.scheduleDraft).toBeUndefined();
  });
});
