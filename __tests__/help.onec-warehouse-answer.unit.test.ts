import {warehouseDocumentAnswer,readableClarification} from '../src/modules/help/help.onec-warehouse-answer';
const base={kind:'purchase',period:{startDate:'2026-05-04',endDate:'2026-11-04'}};
test('confirmed document facts are rendered without changing posted to published',()=>{
 const r=warehouseDocumentAnswer({...base,status:'found',warehouse:'Тестовый склад',document:{number:'TEST-1',date:'2026-06-02T00:00:00',posted:true}})!;
 expect(r.decision).toBe('answer');expect(r.text).toContain('TEST-1 от 02.06.2026');expect(r.text).toContain('проведённое');expect(r.text).toContain('04.05.2026–04.11.2026');expect(r.text).not.toContain('опубликован');
});
test('empty period remains a successful result and ambiguity uses actual choices',()=>{
 expect(warehouseDocumentAnswer({...base,status:'not_found',warehouse:'Тестовый склад'})!.text).toContain('Проверка выполнена успешно');
 const r=warehouseDocumentAnswer({...base,status:'choose_warehouse',warehouses:['Склад Северный','Ответхранение Северный'],moreMatches:false})!;
 expect(r.questions[0].options.map(o=>o.label)).toEqual(['Склад Северный','Ответхранение Северный']);expect(r.text).not.toContain('Документ.ПоступлениеТоваров');
});
test('malformed result cannot become a factual answer; form syntax is readable',()=>{
 expect(warehouseDocumentAnswer({...base,status:'found'})).toBeUndefined();
 const text=readableClarification('Какие системы?\nOptions: - 1С\n multiSelect: true\nOptions: [] , multiSelect: false');
 expect(text).not.toContain('multiSelect');expect(text).not.toContain('Options:');expect(text).toContain('Ответьте своими словами');
});
test('structured questions replace leaked form JSON in the employee text',()=>{
 const text=readableClarification('1)_HEADER: роль\nQuestion: роль\nOptions: [{"label":"A"}]\nmultiSelect: false',[{id:'role',header:'Роль',question:'Какие задачи вы выполняете?',options:[{label:'Учёт',description:''}],multiSelect:false}]);
 expect(text).toContain('Какие задачи вы выполняете?');expect(text).toContain('• Учёт');expect(text).not.toMatch(/_HEADER|Question:|Options:|"label"|multiSelect/);
});

test('only a real typed document reference and its base produce an internal card link',()=>{
 const reference={_objectRef:true,metadata:'Документ.ПриобретениеТоваровУслуг',guid:'11111111-1111-4111-8111-111111111111',presentation:'Приобретение TEST-1'};
 const value={...base,status:'found',warehouse:'Тестовый склад',document:{number:'TEST-1',date:'2026-06-02T00:00:00',posted:true,reference}};
 const answer=warehouseDocumentAnswer(value,'qa')!;
 expect(answer.text).toContain('[№ TEST-1 от 02.06.2026](leaderproduct://entity/v1/onec/qa/Documents/');
 expect(warehouseDocumentAnswer(value)!.text).not.toContain('leaderproduct:');
 expect(warehouseDocumentAnswer({...value,document:{...value.document,reference:{guid:reference.guid}}},'qa')!.text).not.toContain('leaderproduct:');
});
