const { defineConfig } = require('prisma/config');

// В config указываем datasource.url, чтобы prisma db push/format видели строку подключения
module.exports = defineConfig({
  schema: './prisma/schema.prisma',
  datasource: {
    provider: 'postgresql',
    url:
      process.env.DATABASE_URL ||
      'postgresql://postgres:postgres@localhost:5432/leader_test?schema=public',
  },
});
