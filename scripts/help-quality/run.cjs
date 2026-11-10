#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { runSuite } = require('./evaluate.cjs');
async function main(args) {
    const mode = args.shift();
    if (!['--fixtures', '--real'].includes(mode))
        throw new Error('MODE_REQUIRED');
    let caseIds;
    for (const arg of args) {
        if (!arg.startsWith('--cases=') || caseIds)
            throw new Error('INVALID_ARGUMENT');
        caseIds = arg.slice('--cases='.length).split(',');
    }
    let invoke;
    let transportFactory;
    if (mode === '--real') {
        // Deliberately check opt-in BEFORE importing application code or reading credentials.
        const required = {
            HELP_QUALITY_REAL: '1', NODE_ENV: 'development', HELP_AI_ENABLED: 'true',
            HELP_AI_PROVIDER: 'openai', HELP_OPENAI_ENABLED: 'true',
            HELP_OPENAI_MODEL: 'gpt-6.1-sol', HELP_OPENAI_REASONING_EFFORT: 'medium',
            HELP_OPENAI_ALLOW_GENERAL: 'true', KNOWLEDGE_ENABLED: 'true',
        };
        if (Object.entries(required).some(([key, value]) => process.env[key] !== value)) {
            throw new Error('REAL_DEV_OPT_IN_REQUIRED');
        }
        // A fixed local compiled adapter; API keys remain in its normal private env/file configuration.
        const adapter = require(path.join(__dirname, '../../dist/modules/help/help.openai.js'));
        invoke = adapter.requestOpenAIAnswer;
        if (typeof invoke !== 'function')
            throw new Error('ADAPTER_UNAVAILABLE');
    }
    else {
        invoke = async (_context, _signal, fixture) => structuredClone(fixture);
        transportFactory = (scenario, turn) => scenario.turns[turn].fixture;
    }
    const report = await runSuite({
        caseIds, invoke, transportFactory, signal: AbortSignal.timeout(12 * 60 * 1000),
    });
    process.stdout.write(`${JSON.stringify({
        mode: mode === '--real' ? 'real-provider' : 'fixture-harness-only',
        model: mode === '--real' ? 'gpt-6.1-sol' : null,
        reasoning: mode === '--real' ? 'medium' : null,
        ...report,
    }, null, 2)}\n`);
    process.exitCode = report.failed ? 1 : 0;
}
// Never print thrown provider/configuration errors or stack traces: they can contain private data.
const safeErrors = new Set(['MODE_REQUIRED', 'INVALID_ARGUMENT', 'REAL_DEV_OPT_IN_REQUIRED', 'ADAPTER_UNAVAILABLE', 'HELP_QUALITY_INVALID_CASE']);
main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${JSON.stringify({ error: safeErrors.has(error?.message) ? error.message : 'EVALUATION_FAILED' })}\n`);
    process.exitCode = 2;
});
