// Apply only the additive personal-1C schema, never db push or unrelated pending migrations.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { Client } = require('pg');
const id = '20261101030000_onec_personal_connections';
const sql = fs.readFileSync(path.join(__dirname, '..', 'prisma', 'migrations', id, 'migration.sql'), 'utf8');
const checksum = crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
async function main() {
  const name = decodeURIComponent(new URL(process.env.DATABASE_URL).pathname.slice(1));
  if (process.env.ONEC_MIGRATION_DATABASE_CONFIRM !== name || name !== 'LeaderAPI_dev' || process.env.DB_ACCEPT_DATA_LOSS !== '0') throw Error('Explicit dev database confirmation required');
  const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s'");
    await db.query('SELECT pg_advisory_xact_lock(190154,0)');
    const saved = await db.query('SELECT checksum FROM "HelpSchemaVersion" WHERE id=$1', [id]);
    const existing = await db.query('SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename=ANY($1::text[])', [['OnecConnection','OnecDirectoryEntry']]);
    if (saved.rowCount && saved.rows[0].checksum !== checksum) throw Error('Migration checksum differs');
    if (saved.rowCount ? existing.rowCount !== 2 : existing.rowCount !== 0) throw Error('Unexpected personal-1C schema');
    if (!saved.rowCount) await db.query(sql);
    const constraints = [...sql.matchAll(/CONSTRAINT "(Onec\w+)"/g)].map(row => row[1]);
    const checked = await db.query('SELECT conname FROM pg_constraint WHERE connamespace=current_schema()::regnamespace AND conname=ANY($1::text[])', [constraints]);
    if (checked.rowCount !== constraints.length) throw Error('Constraints incomplete');
    await db.query('INSERT INTO "HelpSchemaVersion" (id,checksum) VALUES($1,$2) ON CONFLICT(id) DO NOTHING', [id,checksum]);
    await db.query('COMMIT'); console.log(JSON.stringify({ ok:true, migration:id, action:saved.rowCount?'verified':'applied' }));
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { await db.end(); }
}
main().catch(error => { console.error('[personal-1C migration]',error.code || error.message); process.exitCode=1; });
