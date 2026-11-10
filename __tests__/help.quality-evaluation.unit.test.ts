import { requestOpenAIAnswer } from '../src/modules/help/help.openai';
const { cases } = require('../scripts/help-quality/cases.cjs');
const { runSuite } = require('../scripts/help-quality/evaluate.cjs');
const original = { ...process.env };

beforeEach(() => {
  process.env = {
    ...original, NODE_ENV: 'development', HELP_AI_ENABLED: 'true', KNOWLEDGE_ENABLED: 'true',
    HELP_AI_PROVIDER: 'openai', HELP_OPENAI_ENABLED: 'true', HELP_OPENAI_MODEL: 'fixture',
    HELP_OPENAI_REASONING_EFFORT: 'medium', HELP_OPENAI_ALLOW_GENERAL: 'true', OPENAI_API_KEY: 'fixture-key',
  };
  delete process.env.OPENAI_API_KEY_FILE;
  delete process.env.HELP_OPENAI_PROXY_URL;
  jest.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('External network forbidden'); });
});
afterEach(() => { process.env = original; jest.restoreAllMocks(); });
function response(fixture: any) {
  return Response.json({ id: 'synthetic-quality', status: 'completed', output: [{
    type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({
      analysis_summary: '', decision: fixture.decision, message: fixture.text,
      source_ids: fixture.sources.length ? ['S1'] : [], suggestions: [], questions: fixture.questions,
      files: fixture.files,
    }) }],
  }] });
}

test('multi-turn suite exercises actual adapter serialization/parser through injected transport', async () => {
  const bodies: any[] = [];
  const report = await runSuite({
    invoke: requestOpenAIAnswer,
    transportFactory: (scenario: any, turn: number) => jest.fn(async (_url: unknown, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return response(scenario.turns[turn].fixture);
    }),
  });
  expect(report.results.filter((item: any) => !item.passed)).toEqual([]);
  expect(report.passed).toBe(10);
  expect(bodies.length).toBe(12);
  const second = JSON.parse(bodies[1].input[0].content);
  expect(second.messages[1].text).toBe(cases[0].turns[0].fixture.text);
  expect(second.messages[2].text).toBe(cases[0].turns[1].user);
  expect(bodies.every(body => !body.tools?.length)).toBe(true);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

test('valid source citation and schema still fail eval when answer invents a global total', async () => {
  const scenario = cases.find((item: any) => item.id === 'partial-not-empty');
  const report = await runSuite({
    caseIds: [scenario.id], invoke: requestOpenAIAnswer,
    transportFactory: () => jest.fn(async () => response({ ...scenario.turns[0].fixture, text: 'Всего ровно 2 записи.' })),
  });
  expect(report.failed).toBe(1);
  expect(report.results[0].turns[0].checks).toContain('UNSUPPORTED_CLAIM');
  expect(report.results[0].turns[0].checks).not.toContain('PROVIDER_OR_CONTRACT_FAILURE');
  expect(globalThis.fetch).not.toHaveBeenCalled();
});
