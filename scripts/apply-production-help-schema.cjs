/* Production-only, atomic additive Help schema rollout. Never uses db push/seed. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('pg');
const manifest = require('./production-help-migrations.json');
const catalogSql = `SELECT jsonb_build_object(
  'columns', COALESCE((SELECT jsonb_agg(jsonb_build_object('table',c.relname,'name',a.attname,
    'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'generated',a.attgenerated,
    'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY c.relname,a.attnum)
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
    LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND a.attnum>0 AND NOT a.attisdropped),'[]'::jsonb),
  'constraints',COALESCE((SELECT jsonb_agg(jsonb_build_object('table',r.relname,'name',c.conname,
    'definition',pg_get_constraintdef(c.oid),'validated',c.convalidated) ORDER BY r.relname,c.conname)
    FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
    WHERE n.nspname='public' AND r.relname=ANY($1::text[])),'[]'::jsonb),
  'indexes',COALESCE((SELECT jsonb_agg(jsonb_build_object('table',r.relname,'name',i.relname,
    'definition',pg_get_indexdef(x.indexrelid),'valid',x.indisvalid,'ready',x.indisready) ORDER BY r.relname,i.relname)
    FROM pg_index x JOIN pg_class r ON r.oid=x.indrelid JOIN pg_class i ON i.oid=x.indexrelid
    JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname='public' AND r.relname=ANY($1::text[])),'[]'::jsonb)
) AS catalog`;
function guard(env) {
  let url;
  try { url = new URL(env.DATABASE_URL); } catch { throw new Error('DATABASE_URL is required'); }
  if (env.NODE_ENV !== 'production' || env.HELP_MIGRATION_TARGET !== 'prod' ||
      env.HELP_MIGRATION_DATABASE_CONFIRM !== 'LeaderAPI' || env.DB_ACCEPT_DATA_LOSS !== '0' ||
      !['postgres:', 'postgresql:'].includes(url.protocol) || decodeURIComponent(url.pathname) !== '/LeaderAPI' ||
      (url.searchParams.has('schema') && url.searchParams.get('schema') !== 'public')) {
    throw new Error('Require explicit production LeaderAPI target, confirmation, public schema and DB_ACCEPT_DATA_LOSS=0');
  }
}
function migrations() {
  return manifest.map(entry => {
    const sql = fs.readFileSync(path.join(__dirname, '../prisma/migrations', entry.id, 'migration.sql'), 'utf8').replace(/\r\n/g, '\n');
    if (crypto.createHash('sha256').update(sql).digest('hex') !== entry.sha256) throw new Error(`Migration file checksum mismatch: ${entry.id}`);
    return { ...entry, sql };
  });
}
function tablesFor(chain) {
  return chain.flatMap(m => [...m.sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?"(\w+)"/g)].map(match => match[1])).sort();
}
async function verifyCatalog(db, tables, expected) {
  const actual = (await db.query(catalogSql, [tables])).rows[0].catalog;
  // Compare normalized JSON keys, not driver-dependent object insertion order.
  for (const section of ['columns','constraints','indexes']) {
    const normalize = value => JSON.stringify(value.map(row => Object.fromEntries(Object.entries(row).sort(([a],[b]) => a.localeCompare(b)))));
    if (normalize(actual[section]) !== normalize(expected[section])) throw new Error(`Production Help schema drift: ${section}`);
  }
  const registration = await db.query(`SELECT
    EXISTS(SELECT 1 FROM "Service" WHERE key='help' AND route='/services/help') AS service,
    EXISTS(SELECT 1 FROM "Permission" WHERE name='manage_help') AS help,
    EXISTS(SELECT 1 FROM "Permission" WHERE name='manage_knowledge') AS knowledge`);
  if (!Object.values(registration.rows[0]).every(Boolean)) throw new Error('Missing Help service or permission registration');
}
async function execute(db, { mode = 'plan', env = process.env, expected = require('./production-help-schema.contract.json') } = {}) {
  guard(env);
  if (!['plan','apply','verify'].includes(mode)) throw new Error('Unsupported migration mode');
  const chain = migrations(), tables = tablesFor(chain);
  await db.query(mode === 'apply' ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await db.query("SET LOCAL search_path=public; SET LOCAL lock_timeout='15s'; SET LOCAL statement_timeout='120s'");
    if (mode === 'apply') await db.query('SELECT pg_advisory_xact_lock(181932,0)');
    const identity = (await db.query('SELECT current_database() AS database')).rows[0];
    if (identity.database !== 'LeaderAPI') throw new Error('Connected to unexpected database');
    // The pre-existing production capability link contract must never regress.
    const permanent = await db.query(`SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='OrderShareLink' AND column_name='expiresAt'`);
    if (permanent.rows[0]?.is_nullable !== 'YES') throw new Error('Production permanent order-link schema is missing');
    const present = await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename=ANY($1::text[])", [tables]);
    let applied = false;
    if (present.rowCount === 0) {
      if (mode === 'verify') throw new Error('Production Help migrations have not been applied');
      if (mode === 'apply') {
        for (const migration of chain) {
          await db.query(migration.sql);
          await db.query('INSERT INTO "HelpSchemaVersion" (id,checksum) VALUES ($1,$2)', [migration.id, migration.sha256]);
        }
        applied = true;
      }
    } else {
      if (present.rowCount !== tables.length) throw new Error('Partial production Help schema; refusing automatic repair');
      const saved = await db.query('SELECT id,checksum FROM "HelpSchemaVersion" ORDER BY id');
      const records = new Map(saved.rows.map(row => [row.id,row.checksum]));
      if (chain.some(m => records.get(m.id) !== m.sha256)) throw new Error('Production migration ledger/checksum mismatch');
    }
    if (present.rowCount || applied) await verifyCatalog(db, tables, expected);
    await db.query('COMMIT');
    return { ok: true, mode, action: applied ? 'applied' : present.rowCount ? 'verified' : 'pending', tables: tables.length,
      migrations: chain.map(({ id,sha256 }) => ({ id,sha256 })), grantsChanged: false };
  } catch (error) { await db.query('ROLLBACK'); throw error; }
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--plan','--dry-run','--apply','--verify'].includes(args[0])) throw new Error('Use exactly one of --plan/--dry-run/--apply/--verify');
  guard(process.env);
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try { console.log(JSON.stringify(await execute(db, { mode: args[0] === '--dry-run' ? 'plan' : args[0].slice(2) }))); }
  finally { await db.end(); }
}
module.exports = { guard, migrations, tablesFor, catalogSql, execute, verifyCatalog };
if (require.main === module) main().catch(error => {
  // Driver errors may contain SQL/data/config; expose only our fixed guard messages.
  console.error('[production Help schema]', error.code ? `Database operation failed (${error.code})` : error.message);
  process.exitCode = 1;
});
