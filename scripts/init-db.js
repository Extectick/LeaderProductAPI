const { execSync } = require('child_process');
const { Pool } = require('pg');

function run(cmd) {
  execSync(cmd, { stdio: 'inherit' });
}

async function reconcileAppealsAnalyticsRbac(pool) {
  const permissions = [
    {
      name: 'view_appeals_analytics',
      displayName: 'Просмотр аналитики обращений',
      description: 'Разрешает просматривать аналитику по обращениям и исполнителям.',
      groupKey: 'service_appeals',
    },
    {
      name: 'manage_appeal_labor',
      displayName: 'Управление трудозатратами обращения',
      description:
        'Разрешает проставлять часы и статусы оплаты по исполнителям обращения.',
      groupKey: 'service_appeals',
    },
  ];

  for (const perm of permissions) {
    await pool.query(
      `
      WITH target_group AS (
        SELECT "id"
        FROM "PermissionGroup"
        WHERE "key" = $4
        LIMIT 1
      ),
      fallback_group AS (
        SELECT "id"
        FROM "PermissionGroup"
        WHERE "key" = 'core'
        LIMIT 1
      ),
      chosen_group AS (
        SELECT COALESCE(
          (SELECT "id" FROM target_group),
          (SELECT "id" FROM fallback_group)
        ) AS "id"
      )
      INSERT INTO "Permission" ("name", "displayName", "description", "groupId")
      VALUES ($1, $2, $3, (SELECT "id" FROM chosen_group))
      ON CONFLICT ("name") DO UPDATE
      SET
        "displayName" = EXCLUDED."displayName",
        "description" = EXCLUDED."description",
        "groupId" = COALESCE("Permission"."groupId", EXCLUDED."groupId")
      `,
      [perm.name, perm.displayName, perm.description, perm.groupKey]
    );
  }

  await pool.query(
    `
    INSERT INTO "RolePermissions" ("roleId", "permissionId")
    SELECT r."id", p."id"
    FROM "Role" r
    JOIN "Permission" p ON p."name" = ANY($2::text[])
    WHERE r."name" = ANY($1::text[])
    ON CONFLICT ("roleId", "permissionId") DO NOTHING
    `,
    [['department_manager', 'admin'], permissions.map((perm) => perm.name)]
  );
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

  async function tableHasRows(tableName) {
    try {
      const res = await pool.query(`SELECT EXISTS (SELECT 1 FROM "${tableName}" LIMIT 1) AS present;`);
      return !!res.rows?.[0]?.present;
    } catch (error) {
      // Table might not exist yet (e.g. partially initialized DB).
      if (error && error.code === '42P01') return false;
      throw error;
    }
  }

  try {
    if (!autoSeed) {
      console.log('[init] auto seed disabled (DB_AUTO_SEED=0)');
    } else {
      const [hasRoles, hasServices] = await Promise.all([
        tableHasRows('Role'),
        tableHasRows('Service'),
      ]);

      if (!hasRoles || !hasServices) {
        const reasons = [];
        if (!hasRoles) reasons.push('roles empty');
        if (!hasServices) reasons.push('services empty');
        console.log(`[init] seed required (${reasons.join(', ')}) -> running seed`);
        run('node dist/prisma/seed.js');
      } else {
        console.log('[init] seed skipped (roles and services already exist)');
      }
    }

    try {
      await reconcileAppealsAnalyticsRbac(pool);
      console.log('[init] RBAC reconcile applied for appeals analytics permissions');
    } catch (error) {
      const code = error && error.code;
      // If schema is not ready yet, do not block app start.
      if (code === '42P01' || code === '42703') {
        console.warn('[init] RBAC reconcile skipped: schema objects are not ready yet');
      } else {
        throw error;
      }
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((e) => {
  console.error('[init] failed:', e?.message || e);
  process.exit(1);
});
