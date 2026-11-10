'use strict';
// Run only on a disposable DB restored from the production SCHEMA-ONLY dump.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { execute, guard, migrations, tablesFor } = require('./apply-production-help-schema.cjs');
const env = { DATABASE_URL: 'postgresql://postgres@127.0.0.1/LeaderAPI', NODE_ENV: 'production',
  HELP_MIGRATION_TARGET: 'prod', HELP_MIGRATION_DATABASE_CONFIRM: 'LeaderAPI', DB_ACCEPT_DATA_LOSS: '0' };
test('production target and explicit confirmation fail closed', () => {
  guard(env);
  for (const patch of [{NODE_ENV:'development'}, {HELP_MIGRATION_TARGET:'dev'},
    {HELP_MIGRATION_DATABASE_CONFIRM:''}, {DB_ACCEPT_DATA_LOSS:'1'},
    {DATABASE_URL:'postgresql://postgres@127.0.0.1/LeaderAPI_dev'},
    {DATABASE_URL:'postgresql://postgres@127.0.0.1/LeaderAPI?schema=private'}]) {
    assert.throws(() => guard({...env,...patch}));
  }
  assert.equal(migrations().length,9);
  assert.equal(tablesFor(migrations()).length,23);
});
test('atomic rollout on isolated production schema, idempotency and drift rejection', {
  skip: process.env.PROD_SCHEMA_SYNTHETIC_TEST !== 'yes',
}, async () => {
  // This test never accepts a remote URL; invoke inside the isolated test network namespace.
  const db = new Client({connectionString:env.DATABASE_URL}); await db.connect();
  const run = mode => execute(db,{env,mode});
  const helpTables = async () => Number((await db.query(`SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename=ANY($1::text[])`,[tablesFor(migrations())])).rows[0].count);
  try {
    assert.equal(await helpTables(),0,'Use a fresh synthetic schema');
    const baseBefore = (await db.query(`SELECT c.relname,a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull
      FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`)).rows;
    assert.equal((await run('plan')).action,'pending'); assert.equal(await helpTables(),0);
    await assert.rejects(run('verify'),/not been applied/);
    // A late failure must roll back all preceding DDL and registration inserts.
    await db.query('ALTER TABLE "Permission" RENAME COLUMN "groupId" TO "testMissingGroupId"');
    await assert.rejects(run('apply'));
    assert.equal(await helpTables(),0);
    await db.query('ALTER TABLE "Permission" RENAME COLUMN "testMissingGroupId" TO "groupId"');
    assert.equal((await run('apply')).action,'applied');
    assert.equal(await helpTables(),23);
    assert.equal((await run('apply')).action,'verified');
    assert.equal((await run('verify')).action,'verified');
    assert.equal((await run('plan')).action,'verified');
    const baseAfter = (await db.query(`SELECT c.relname,a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull
      FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped AND NOT c.relname=ANY($1::text[])
      ORDER BY c.relname,a.attnum`,[tablesFor(migrations())])).rows;
    assert.deepEqual(baseAfter,baseBefore,'Pre-existing production schema must be unchanged');
    assert.equal(Number((await db.query('SELECT count(*) FROM "RolePermissions"')).rows[0].count),0);
    await db.query('UPDATE "HelpSchemaVersion" SET checksum=$1 WHERE id=$2',['invalid',migrations()[0].id]);
    await assert.rejects(run('verify'),/checksum/);
    await db.query('UPDATE "HelpSchemaVersion" SET checksum=$1 WHERE id=$2',[migrations()[0].sha256,migrations()[0].id]);
    await db.query('ALTER TABLE "KnowledgeDocument" ALTER COLUMN "allEmployees" SET DEFAULT true');
    await assert.rejects(run('verify'),/drift: columns/);
    await db.query('ALTER TABLE "KnowledgeDocument" ALTER COLUMN "allEmployees" SET DEFAULT false');
    await db.query('DROP INDEX "HelpEvent_messageId_type_idx"');
    await assert.rejects(run('verify'),/drift: indexes/);
    await db.query('CREATE INDEX "HelpEvent_messageId_type_idx" ON "HelpEvent"("messageId","type")');
    await db.query('ALTER TABLE "KnowledgeDocument" DROP CONSTRAINT "KnowledgeDocument_publication_check"');
    await assert.rejects(run('verify'),/drift: constraints/);
    await db.query(`ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_publication_check" CHECK ("publishedRevision" IS NULL OR ("publishedRevision"="currentRevision" AND "section"='COMPANY' AND "deletedAt" IS NULL))`);
    assert.equal((await run('verify')).action,'verified');
  } finally { await db.end(); }
});
