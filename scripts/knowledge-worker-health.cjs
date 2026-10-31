const fs = require('node:fs');
try {
  const status = JSON.parse(fs.readFileSync('/tmp/knowledge-worker-health.json', 'utf8'));
  process.exit(Date.now() - status.at < 180000 ? 0 : 1);
} catch { process.exit(1); }
