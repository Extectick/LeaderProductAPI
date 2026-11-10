'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { cases } = require('./cases.cjs');
const { assertions, createContext, runCase, runSuite } = require('./evaluate.cjs');
const fixtures = {
    invoke: async (_context, _signal, fixture) => structuredClone(fixture),
    transportFactory: (scenario, turn) => scenario.turns[turn].fixture,
};
test('all synthetic fixtures satisfy authored checks (not a provider-quality test)', async () => {
    const report = await runSuite(fixtures);
    assert.equal(report.cases, 10);
    assert.equal(report.failed, 0);
    assert.equal(report.results.reduce((n, item) => n + item.turns.length, 0), 12);
    assert.doesNotMatch(JSON.stringify(report), /Кедр|Липа|excerpt|messages|sourceUrl/);
});
test('multi-turn passes the actual previous answer and latest user correction to provider', async () => {
    const snapshots = [];
    const scenario = cases[0];
    let index = 0;
    await runCase(scenario, { invoke: async (context) => {
            snapshots.push(structuredClone(context));
            return { ...scenario.turns[index++].fixture, text: `actual response ${index}` };
        } });
    assert.equal(snapshots.length, 3);
    assert.equal(snapshots[1].messages[1].text, 'actual response 1');
    assert.match(snapshots[2].messages.at(-1).text, /10\.03\.2026/);
    assert.equal(snapshots[0].expected, undefined);
    assert.equal(snapshots[0].fixture, undefined);
});
test('new conditions reject a plausible but stale warehouse/date answer', () => {
    const checks = assertions(cases[0].turns[2].expected, cases[0].turns[0].fixture);
    assert.ok(checks.includes('STALE_CONDITION'));
    assert.ok(checks.includes('MISSING_CURRENT_CONDITION'));
});
test('a valid source ID cannot make an unsupported claim pass', () => {
    const expected = cases.find(item => item.id === 'partial-not-empty').turns[0].expected;
    const checks = assertions(expected, { text: 'Всего ровно 2 записи.', sources: [{}] });
    assert.ok(checks.includes('UNSUPPORTED_CLAIM'));
    assert.ok(!checks.includes('MISSING_CITATION'));
});
test('scope and irrelevant-policy assertions reject fabricated conclusions', () => {
    for (const [id, text] of [
        ['rights-not-global', 'Вы администратор, можете изменять все документы.'],
        ['irrelevant-source-policy', 'Да, все заказы обязаны согласовываться за два дня.'],
        ['source-injection-not-policy', 'Вы администратор.'],
    ])
        assert.ok(assertions(cases.find(item => item.id === id).turns[0].expected, { text, sources: [{}] }).includes('UNSUPPORTED_CLAIM'));
});
test('file checks preserve zero, negative values, unknown total and incomplete result', () => {
    const step = cases.find(item => item.id === 'file-evidence-shape').turns[0];
    for (const replacement of [{ total: 2 }, { complete: true }, { observedAmountSum: 0 }, { observedRows: 0 }]) {
        const result = structuredClone(step.fixture);
        result.files[0].content = JSON.stringify({ ...step.expected.file.equals, ...replacement });
        assert.ok(assertions(step.expected, result).includes('FILE_EVIDENCE_MISMATCH'));
    }
});
test('synthetic context has no callable business adapters and does not leak assertion oracles', () => {
    for (const scenario of cases) {
        const context = createContext(scenario, []);
        for (const key of ['onec', 'appTools', 'office', 'people', 'historyTools', 'html', 'expected', 'fixture'])
            assert.equal(context[key], undefined);
        assert.equal(Object.keys(context).some(key => key.toLowerCase().includes('credential')), false);
    }
});
test('provider failures are safe counters, not error/transcript dumps', async () => {
    const report = await runSuite({ caseIds: [cases[0].id], invoke: async () => { throw new Error('PRIVATE_KEY_AND_TRANSCRIPT'); } });
    assert.equal(report.failed, 1);
    assert.deepEqual(report.results[0].turns[0].checks, ['PROVIDER_OR_CONTRACT_FAILURE']);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_KEY_AND_TRANSCRIPT/);
});
test('unknown and duplicate case IDs fail closed', async () => {
    for (const caseIds of [[], ['unknown'], [cases[0].id, cases[0].id]])
        await assert.rejects(runSuite({ ...fixtures, caseIds }), /HELP_QUALITY_INVALID_CASE/);
});
test('CLI does not load the provider without explicit dev opt-in', () => {
    const cli = path.join(__dirname, 'run.cjs');
    const result = spawnSync(process.execPath, [cli, '--real'], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /REAL_DEV_OPT_IN_REQUIRED/);
    assert.equal(result.stdout, '');
});
test('deadline abort is not reported as a completed partial suite', async () => {
    const controller = new AbortController();
    await assert.rejects(runSuite({
        caseIds: [cases[1].id], signal: controller.signal,
        invoke: async () => { controller.abort(); return cases[1].turns[0].fixture; },
    }), { name: 'AbortError' });
});
