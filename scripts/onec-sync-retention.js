// Run inside the API container: node scripts/onec-sync-retention.js [--apply].
// Dry-run is default. Take and verify a fresh backup before the first --apply.
const { runOnecSyncMaintenance } = require('../dist/services/onecSyncMaintenanceService');
const { prisma, pool } = require('../dist/prisma/client');
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--apply')) throw new Error('Only --apply is supported');
runOnecSyncMaintenance({ dryRun: !args.includes('--apply'), budgetMs: 45_000, maxRows: 200_000 })
  .then(result => console.log(JSON.stringify(result)))
  .catch(error => {
    if (error.progress) console.log(JSON.stringify({ ...error.progress, error: error.message }));
    else console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => { await prisma.$disconnect(); await pool.end(); });
