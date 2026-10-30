// Creates a fresh local database; never resets or drops an existing database.
const { Client } = require('pg');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
async function main() {
  const database = `help_production_qa_${Date.now()}_${process.pid}`;
  const admin = new Client({connectionString:'postgresql://postgres:postgres@127.0.0.1:54329/postgres'});
  await admin.connect();
  try { await admin.query(`CREATE DATABASE "${database}"`); } finally { await admin.end(); }
  const env = {...process.env,NODE_ENV:'test',DATABASE_URL:`postgresql://postgres:postgres@127.0.0.1:54329/${database}`,HELP_PRODUCTION_QA_DATABASE:database,REDIS_DISABLE:'1',HELP_ENABLED:'1',HELP_AI_PROVIDER:'simulator',HELP_AI_ENABLED:'true',HELP_AI_SIMULATOR_DURATION_MS:'500',ACCESS_TOKEN_SECRET:'help_production_qa_only'};
  console.log(`Isolated database: ${database} (retained after run).`);
  const run=(script,args)=>{
    const result=spawnSync(process.execPath,[path.resolve(script),...args],{env,stdio:'inherit'});
    if(result.error)throw result.error;
    if(result.status!==0)throw new Error(`${script} failed: ${result.status}`);
  };
  run('node_modules/prisma/build/index.js',['db','push','--schema','prisma','--config','prisma.config.js']);
  run('node_modules/jest/bin/jest.js',['--config','help.production.integration.config.cjs','--runInBand']);
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});

