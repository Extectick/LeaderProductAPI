import {helpHandoffText} from '../src/modules/help/help.answer-guard';

const action='Чтобы вызвать IT-специалиста, нажмите кнопку под ответом и подтвердите вызов.';
const reason='Не удалось прочитать журнал: требуется доступ администратора.';
const countAction=(text:string)=>text.split(action).length-1;
const variants=[
 action,
 'Нажмите кнопку «Вызвать IT» под ответом и подтвердите передачу.',
 'Для вызова IT-специалиста нажмите кнопку под ответом. Затем подтвердите вызов.',
 'Нужно вызвать IT через кнопку под ответом и подтвердить передачу.',
];

test.each(variants)('first offer preserves the diagnostic reason and contains one canonical action: %s',variant=>{
 const result=helpHandoffText(`${reason}\n\n${variant}\n\n${variant}`);
 expect(result).toContain(reason);expect(countAction(result)).toBe(1);
 if(variant!==action)expect(result).not.toContain(variant);
 expect(helpHandoffText(result)).toBe(result);
});

test.each(variants)('later offers keep the reason without repeating the UI instructions: %s',variant=>{
 const result=helpHandoffText(`${reason}\n${variant}`,{explainAction:false});
 expect(result).toBe(reason);expect(countAction(result)).toBe(0);
});

test.each([
 'Не удалось прочитать документы, поэтому нажмите кнопку «Вызвать IT» и подтвердите вызов.',
 'Не удалось прочитать документы: для вызова IT нажмите кнопку под ответом и подтвердите передачу.',
])('mixed diagnostic and CTA sentence retains its diagnostic clause: %s',text=>{
 const first=helpHandoffText(text),later=helpHandoffText(text,{explainAction:false});
 expect(first).toContain('Не удалось прочитать документы');expect(countAction(first)).toBe(1);
 expect(later).toContain('Не удалось прочитать документы');expect(later).not.toMatch(/нажмите|кнопк|подтверд/iu);
});

test('diagnostic reason after an imperative CTA must also survive normalization',()=>{
 const text='Нажмите кнопку «Вызвать IT», потому что проверка требует доступа администратора.';
 const result=helpHandoffText(text,{explainAction:false});
 expect(result).toContain('проверка требует доступа администратора');expect(result).not.toContain('Нажмите');
});

test('describing a broken IT button is a diagnostic fact, not another instruction to press it',()=>{
 const text='Кнопка вызова IT недоступна в этой версии приложения.';
 expect(helpHandoffText(text,{explainAction:false})).toBe(text);
});

test('a model claim of a completed transfer is removed without dropping the independent diagnostic reason',()=>{
 const result=helpHandoffText(`${reason} Я передал заявку IT.`,{explainAction:false});
 expect(result).toBe(reason);expect(result).not.toContain('передал');
});
