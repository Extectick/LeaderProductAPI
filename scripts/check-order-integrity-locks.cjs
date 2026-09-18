// Isolated real PostgreSQL lock check. Never accepts production connection strings.
require('ts-node/register/transpile-only');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { lockOrderMutation } = require('../src/modules/orders/orderIntegrity');
const url = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54329/LeaderAPI_test';
const parsed = new URL(url);
if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.port !== '54329' || parsed.pathname !== '/LeaderAPI_test') throw Error('Only isolated local test DB is allowed');
(async () => {
  const pool = new Pool({ connectionString: url });
  const worker = await pool.connect(); const writer = await pool.connect();
  const guid = 'order-integrity-lock-test';
  const key = `order-integrity:${guid}`;
  const tx = {
    $queryRaw: async (strings, ...values) => (await writer.query(strings.reduce((sql, part, i) => sql + (i ? `$${i}` : '') + part, ''), values)).rows,
    order: { findFirst: async () => null },
  };
  try {
    await writer.query('BEGIN');
    await writer.query('SET LOCAL statement_timeout=3000');
    await writer.query('CREATE TEMP TABLE "Order" (id text, guid text) ON COMMIT DROP');
    await writer.query('INSERT INTO "Order" VALUES ($1,$1)', [guid]);
    await worker.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [key]);
    await assert.rejects(() => lockOrderMutation(tx, guid), e => e.details?.kind === 'ORDER_EXPORT_IN_PROGRESS');
    await worker.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]);
    await lockOrderMutation(tx, guid);
    const conflict = await worker.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [key]);
    assert.equal(conflict.rows[0].locked, false);
    await writer.query('ROLLBACK');
    const acquired = await worker.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [key]);
    assert.equal(acquired.rows[0].locked, true);
    await worker.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]);
    console.log('PASS: export excludes edits; edits exclude export; rollback releases locks; no Redis dependency');
  } finally {
    await writer.query('ROLLBACK'); worker.release(true); writer.release(); await pool.end();
  }
})().catch(e => { console.error(e.message); process.exitCode=1; });
