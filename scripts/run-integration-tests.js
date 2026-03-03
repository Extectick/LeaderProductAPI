const { execFileSync } = require('node:child_process');

const COMPOSE_FILE = 'docker-compose.test.yml';
const COMPOSE_PROJECT = 'leaderproductapi-test';
const CONTAINERS = ['leader_api_test_postgres', 'leader_api_test_redis'];
const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_POLL_MS = 2_000;

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    stdio: 'inherit',
    cwd: process.cwd(),
    ...options,
  });
}

function runNpmScript(args) {
  if (process.platform === 'win32') {
    return execFileSync('npm.cmd', args, {
      stdio: 'inherit',
      cwd: process.cwd(),
      shell: true,
    });
  }

  return execFileSync('npm', args, {
    stdio: 'inherit',
    cwd: process.cwd(),
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getHealthStatus(containerName) {
  try {
    const output = execFileSync(
      'docker',
      ['inspect', `--format={{.State.Health.Status}}`, containerName],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    return output.trim();
  } catch (_error) {
    return '';
  }
}

async function waitForHealthy(containerName) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < HEALTH_TIMEOUT_MS) {
    const status = getHealthStatus(containerName);
    if (status === 'healthy') {
      return;
    }
    await sleep(HEALTH_POLL_MS);
  }

  throw new Error(
    `Test container ${containerName} did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s.`
  );
}

async function main() {
  run('docker', [
    'compose',
    '-p',
    COMPOSE_PROJECT,
    '-f',
    COMPOSE_FILE,
    'up',
    '-d',
    'test-postgres',
    'test-redis',
    'test-minio',
  ]);

  try {
    for (const containerName of CONTAINERS) {
      await waitForHealthy(containerName);
    }
    runNpmScript(['run', 'test:integration']);
  } finally {
    try {
      run('docker', ['compose', '-p', COMPOSE_PROJECT, '-f', COMPOSE_FILE, 'down', '-v']);
    } catch (error) {
      console.error('Failed to stop test containers cleanly.');
      throw error;
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
