/* Additive migration for the existing Help database; never infer an environment. */
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { Client } = require('pg');
const id = '20261031150000_knowledge_catalog';
const sql = fs.readFileSync(path.join(__dirname, '..', 'prisma', 'migrations', id, 'migration.sql'), 'utf8');
const checksum = crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
const tables = ['KnowledgeSource','KnowledgeDocument','KnowledgeVersion','KnowledgeChunk','KnowledgeIngestionJob','KnowledgeAuditEvent'];
async function main() {
  const target = process.env.KNOWLEDGE_MIGRATION_TARGET;
  const name = decodeURIComponent(new URL(process.env.DATABASE_URL).pathname.slice(1));
  if (process.env.DB_ACCEPT_DATA_LOSS !== '0' || process.env.KNOWLEDGE_MIGRATION_DATABASE_CONFIRM !== name ||
      !(target === 'dev' && name === 'LeaderAPI_dev' || target === 'test' && /^LeaderAPI_knowledge_test_\d{8}$/.test(name))) {
    throw Error('Explicit dev/test database confirmation and DB_ACCEPT_DATA_LOSS=0 are required');
  }
  const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s'");
    await db.query('SELECT pg_advisory_xact_lock(181932,0)');
    // Same guarded migration ledger as the existing Help deployment, not db push.
    const saved = await db.query('SELECT checksum FROM "HelpSchemaVersion" WHERE id=$1', [id]);
    const existing = await db.query('SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename=ANY($1::text[])', [tables]);
    if (saved.rowCount && saved.rows[0].checksum !== checksum) throw Error('Applied knowledge migration checksum differs');
    if (saved.rowCount ? existing.rowCount !== tables.length : existing.rowCount !== 0) throw Error('Unexpected or partial knowledge schema; refusing changes');
    if (!saved.rowCount) await db.query(sql);
    const constraints = [...sql.matchAll(/CONSTRAINT "(Knowledge\w+)"/g)].map(row => row[1]);
    const checked = await db.query('SELECT conname FROM pg_constraint WHERE connamespace=current_schema()::regnamespace AND conname=ANY($1::text[])', [constraints]);
    if (checked.rowCount !== constraints.length) throw Error('Knowledge constraints are incomplete');
    const generated = await db.query(`SELECT is_generated FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='KnowledgeChunk' AND column_name='searchVector'`);
    const index = await db.query(`SELECT indexdef FROM pg_indexes WHERE schemaname=current_schema() AND indexname='KnowledgeChunk_searchVector_idx'`);
    if (generated.rows[0]?.is_generated !== 'ALWAYS' || !index.rows[0]?.indexdef.includes('USING gin')) throw Error('Knowledge full-text index is missing');
    await db.query('INSERT INTO "HelpSchemaVersion" (id,checksum) VALUES($1,$2) ON CONFLICT(id) DO NOTHING', [id, checksum]);
    await db.query('COMMIT');
    console.log(JSON.stringify({ ok: true, migration: id, action: saved.rowCount ? 'verified' : 'applied', checksum }));
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { await db.end(); }
}
main().catch(error => { console.error('[knowledge migration]', error.code || error.message); process.exitCode = 1; });
