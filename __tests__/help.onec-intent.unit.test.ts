import { requiresOnecRead } from '../src/modules/help/help.onec-intent';
const one = (text: string) => requiresOnecRead([{ role: 'user', text }]);
test.each(['Какое последнее приобретение было по складу новосибирск новичков?', 'Проверь MCP работу 1с', 'Покажи остатки товаров', 'Проверь мои права в 1С'])('live data starts with a tool: %s', text => expect(one(text)).toBe(true));
test.each(['Задай вопросы обо мне как сотрудник', 'Как найти последнее поступление в 1С?', 'Что такое приобретение товаров?', 'Как подключить 1С?', 'Что ты умеешь?', 'В каком отделе вы работаете?\nОтвет: Склад'])('advice and questionnaire do not trigger a live audit: %s', text => expect(one(text)).toBe(false));
test('continuations retain data intent while a new topic resets it', () => {
 const messages = [{role:'user',text:'Покажи последнее приобретение по складу'}, {role:'assistant',text:'Проверю'}, {role:'user',text:'Нужна помощь'}];
 expect(requiresOnecRead(messages)).toBe(true);
 expect(requiresOnecRead([...messages,{role:'user',text:'Задай вопросы обо мне как сотрудник'}])).toBe(false);
});

test('technical questions and read confirmations are rejected, actual business selection is allowed', () => {
  const { requiresOnecLookupBeforeClarify, requiresOnecBusinessRead } = require('../src/modules/help/help.onec-intent');
  expect(requiresOnecBusinessRead([{role:'user',text:'Проверь MCP работу 1с'}])).toBe(false);
  expect(requiresOnecBusinessRead([{role:'user',text:'Какое последнее приобретение по складу?'}])).toBe(true);
  expect(requiresOnecLookupBeforeClarify('Подтвердите склад и чтение')).toBe(true);
  expect(requiresOnecLookupBeforeClarify('Какое точное название документа использовать?')).toBe(true);
  expect(requiresOnecLookupBeforeClarify('Найдено два склада. Выберите Новосибирск или Омск.')).toBe(false);
});

test('latest warehouse routing uses the business request instead of a quoted guessed metadata reply', () => {
 const { preferredWarehouseTool } = require('../src/modules/help/help.onec-intent');
 const history=[{role:'user',text:'Какое последнее приобретение по складу Новосибирск новичков?'},{role:'user',text:'Какой документ использовать?\nОтвет: Документ.ПоступлениеТоваров'},{role:'user',text:'Нужна помощь'}];
 expect(preferredWarehouseTool(history)).toBe('onec_find_latest_purchase');
 expect(preferredWarehouseTool([{role:'user',text:'Задай вопросы обо мне как сотруднике'}])).toBeUndefined();
});

test('warehouse entity comes from literal employee words and a later explicit choice', () => {
 const {warehouseTextForRequest}=require('../src/modules/help/help.onec-intent');
 const messages=[{role:'user',text:'Какое последнее приобретение по складу новосибирск новичков?'}];
 expect(warehouseTextForRequest(messages)).toBe('новосибирск новичков');
 expect(warehouseTextForRequest([...messages,{role:'user',text:'Выберите склад\nОтвет: Склад Новосибирск Новичков'}])).toBe('Склад Новосибирск Новичков');
 expect(warehouseTextForRequest([{role:'user',text:'Покажи последнее приобретение на складе «Ответхранение Новосибирск Новичков» за полгода'}])).toBe('Ответхранение Новосибирск Новичков');
});
