import { guardHelpAIProgress } from '../src/modules/help/help.answer-guard';
import type { HelpAIProgressUpdate } from '../src/modules/help/help.ai-stream';

const context = [{ role: 'user', text: 'Помогите разобраться с приложением.' }];
const safe = 'Проверка завершена. ';
const held = safe + 'Откройте';
const extension = held + ' приложение.';
const blocked = safe + 'Отключите антивирус.';
const setup = () => {
  const writer = jest.fn<Promise<void>, [HelpAIProgressUpdate]>().mockResolvedValue(undefined);
  return { writer, guard: guardHelpAIProgress(writer, context)! };
};

test('holds only an ambiguous suffix, preserving the published prefix and validation callback', async () => {
  const { writer, guard } = setup();
  const validateAppAccess = jest.fn();
  await guard({ draftText: safe });
  await guard({ draftText: held, phase: 'answer', validateAppAccess });
  expect(writer.mock.calls[1][0]).toEqual({ phase: 'answer', validateAppAccess, flush: true });
  await guard({ draftText: extension });
  expect(writer.mock.calls[2][0].draftText).toBe(extension);
});

test('an initial held draft stays empty', async () => {
  const { writer, guard } = setup();
  await guard({ draftText: 'Откройте' });
  expect(writer).toHaveBeenLastCalledWith({ draftText: '', flush: true });
});

test('confirmed block withdraws previous text and resets retained prefix', async () => {
  const { writer, guard } = setup();
  await guard({ draftText: safe });
  await guard({ draftText: blocked });
  expect(writer).toHaveBeenLastCalledWith({ draftText: '', flush: true });
  await guard({ draftText: held });
  expect(writer).toHaveBeenLastCalledWith({ draftText: '', flush: true });
});

test('explicit withdrawal cannot resurrect previously published text', async () => {
  const { writer, guard } = setup();
  await guard({ draftText: safe });
  await guard({ draftText: '', phase: 'validating' });
  expect(writer).toHaveBeenLastCalledWith({ draftText: '', phase: 'validating' });
  await guard({ draftText: held });
  expect(writer).toHaveBeenLastCalledWith({ draftText: '', flush: true });
});

test('nonappend held replacement withdraws the obsolete draft', async () => {
  const { writer, guard } = setup();
  await guard({ draftText: safe });
  await guard({ draftText: 'Другой ответ. Откройте' });
  expect(writer).toHaveBeenLastCalledWith({ draftText: '', flush: true });
});

test('safe correction is published and becomes the new prefix', async () => {
  const { writer, guard } = setup();
  await guard({ draftText: safe });
  await guard({ draftText: 'Исправленный ответ. ' });
  await guard({ draftText: 'Исправленный ответ. Откройте' });
  expect(writer).toHaveBeenLastCalledWith({ flush: true });
});

test('failed writer never advances last successfully published prefix', async () => {
  const { writer, guard } = setup();
  await guard({ draftText: safe });
  writer.mockRejectedValueOnce(new Error('FENCE_DENIED'));
  await expect(guard({ draftText: safe + 'Новый факт.' })).rejects.toThrow('FENCE_DENIED');
  await guard({ draftText: held });
  expect(writer).toHaveBeenLastCalledWith({ flush: true });
});

test('held suffix still invokes and propagates the original writer fences', async () => {
  const { writer, guard } = setup();
  await guard({ draftText: safe });
  writer.mockRejectedValueOnce(new Error('ACCESS_REVOKED'));
  await expect(guard({ draftText: held })).rejects.toThrow('ACCESS_REVOKED');
  expect(writer).toHaveBeenCalledTimes(2);
});

test('analysis filtering remains active while the answer suffix is held', async () => {
  const { writer, guard } = setup();
  await guard({ draftText: safe });
  await guard({ draftText: held, activity: { id: 'a', kind: 'analysis', status: 'running', label: 'План', text: blocked } });
  const published = writer.mock.calls[1][0];
  expect(published.draftText).toBeUndefined();
  expect(published.activity?.text).toBe('Проверяю безопасный порядок диагностики.');
  expect(published.flush).toBe(true);
});
