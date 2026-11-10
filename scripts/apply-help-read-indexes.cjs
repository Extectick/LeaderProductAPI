/* Dev-only, online application of exactly the two Help read indexes. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const migrationId = '20261105120000_help_read_indexes';
const canonicalSql = fs.readFileSync(path.join(__dirname, '..', 'prisma', 'migrations', migrationId, 'migration.sql'), 'utf8');
const definitions = [
  { name: 'HelpAttachment_messageId_position_idx', table: 'HelpAttachment', columns: ['messageId', 'position'] },
  { name: 'HelpEvent_messageId_type_idx', table: 'HelpEvent', columns: ['messageId', 'type'] },
];
class GuardError extends Error {}
function refuse(message) { throw new GuardError(message); }
function validateTarget(env) {
  if (env.HELP_MIGRATION_TARGET !== 'dev') refuse('HELP_MIGRATION_TARGET must be dev');
  if (env.DB_ACCEPT_DATA_LOSS !== '0') refuse('DB_ACCEPT_DATA_LOSS must be 0');
  let url;
  try { url = new URL(env.DATABASE_URL); } catch { refuse('A valid development DATABASE_URL is required'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) refuse('DATABASE_URL must use PostgreSQL');
  let database;
  try { database = decodeURIComponent(url.pathname.slice(1)); } catch { refuse('Invalid database name'); }
  if (database !== 'LeaderAPI_dev' || env.HELP_MIGRATION_DATABASE_CONFIRM !== 'LeaderAPI_dev') refuse('Database and explicit confirmation must both be LeaderAPI_dev');
}
function migrationChecksum() {
  const sql = canonicalSql.replace(/\r\n/g, '\n');
  const statements = sql.replace(/--[^\n]*/g, '').split(';').map(value => value.trim().replace(/\s+/g, ' ')).filter(Boolean);
  const expected = definitions.map(({ name, table, columns }) => `CREATE INDEX "${name}" ON "${table}"(${columns.map(column => `"${column}"`).join(', ')})`);
  if (JSON.stringify(statements) !== JSON.stringify(expected)) refuse('Canonical SQL differs from the allowed index definitions');
  return crypto.createHash('sha256').update(sql).digest('hex');
}
async function inspectIndexes(client) {
  const { rows } = await client.query(`
    SELECT x.relname AS name, x.relkind, tn.nspname AS table_schema, t.relname AS table_name,
      am.amname AS method, i.indisvalid AS valid, i.indisready AS ready, i.indisunique AS "unique",
      i.indisprimary AS "primary", i.indisexclusion AS exclusion, i.indnatts, i.indnkeyatts,
      i.indpred IS NULL AS no_predicate, i.indexprs IS NULL AS no_expressions,
      (SELECT array_agg(a.attname::text ORDER BY k.ordinality)
        FROM unnest(i.indkey) WITH ORDINALITY k(attnum, ordinality)
        LEFT JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum) AS columns
    FROM pg_class x JOIN pg_namespace n ON n.oid=x.relnamespace
    LEFT JOIN pg_index i ON i.indexrelid=x.oid LEFT JOIN pg_class t ON t.oid=i.indrelid
    LEFT JOIN pg_namespace tn ON tn.oid=t.relnamespace LEFT JOIN pg_am am ON am.oid=x.relam
    WHERE n.nspname='public' AND x.relname=ANY($1::text[])`, [definitions.map(item => item.name)]);
  for (const row of rows) {
    const expected = definitions.find(item => item.name === row.name);
    if (!expected || row.relkind !== 'i' || row.table_schema !== 'public' || row.table_name !== expected.table || row.method !== 'btree'
      || row.valid !== true || row.ready !== true || row.unique !== false || row.primary !== false || row.exclusion !== false
      || row.indnatts !== 2 || row.indnkeyatts !== 2 || !row.no_predicate || !row.no_expressions
      || JSON.stringify(row.columns) !== JSON.stringify(expected.columns)) refuse('Existing Help read index is incompatible; no indexes will be replaced');
  }
  return new Set(rows.map(row => row.name));
}
async function preflightTables(client) {
  const required = { HelpSchemaVersion: { id: 'text', checksum: 'text', appliedAt: 'timestamp without time zone' },
    HelpAttachment: { messageId: 'integer', position: 'integer' }, HelpEvent: { messageId: 'integer', type: 'text' } };
  const { rows } = await client.query(`SELECT table_name,column_name,data_type FROM information_schema.columns
    WHERE table_schema='public' AND table_name=ANY($1::text[])`, [Object.keys(required)]);
  for (const [table, columns] of Object.entries(required)) for (const [column, type] of Object.entries(columns)) {
    if (!rows.some(row => row.table_name === table && row.column_name === column && row.data_type === type)) refuse('Required Help tables or columns are missing or incompatible');
  }
}
async function applyHelpReadIndexes({ env = process.env, client: injectedClient } = {}) {
  validateTarget(env); // Must precede creating or connecting a client.
  const checksum = migrationChecksum();
  const client = injectedClient || new (require('pg').Client)({ connectionString: env.DATABASE_URL });
  let connected = false, locked = false;
  try {
    await client.connect(); connected = true;
    if ((await client.query('SELECT current_database() AS database')).rows[0]?.database !== 'LeaderAPI_dev') refuse('Connected database is not LeaderAPI_dev');
    await client.query("SET lock_timeout='15s'");
    await client.query("SET statement_timeout='10min'");
    await client.query('SELECT pg_advisory_lock(181932, 0)'); locked = true;
    await preflightTables(client);
    const saved = (await client.query('SELECT checksum FROM public."HelpSchemaVersion" WHERE id=$1', [migrationId])).rows[0];
    if (saved && saved.checksum !== checksum) refuse('Recorded Help read migration checksum differs');
    const existing = await inspectIndexes(client);
    if (saved && existing.size !== definitions.length) refuse('Recorded Help read migration has missing indexes');
    let created = 0;
    // Preflight ALL named indexes before the first DDL. A valid partial run
    // without a schema-version record may be resumed; invalid indexes fail closed.
    for (const item of definitions) if (!existing.has(item.name)) {
      await client.query(`CREATE INDEX CONCURRENTLY "${item.name}" ON public."${item.table}" (${item.columns.map(column => `"${column}"`).join(', ')})`);
      created++;
    }
    if ((await inspectIndexes(client)).size !== definitions.length) refuse('Help read index verification is incomplete');
    if (!saved) await client.query('INSERT INTO public."HelpSchemaVersion" (id,checksum) VALUES ($1,$2)', [migrationId, checksum]);
    return { ok: true, migration: migrationId, action: created ? 'applied' : 'verified', indexesCreated: created, checksum };
  } catch (error) {
    // PostgreSQL errors can contain connection/request details. Expose only our
    // fixed guard messages and a generic provider failure, never raw PG errors.
    if (error instanceof GuardError) throw error;
    throw new GuardError('Help read index operation failed; inspect the approved database privately before retrying');
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(181932, 0)').catch(() => {});
    if (connected) await client.end().catch(() => {});
  }
}
module.exports = { applyHelpReadIndexes, migrationId, migrationChecksum };
if (require.main === module) applyHelpReadIndexes().then(result => console.log(JSON.stringify(result))).catch(error => {
  console.error('[help read indexes]', error.message); process.exitCode = 1;
});
