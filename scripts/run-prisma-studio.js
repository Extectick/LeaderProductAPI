/* Helper to start Prisma Studio on any shell */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const root = path.resolve(__dirname, '..');
const envCandidates = ['.env.dev', '.env'];
const envPath = envCandidates
  .map((name) => path.resolve(root, name))
  .find((candidate) => fs.existsSync(candidate));

if (!envPath) {
  console.error('Не найден .env.dev или .env');
  process.exit(1);
}

const result = dotenv.config({ path: envPath, quiet: true });
if (result.error) {
  console.error(`Не удалось загрузить ${path.basename(envPath)}:`, result.error);
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

const studioDbUrl = new URL(dbUrl);
// Prisma Studio uses postgres-js, which sends unknown query params as
// PostgreSQL startup parameters. `uselibpqcompat` is accepted by pg/libpq
// clients in this project, but PostgreSQL rejects it from postgres-js.
studioDbUrl.searchParams.delete('uselibpqcompat');

const tmpDir = path.resolve(root, '.tmp-prisma-studio');
fs.mkdirSync(tmpDir, { recursive: true });

const schemaFiles = [
  'prisma/schema.core.prisma',
  'prisma/schema.onec.prisma',
  'prisma/schema.sync.prisma',
];

const schemaContent = schemaFiles
  .map((relativePath) => {
    const absolutePath = path.resolve(root, relativePath);
    if (!fs.existsSync(absolutePath)) {
      console.error(`Не найден Prisma schema-файл: ${relativePath}`);
      process.exit(1);
    }
    return `// ---- ${relativePath} ----\n${fs.readFileSync(absolutePath, 'utf8')}`;
  })
  .join('\n\n');

const studioSchemaPath = path.resolve(tmpDir, 'schema.prisma');
const studioConfigPath = path.resolve(tmpDir, 'prisma.config.js');
fs.writeFileSync(studioSchemaPath, schemaContent);
fs.writeFileSync(
  studioConfigPath,
  `const { defineConfig } = require('prisma/config');\n\nmodule.exports = defineConfig({\n  schema: './schema.prisma',\n  datasource: {\n    provider: 'postgresql',\n    url: process.env.DATABASE_URL,\n  },\n});\n`,
);

const port = process.env.PRISMA_STUDIO_PORT || '5556';
const isWin = process.platform === 'win32';
const command = isWin ? 'cmd.exe' : 'npx';
const args = isWin
  ? ['/c', 'npx', 'prisma', 'studio', '--config', studioConfigPath, '--port', port, '--browser', 'none']
  : ['prisma', 'studio', '--config', studioConfigPath, '--port', port, '--browser', 'none'];

const child = spawn(command, args, {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: studioDbUrl.toString() },
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
