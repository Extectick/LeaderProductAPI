/* Adopt only an empty dev/test catalog created by db push. Never rebuild populated tables. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('pg');
const id = '20261031150000_knowledge_catalog';
const sql = fs.readFileSync(path.join(__dirname, '..', 'prisma', 'migrations', id, 'migration.sql'), 'utf8');
const checksum = crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
const tables = ['KnowledgeSource', 'KnowledgeDocument', 'KnowledgeVersion', 'KnowledgeChunk', 'KnowledgeIngestionJob', 'KnowledgeAuditEvent'];
const shadow = 'knowledge_empty_adoption_20261104';
const qi = name => '"' + name.replaceAll('"', '""') + '"';
const normalize = value => value == null ? null : value.replaceAll(shadow + '.', '').replaceAll('public.', '').replace(/\s+/g, ' ').trim();

async function main() {
  const name = decodeURIComponent(new URL(process.env.DATABASE_URL).pathname.slice(1));
  if (process.env.DB_ACCEPT_DATA_LOSS !== '0' || process.env.KNOWLEDGE_SCHEMA_ADOPTION_CONFIRM !== 'empty-catalog-only' ||
      process.env.KNOWLEDGE_MIGRATION_DATABASE_CONFIRM !== name ||
      !(process.env.KNOWLEDGE_MIGRATION_TARGET === 'dev' && name === 'LeaderAPI_dev' ||
        process.env.KNOWLEDGE_MIGRATION_TARGET === 'test' && /^LeaderAPI_knowledge_test_\d{8}$/.test(name))) {
    throw Error('Explicit empty dev/test catalog confirmation required');
  }
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s'");
    await db.query('SELECT pg_advisory_xact_lock(181932,0)');
    const saved = await db.query('SELECT checksum FROM "HelpSchemaVersion" WHERE id=$1', [id]);
    if (saved.rowCount) {
      if (saved.rows[0].checksum !== checksum) throw Error('Canonical checksum mismatch');
      await db.query('COMMIT');
      console.log(JSON.stringify({ ok: true, action: 'already-recorded', migration: id }));
      return;
    }
    await db.query('LOCK TABLE ' + tables.map(qi).join(',') + ' IN SHARE ROW EXCLUSIVE MODE');
    for (const table of tables) {
      if ((await db.query('SELECT 1 FROM ' + qi(table) + ' LIMIT 1')).rowCount) {
        throw Error('Catalog is populated; automatic adoption refused');
      }
    }
    // Build the canonical definition in a transaction-local shadow schema. Compare
    // real PostgreSQL definitions instead of assuming that Prisma's tables match.
    await db.query('CREATE SCHEMA ' + qi(shadow));
    await db.query('SET LOCAL search_path TO ' + qi(shadow) + ', public');
    await db.query(sql.split('-- Knowledge publishing')[0].replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
    await db.query('SET LOCAL search_path TO public');
    const columns = async schema => (await db.query(`SELECT table_name,column_name,data_type,udt_name,
      is_nullable,column_default,is_generated,generation_expression,datetime_precision
      FROM information_schema.columns WHERE table_schema=$1 AND table_name=ANY($2::text[])
      ORDER BY table_name,ordinal_position`, [schema, tables])).rows;
    const expected = await columns(shadow);
    const checkColumns = async ignoreVector => {
      const actual = await columns('public');
      for (const column of expected) {
        if (ignoreVector && column.table_name === 'KnowledgeChunk' && column.column_name === 'searchVector') continue;
        const current = actual.find(row => row.table_name === column.table_name && row.column_name === column.column_name);
        if (!current || Object.keys(column).some(key => normalize(String(current[key])) !== normalize(String(column[key])))) {
          throw Error('Column differs from canonical schema: ' + column.table_name + '.' + column.column_name);
        }
      }
      if (actual.some(row => !expected.some(col => col.table_name === row.table_name && col.column_name === row.column_name))) {
        throw Error('Unexpected catalog columns; automatic adoption refused');
      }
    };
    await checkColumns(true);
    const currentVector = (await columns('public')).find(c => c.table_name === 'KnowledgeChunk' && c.column_name === 'searchVector');
    if (!currentVector || currentVector.udt_name !== 'tsvector') throw Error('Unexpected full-text column type');
    if (currentVector.is_generated === 'NEVER') {
      // The table is locked and was verified empty above. Replace the empty plain
      // column without leaving extra fields that would fail startup's Prisma diff.
      await db.query('ALTER TABLE "KnowledgeChunk" DROP COLUMN "searchVector"');
      const expression = expected.find(c => c.table_name === 'KnowledgeChunk' && c.column_name === 'searchVector').generation_expression;
      await db.query('ALTER TABLE "KnowledgeChunk" ADD COLUMN "searchVector" tsvector GENERATED ALWAYS AS (' + expression + ') STORED');
    }
    await checkColumns(false);
    const constraints = async schema => (await db.query(`SELECT c.conname,t.relname AS tablename,
      pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
      WHERE c.connamespace=$1::regnamespace AND t.relname=ANY($2::text[])`, [schema, tables])).rows;
    const present = await constraints('public');
    for (const constraint of await constraints(shadow)) {
      const existing = present.find(row => row.conname === constraint.conname);
      if (existing && normalize(existing.definition) !== normalize(constraint.definition)) throw Error('Constraint differs from canonical schema');
      if (!existing) await db.query('ALTER TABLE ' + qi(constraint.tablename) + ' ADD CONSTRAINT ' +
        qi(constraint.conname) + ' ' + normalize(constraint.definition));
    }
    const indexes = async schema => (await db.query(`SELECT indexname,indexdef FROM pg_indexes
      WHERE schemaname=$1 AND tablename=ANY($2::text[])`, [schema, tables])).rows;
    const presentIndexes = await indexes('public');
    for (const index of await indexes(shadow)) {
      const existing = presentIndexes.find(row => row.indexname === index.indexname);
      if (existing && normalize(existing.indexdef) !== normalize(index.indexdef)) throw Error('Index differs from canonical schema');
      if (!existing) await db.query(normalize(index.indexdef));
    }
    await db.query('DROP SCHEMA ' + qi(shadow) + ' CASCADE');
    await db.query(sql.slice(sql.indexOf('-- Knowledge publishing')));
    await db.query('INSERT INTO "HelpSchemaVersion" (id,checksum) VALUES($1,$2)', [id, checksum]);
    await db.query('COMMIT');
    console.log(JSON.stringify({ ok: true, action: 'adopted-empty-catalog', migration: id,
      canonicalColumnsAndIndexesVerified: true, emptyPlainVectorReplaced: true }));
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    await db.end();
  }
}
main().catch(error => { console.error('[knowledge schema adoption]', error.code || error.message); process.exitCode = 1; });
