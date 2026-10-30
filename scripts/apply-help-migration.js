/* Additive dev-only Help migration. No db push, resets, drops or unrelated migrations. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('pg');

const migrationId = '20261023070000_help_service';
const sql = fs.readFileSync(path.join(__dirname, '..', 'prisma', 'migrations', migrationId, 'migration.sql'), 'utf8');
const checksum = crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
const tables = [...sql.matchAll(/CREATE TABLE "(Help\w+)"/g)].map(match => match[1]);
const indexes = [...sql.matchAll(/CREATE (?:UNIQUE )?INDEX "(Help\w+)"/g)].map(match => match[1]);
const constraints = [...sql.matchAll(/(?:ADD )?CONSTRAINT "(Help\w+)"/g)].map(match => match[1]);
const previewMigrationId = '20261028120000_help_attachment_previews';
const previewSql = fs.readFileSync(path.join(__dirname, '..', 'prisma', 'migrations', previewMigrationId, 'migration.sql'), 'utf8');
const previewChecksum = crypto.createHash('sha256').update(previewSql.replace(/\r\n/g, '\n')).digest('hex');
const previewColumns = { width: ['integer', 'YES'], height: ['integer', 'YES'], thumbnailDataUri: ['text', 'YES'], position: ['integer', 'NO'] };
const previewConstraints = [...previewSql.matchAll(/ADD CONSTRAINT "(Help\w+)"/g)].map(match => match[1]);

async function validate(client) {
  const assistant=(await client.query(`SELECT to_regclass('"HelpAssistantJob"') AS present`)).rows[0].present;

  for (const table of tables) {
    const block = sql.match(new RegExp(`CREATE TABLE "${table}" \\(([\\s\\S]*?)\\n\\);`));
    if (!block) throw new Error(`Missing schema definition for ${table}`);
    const expected = [...block[1].matchAll(/^\s+"(\w+)"\s+(\w+)(?:\(\d+\))?(\s+NOT NULL)?/gm)];
    const { rows } = await client.query('SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1', [table]);
    const types = { SERIAL: 'integer', INTEGER: 'integer', TEXT: 'text', BOOLEAN: 'boolean', TIMESTAMP: 'timestamp without time zone' };
    for (const [, name, type, notNull] of expected) {
      const col = rows.find(row => row.column_name === name);
      if (!col || col.data_type !== types[type] || (notNull && col.is_nullable !== 'NO' && !(assistant && ((table==='HelpMessage'&&name==='authorId')||(table==='HelpEvent'&&name==='actorId'))))) throw new Error(`Schema verification failed: ${table}.${name}`);
    }
    const additional = rows.filter(row => !expected.some(column => column[1] === row.column_name));
    const assistantColumns=assistant&&table==='HelpMessage'&&additional.length===1&&additional[0].column_name==='assistantState'&&additional[0].data_type==='jsonb'&&additional[0].is_nullable==='YES';
    if (additional.length && !assistantColumns && (table !== 'HelpAttachment' || additional.length !== Object.keys(previewColumns).length
      || additional.some(row => !previewColumns[row.column_name] || row.data_type !== previewColumns[row.column_name][0] || row.is_nullable !== previewColumns[row.column_name][1]))) {
      throw new Error(`Unexpected columns in ${table}; refusing to overwrite another schema version`);
    }
  }
  const foundIndexes = await client.query('SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND indexname=ANY($1::text[])', [indexes]);
  if (foundIndexes.rowCount !== indexes.length) throw new Error('Help indexes are incomplete');
  const foundConstraints = await client.query('SELECT conname FROM pg_constraint WHERE connamespace=current_schema()::regnamespace AND conname=ANY($1::text[])', [constraints]);
  if (foundConstraints.rowCount !== constraints.length) throw new Error('Help constraints are incomplete');
  const registration = await client.query(`SELECT EXISTS(SELECT 1 FROM "Service" WHERE "key"='help') AS service, EXISTS(SELECT 1 FROM "Permission" WHERE "name"='manage_help') AS permission`);
  if (!registration.rows[0].service || !registration.rows[0].permission) throw new Error('Help catalog or permission registration is missing');
}

async function main() {
  if (process.env.HELP_MIGRATION_TARGET !== 'dev') throw new Error('Set HELP_MIGRATION_TARGET=dev for the explicitly approved development target');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const url = new URL(process.env.DATABASE_URL);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!database || process.env.HELP_MIGRATION_DATABASE_CONFIRM !== database) throw new Error('HELP_MIGRATION_DATABASE_CONFIRM must match the intended development database name');
  if (process.env.DB_ACCEPT_DATA_LOSS !== '0') throw new Error('DB_ACCEPT_DATA_LOSS must explicitly be 0');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='15s'");
    await client.query("SET LOCAL statement_timeout='60s'");
    await client.query('SELECT pg_advisory_xact_lock(181932, 0)');
    const present = await client.query('SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename=ANY($1::text[])', [tables]);
    if (present.rowCount && present.rowCount !== tables.length) throw new Error('Partial Help schema found; no changes applied');
    if (!present.rowCount) await client.query(sql);
    await validate(client);
    const previous = await client.query('SELECT checksum FROM "HelpSchemaVersion" WHERE id=$1', [migrationId]);
    if (previous.rows[0] && previous.rows[0].checksum !== checksum) throw new Error('Applied Help migration checksum differs; no changes applied');
    await client.query('INSERT INTO "HelpSchemaVersion" (id,checksum) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING', [migrationId,checksum]);
    let previews;
    if (process.argv.includes('--attachment-previews')) {
      const columns = await client.query('SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 AND column_name=ANY($2::text[])', ['HelpAttachment', Object.keys(previewColumns)]);
      if (!columns.rowCount) await client.query(previewSql);
      else if (columns.rowCount !== Object.keys(previewColumns).length || columns.rows.some(row => row.data_type !== previewColumns[row.column_name][0] || row.is_nullable !== previewColumns[row.column_name][1])) throw new Error('Partial or incompatible Help attachment preview schema');
      const checks = await client.query('SELECT conname FROM pg_constraint WHERE connamespace=current_schema()::regnamespace AND conname=ANY($1::text[])', [previewConstraints]);
      if (checks.rowCount !== previewConstraints.length) throw new Error('Help attachment preview constraints are incomplete');
      const saved = await client.query('SELECT checksum FROM "HelpSchemaVersion" WHERE id=$1', [previewMigrationId]);
      if (saved.rows[0] && saved.rows[0].checksum !== previewChecksum) throw new Error('Applied attachment preview migration checksum differs');
      await client.query('INSERT INTO "HelpSchemaVersion" (id,checksum) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING', [previewMigrationId,previewChecksum]);
      previews = { migration: previewMigrationId, action: columns.rowCount ? 'verified' : 'applied', checksum: previewChecksum };
    }
    await client.query('COMMIT');
    console.log(JSON.stringify({ ok: true, migration: migrationId, action: present.rowCount ? 'verified' : 'applied', tables: tables.length, checksum, ...(previews ? { previews } : {}) }));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { await client.end(); }
}
main().catch(error => { console.error('[help migration]', error.message); process.exitCode = 1; });
