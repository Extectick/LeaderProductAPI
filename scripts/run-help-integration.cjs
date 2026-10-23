// Dedicated additive QA database. Deliberately no shared setup, reset, drop or down -v.
const { Client } = require('pg');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

async function main() {
  const database = `help_qa_${Date.now()}_${process.pid}`;
  const adminUrl = 'postgresql://postgres:postgres@127.0.0.1:54329/postgres';
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try { await admin.query(`CREATE DATABASE "${database}"`); } finally { await admin.end(); }
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:54329/${database}`,
    HELP_QA_DATABASE: database,
    ACCESS_TOKEN_SECRET: 'help_isolated_test_only',
    REDIS_DISABLE: '1',
    HELP_ENABLED: '1',
    S3_ENDPOINT: 'http://127.0.0.1:9009',
    S3_PRESIGN_ENDPOINT: 'http://127.0.0.1:9009',
    S3_BUCKET: 'help-private-test',
    S3_REGION: 'us-east-1',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    S3_ENV_PREFIX: 'help-qa',
    // Exercise the dedicated Help configuration, without inheriting machine secrets.
    HELP_S3_ENDPOINT: 'http://127.0.0.1:9009',
    HELP_S3_REGION: 'us-east-1',
    HELP_S3_ACCESS_KEY: 'minioadmin',
    HELP_S3_SECRET_KEY: 'minioadmin',
    // Exercise existing private bucket reuse; dedicated override is unit-tested.
    HELP_S3_BUCKET: '',
  };
  console.log(`Isolated Help QA database: ${database}. Retained after execution; no database is reset or deleted.`);
  const run = (script, args) => {
    // AWS SDK uses dynamic imports; Jest's VM requires this Node flag for real S3 IO.
    const runtimeArgs = script.includes('/jest/') ? ['--experimental-vm-modules'] : [];
    const result = spawnSync(process.execPath, [...runtimeArgs, path.resolve(script), ...args], { env, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${script} exited ${result.status}`);
  };
  run('node_modules/prisma/build/index.js', ['db', 'push', '--schema', 'prisma', '--config', 'prisma.config.js']);
  run('node_modules/jest/bin/jest.js', ['--config', 'help.integration.config.cjs', '--runInBand']);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
