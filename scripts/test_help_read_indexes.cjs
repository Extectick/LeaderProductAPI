const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyHelpReadIndexes, migrationChecksum } = require('./apply-help-read-indexes.cjs');
const env = { HELP_MIGRATION_TARGET: 'dev', DB_ACCEPT_DATA_LOSS: '0', HELP_MIGRATION_DATABASE_CONFIRM: 'LeaderAPI_dev', DATABASE_URL: 'postgresql://synthetic:synthetic@localhost/LeaderAPI_dev' };
const validIndex = (name, table, columns) => ({ name, relkind: 'i', table_schema: 'public', table_name: table, columns,
  method: 'btree', valid: true, ready: true, unique: false, primary: false, exclusion: false, indnatts: 2, indnkeyatts: 2, no_predicate: true, no_expressions: true });
const indexes = [validIndex('HelpAttachment_messageId_position_idx', 'HelpAttachment', ['messageId', 'position']), validIndex('HelpEvent_messageId_type_idx', 'HelpEvent', ['messageId', 'type'])];
function fixture({ existing = [], saved, database = 'LeaderAPI_dev', failCreate = false } = {}) {
  const state = { indexes: structuredClone(existing), saved, calls: [], connects: 0, ends: 0 };
  const client = { async connect() { state.connects++; }, async end() { state.ends++; }, async query(sql, args) {
    state.calls.push({ sql, args });
    if (sql.includes('current_database()')) return { rows: [{ database }] };
    if (sql.includes('information_schema.columns')) return { rows: [
      ['HelpSchemaVersion', 'id', 'text'], ['HelpSchemaVersion', 'checksum', 'text'], ['HelpSchemaVersion', 'appliedAt', 'timestamp without time zone'],
      ['HelpAttachment', 'messageId', 'integer'], ['HelpAttachment', 'position', 'integer'], ['HelpEvent', 'messageId', 'integer'], ['HelpEvent', 'type', 'text'],
    ].map(([table_name, column_name, data_type]) => ({ table_name, column_name, data_type })) };
    if (sql.startsWith('SELECT checksum')) return { rows: state.saved ? [{ checksum: state.saved }] : [] };
    if (sql.includes('FROM pg_class x')) return { rows: structuredClone(state.indexes) };
    if (sql.startsWith('CREATE INDEX')) {
      if (failCreate) throw new Error('synthetic private URL/password/details');
      const index = indexes.find(item => sql.includes(`"${item.name}"`)); assert.ok(index); state.indexes.push(structuredClone(index));
    }
    if (sql.startsWith('INSERT INTO')) state.saved = args[1];
    return { rows: [] };
  } };
  return { state, client };
}
test('invalid target, confirmation, data-loss flag or URL never connect', async () => {
  for (const patch of [{ HELP_MIGRATION_TARGET: 'prod' }, { DB_ACCEPT_DATA_LOSS: '1' }, { HELP_MIGRATION_DATABASE_CONFIRM: 'other' }, { DATABASE_URL: 'postgresql://localhost/LeaderAPI_prod' }, { DATABASE_URL: 'postgresql://localhost/LeaderAPI_dev%2Fother' }, { DATABASE_URL: 'private invalid url' }]) {
    const { state, client } = fixture(); await assert.rejects(applyHelpReadIndexes({ env: { ...env, ...patch }, client })); assert.equal(state.connects, 0);
  }
});
test('checks actual database before any lock or DDL', async () => {
  const { state, client } = fixture({ database: 'wrong' }); await assert.rejects(applyHelpReadIndexes({ env, client }), /not LeaderAPI_dev/);
  assert.equal(state.calls.length, 1); assert.equal(state.ends, 1);
});
test('creates only the two whitelisted indexes concurrently, then verifies and records canonical checksum', async () => {
  const { state, client } = fixture(); const result = await applyHelpReadIndexes({ env, client });
  assert.equal(result.indexesCreated, 2); assert.equal(state.saved, migrationChecksum());
  const ddl = state.calls.filter(call => call.sql.startsWith('CREATE'));
  assert.equal(ddl.length, 2); assert.ok(ddl.every(call => call.sql.startsWith('CREATE INDEX CONCURRENTLY')));
  assert.equal(state.calls.filter(call => call.sql.includes('FROM pg_class x')).length, 2);
  assert.ok(state.calls.find(call => call.sql.includes('array_agg(a.attname::text')));
  assert.ok(state.calls.find(call => call.sql === 'SELECT pg_advisory_lock(181932, 0)'));
  assert.ok(state.calls.find(call => call.sql === 'SELECT pg_advisory_unlock(181932, 0)'));
  assert.ok(!state.calls.some(call => /\bBEGIN\b|\bDROP\b|\bTRUNCATE\b/.test(call.sql)));
});
test('recorded migration is verified on every repeat with no DDL or writes', async () => {
  const { state, client } = fixture({ existing: indexes, saved: migrationChecksum() });
  assert.equal((await applyHelpReadIndexes({ env, client })).action, 'verified');
  assert.ok(!state.calls.some(call => /^(CREATE|INSERT)/.test(call.sql)));
});
test('unrecorded valid partial creation resumes without replacing its existing index', async () => {
  const { state, client } = fixture({ existing: [indexes[0]] });
  assert.equal((await applyHelpReadIndexes({ env, client })).indexesCreated, 1);
  assert.ok(!state.calls.some(call => call.sql.startsWith('CREATE') && call.sql.includes(indexes[0].name)));
});
test('preflights every existing index before DDL and refuses incompatible definitions', async () => {
  for (const patch of [{ valid: false }, { ready: false }, { unique: true }, { method: 'hash' }, { table_name: 'Other' }, { table_schema: 'other' }, { columns: ['type', 'messageId'] }, { no_predicate: false }, { no_expressions: false }, { indnatts: 3 }]) {
    // Second existing index is broken, while the first is missing: no first DDL is permitted.
    const { state, client } = fixture({ existing: [{ ...indexes[1], ...patch }] });
    await assert.rejects(applyHelpReadIndexes({ env, client }), /incompatible/);
    assert.ok(!state.calls.some(call => /^(CREATE|INSERT)/.test(call.sql)));
  }
});
test('recorded checksum mismatch or missing index cannot be silently repaired', async () => {
  for (const options of [{ existing: indexes, saved: 'wrong' }, { existing: [indexes[0]], saved: migrationChecksum() }]) {
    const { state, client } = fixture(options); await assert.rejects(applyHelpReadIndexes({ env, client }));
    assert.ok(!state.calls.some(call => /^(CREATE|INSERT)/.test(call.sql)));
  }
});
test('failed online build never records completion or prints raw PostgreSQL errors', async () => {
  const { state, client } = fixture({ failCreate: true }); await assert.rejects(applyHelpReadIndexes({ env, client }), error => {
    assert.ok(!/synthetic|password|URL|details/.test(error.message)); return true;
  });
  assert.equal(state.saved, undefined); assert.equal(state.ends, 1);
  assert.ok(state.calls.find(call => call.sql.includes('pg_advisory_unlock')));
});
