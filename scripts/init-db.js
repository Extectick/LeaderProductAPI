const { execSync } = require('child_process');
const { Pool } = require('pg');

function run(cmd) {
  execSync(cmd, { stdio: 'inherit' });
}

async function main() {
  const initMode = process.env.DB_INIT_MODE || 'push'; // push | migrate
  const autoSeed = process.env.DB_AUTO_SEED !== '0';

  if (initMode === 'migrate') {
    console.log('[init] prisma migrate deploy...');
    run('npx prisma migrate deploy --schema ./prisma');
  } else {
    console.log('[init] prisma db push...');
    run('npx prisma db push --schema ./prisma');
  }

  if (!autoSeed) {
    console.log('[init] auto seed disabled (DB_AUTO_SEED=0)');
    return;
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
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
