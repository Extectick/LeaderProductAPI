/* Helper to start Prisma Studio with .env.dev on any shell */
const { spawn } = require('child_process');
const path = require('path');
const dotenv = require('dotenv');

const result = dotenv.config({ path: path.resolve(__dirname, '..', '.env.dev') });
if (result.error) {
  console.error('Не удалось загрузить .env.dev:', result.error);
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL не установлен после загрузки .env.dev');
  process.exit(1);
}

const dbUrl = (process.env.DATABASE_URL || '').trim();
if (!dbUrl) {
  console.error('DATABASE_URL пустой после trim()');
  process.exit(1);
}

const root = path.resolve(__dirname, '..');
const isWin = process.platform === 'win32';
const command = isWin ? 'cmd.exe' : 'npx';
const args = isWin
  ? ['/c', 'npx', 'prisma', 'studio', '--url', dbUrl]
  : ['prisma', 'studio', '--url', dbUrl];

const child = spawn(command, args, {
  stdio: 'inherit',
  env: process.env,
  cwd: root,
  shell: false,
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});

child.on('error', (err) => {
  console.error('Не удалось запустить Prisma Studio:', err.message || err);
  process.exit(1);
});
