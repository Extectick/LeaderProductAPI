const { execSync } = require('child_process');
const { Pool } = require('pg');

function run(cmd) {
  execSync(cmd, { stdio: 'inherit' });
}

async function main() {
  const initMode = process.env.DB_INIT_MODE || 'push'; // push | migrate
  const autoSeed = process.env.DB_AUTO_SEED !== '0';
  const acceptDataLoss = process.env.DB_ACCEPT_DATA_LOSS !== '0';

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  async function resolveColumnName(tableName, columnName) {
    const result = await pool.query(
      `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND lower(table_name) = lower($1)
          AND lower(column_name) = lower($2)
        LIMIT 1
      `,
      [tableName, columnName]
    );
    return result.rows[0]?.column_name || null;
  }

  async function findDuplicateValues(columnName) {
    const resolvedColumnName = await resolveColumnName('User', columnName);
    if (!resolvedColumnName) return [];

    const safeColumn = resolvedColumnName.replace(/"/g, '""');
    try {
      const result = await pool.query(
        `
          SELECT "${safeColumn}"::text AS value, COUNT(*)::int AS cnt
          FROM "User"
          WHERE "${safeColumn}" IS NOT NULL
          GROUP BY "${safeColumn}"
          HAVING COUNT(*) > 1
          ORDER BY COUNT(*) DESC
          LIMIT 10
        `
      );
      return result.rows;
    } catch (error) {
      if (error && error.code === '42703') {
        return [];
      }
      throw error;
    }
  }

  async function ensureNoUniqueConflicts() {
    const [phoneDupes, tgDupes] = await Promise.all([
      findDuplicateValues('phone'),
      findDuplicateValues('telegramId'),
    ]);

    if (!phoneDupes.length && !tgDupes.length) return;

    const lines = ['[init] unique precheck failed: duplicates detected'];
    if (phoneDupes.length) {
      lines.push('[init] duplicate phones:');
      phoneDupes.forEach((r) => lines.push(`  - ${r.value}: ${r.cnt}`));
    }
    if (tgDupes.length) {
      lines.push('[init] duplicate telegramId:');
      tgDupes.forEach((r) => lines.push(`  - ${r.value}: ${r.cnt}`));
    }
    throw new Error(lines.join('\n'));
  }

  if (initMode === 'migrate') {
    console.log('[init] prisma migrate deploy...');
    run('npx prisma migrate deploy --schema ./prisma');
  } else {
    await ensureNoUniqueConflicts();
    console.log('[init] prisma db push...');
    const pushCmd = acceptDataLoss
      ? 'npx prisma db push --schema ./prisma --accept-data-loss'
      : 'npx prisma db push --schema ./prisma';
    run(pushCmd);
  }

  if (!autoSeed) {
    console.log('[init] auto seed disabled (DB_AUTO_SEED=0)');
    await pool.end().catch(() => undefined);
    return;
  }

  try {
    const res = await pool.query('SELECT 1 FROM "Role" LIMIT 1;');
    if (!res.rows.length) {
      console.log('[init] empty DB detected -> running seed');
      run('node dist/prisma/seed.js');
    } else {
      console.log('[init] seed skipped (roles already exist)');
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((e) => {
  console.error('[init] failed:', e?.message || e);
  process.exit(1);
});
