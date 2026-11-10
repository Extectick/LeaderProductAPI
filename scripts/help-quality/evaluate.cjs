'use strict';
const { performance } = require('node:perf_hooks');
const { cases } = require('./cases.cjs');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const noop = async () => { };
function assertions(expected, result) {
    const failed = [];
    const text = typeof result?.text === 'string' ? result.text : '';
    if (!text.trim())
        failed.push('EMPTY_ANSWER');
    for (const value of expected.includes || [])
        if (!text.toLocaleLowerCase('ru').includes(value.toLocaleLowerCase('ru')))
            failed.push('MISSING_CURRENT_CONDITION');
    for (const value of expected.excludes || [])
        if (text.toLocaleLowerCase('ru').includes(value.toLocaleLowerCase('ru')))
            failed.push('STALE_CONDITION');
    for (const pattern of expected.patterns || [])
        if (!new RegExp(pattern, 'iu').test(text))
            failed.push('EXPECTED_LIMITATION_MISSING');
    for (const pattern of expected.forbiddenPatterns || [])
        if (new RegExp(pattern, 'iu').test(text))
            failed.push('UNSUPPORTED_CLAIM');
    if (expected.maxQuestions !== undefined && (result.questions || []).length > expected.maxQuestions)
        failed.push('REPEATED_QUESTION');
    if (expected.citation === true && !result.sources?.length)
        failed.push('MISSING_CITATION');
    if (expected.file) {
        const files = (result.files || []).filter(file => file.name === expected.file.name);
        if (files.length !== 1)
            failed.push('FILE_MISSING_OR_DUPLICATED');
        else
            try {
                const data = JSON.parse(files[0].content), wanted = expected.file.equals;
                if (!data || Array.isArray(data) || typeof data !== 'object' || JSON.stringify(Object.keys(data).sort()) !== JSON.stringify(Object.keys(wanted).sort()) || Object.entries(wanted).some(([key, value]) => data[key] !== value))
                    failed.push('FILE_EVIDENCE_MISMATCH');
            }
            catch {
                failed.push('FILE_JSON_INVALID');
            }
    }
    return [...new Set(failed)];
}
function createContext(scenario, messages) {
    const context = { messages: structuredClone(messages), sources: structuredClone(scenario.sources), allowGeneral: true };
    if (scenario.chat === 'it-left')
        context.chatContext = { validate: noop, value: { ticketId: 900001, ownerId: 101, participants: [{ userId: 101, chatRole: 'OWNER', displayName: 'Синтетический пользователь' }], assistant: { kind: 'ai', name: 'ИИ-помощник' }, conversation: { mode: 'AI_ACTIVE', source: 'server_ticket_and_events', lastItTransition: { eventId: 9, type: 'IT_LEFT', actorId: 102, messageId: 3, at: '2026-01-01T00:00:00.000Z' }, recentItTransitions: [], automaticReplyOnItDeparture: false, nextStep: 'respond_to_current_owner_message', ledger: { source: 'original_message_metadata', truncated: false, turns: [], previousItOfferMessageIds: [], lastOwnerMessageId: null, itMessageIds: [2], semanticOutcome: 'read_original_messages_and_working_memory' } } } };
    // This harness intentionally supplies no app/1C adapters or tools: there is no path to a business write.
    return context;
}
async function runCase(scenario, options) {
    if (!cases.some(item => item === scenario) || typeof options?.invoke !== 'function')
        fail('HELP_QUALITY_INVALID_CASE');
    const messages = (scenario.seed || []).map((item, index) => ({ ...item, id: index + 1, sequence: index + 1, author: item.author || { kind: item.role === 'user' ? 'owner' : 'assistant', userId: item.role === 'user' ? 101 : null } }));
    const turns = [];
    let sequence = messages.length;
    for (let turn = 0; turn < scenario.turns.length; turn++) {
        const step = scenario.turns[turn];
        messages.push({ id: ++sequence, sequence, role: 'user', text: step.user, author: { kind: 'owner', userId: 101 } });
        const context = createContext(scenario, messages);
        let result;
        const started = performance.now();
        try {
            result = await options.invoke(context, options.signal || AbortSignal.timeout(90000), options.transportFactory?.(scenario, turn));
        }
        catch {
            turns.push({ turn: turn + 1, passed: false, checks: ['PROVIDER_OR_CONTRACT_FAILURE'], durationMs: Math.round(performance.now() - started) });
            break;
        }
        const checks = assertions(step.expected, result);
        turns.push({ turn: turn + 1, passed: checks.length === 0, checks, durationMs: Math.round(performance.now() - started) });
        if (typeof result?.text !== 'string')
            break;
        messages.push({ id: ++sequence, sequence, role: 'assistant', text: result.text, author: { kind: 'assistant', userId: null } });
    }
    return { caseId: scenario.id, passed: turns.length === scenario.turns.length && turns.every(turn => turn.passed), turns };
}
async function runSuite(options) {
    const ids = options.caseIds || cases.map(item => item.id);
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some(id => !cases.some(item => item.id === id)))
        fail('HELP_QUALITY_INVALID_CASE');
    const results = [];
    for (const id of ids) {
        options.signal?.throwIfAborted();
        results.push(await runCase(cases.find(item => item.id === id), options));
        options.signal?.throwIfAborted();
    }
    return { schemaVersion: 1, synthetic: true, noBusinessAdapters: true, semanticEvaluator: 'authored-bounded-assertions', cases: results.length, passed: results.filter(item => item.passed).length, failed: results.filter(item => !item.passed).length, results };
}
module.exports = { assertions, createContext, runCase, runSuite };
