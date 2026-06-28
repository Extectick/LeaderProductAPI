#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('@prisma/client');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) {
      args._.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = 'true';
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function loadEnv() {
  for (const name of ['.env', '.env.dev', '.env.production']) {
    const filePath = path.resolve(process.cwd(), name);
    if (fs.existsSync(filePath)) {
      dotenv.config({ path: filePath, override: false, quiet: true });
    }
  }
}

function resolveDatabaseUrl(args) {
  const explicit =
    args['database-url'] ||
    process.env.OTA_PUBLISH_DATABASE_URL ||
    process.env.UPDATE_PUBLISH_DATABASE_URL ||
    process.env.DATABASE_URL;

  if (!explicit) throw new Error('Missing database URL');
  if (process.platform === 'win32' && !args['database-url'] && !process.env.OTA_PUBLISH_DATABASE_URL && !process.env.UPDATE_PUBLISH_DATABASE_URL) {
    return String(explicit).replace('@postgres:', '@127.0.0.1:');
  }
  return String(explicit);
}

function platform(value) {
  const normalized = String(value || 'android').toLowerCase();
  if (normalized === 'android') return 'ANDROID';
  if (normalized === 'ios') return 'IOS';
  if (normalized === 'ANDROID' || normalized === 'IOS') return normalized;
  throw new Error('platform must be android or ios');
}

function clean(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function metadataObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function parsePositiveInt(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('otaSequence must be a positive integer');
  }
  return Math.floor(parsed);
}

async function resolveOtaSequence(prisma, payload) {
  const existing = await prisma.appOtaUpdate.findUnique({
    where: { updateId: payload.updateId },
    select: { otaSequence: true },
  });
  if (payload.otaSequence) return payload.otaSequence;
  if (existing?.otaSequence) return existing.otaSequence;

  const aggregate = await prisma.appOtaUpdate.aggregate({
    where: {
      platform: payload.platform,
      channel: payload.channel,
      runtimeVersion: payload.runtimeVersion,
    },
    _max: { otaSequence: true },
    _count: { _all: true },
  });

  return (aggregate._max.otaSequence ?? aggregate._count._all) + 1;
}

function buildDisplayVersion(payload, otaSequence) {
  if (payload.displayVersion) return payload.displayVersion;

  const baseVersionName =
    clean(payload.metadata.baseVersionName) ||
    clean(payload.metadata.nativeVersionName) ||
    payload.runtimeVersion;

  return `${baseVersionName}.${otaSequence}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const metadataPath = args._[0] || args.metadata;
  if (!metadataPath) {
    throw new Error('Usage: npm run ota:publish-db -- <ota-metadata.json>');
  }

  loadEnv();

  const metadata = JSON.parse(fs.readFileSync(path.resolve(metadataPath), 'utf8'));
  const payload = {
    platform: platform(metadata.platform),
    channel: String(metadata.channel || 'dev'),
    runtimeVersion: String(metadata.runtimeVersion || ''),
    updateId: String(metadata.updateId || ''),
    manifestKey: metadata.manifestKey || null,
    launchAssetKey: String(metadata.launchAssetKey || ''),
    launchAssetHash: metadata.launchAssetHash || null,
    launchAssetType: metadata.launchAssetType || 'application/javascript',
    assets: metadata.assets || [],
    metadata: metadataObject(metadata.metadata),
    otaSequence: parsePositiveInt(args.otaSequence || metadata.otaSequence),
    displayVersion: clean(args.displayVersion || metadata.displayVersion),
    isActive: metadata.isActive !== false,
    rolloutPercent: Number(metadata.rolloutPercent ?? 100),
    commitSha: metadata.commitSha || null,
    releaseNotes: metadata.releaseNotes || null,
  };

  if (!payload.runtimeVersion) throw new Error('Missing runtimeVersion');
  if (!payload.updateId) throw new Error('Missing updateId');
  if (!payload.launchAssetKey) throw new Error('Missing launchAssetKey');

  const databaseUrl = resolveDatabaseUrl(args);
  console.log('Publishing OTA update to database:');
  console.log(JSON.stringify({ ...payload, databaseUrl: databaseUrl.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@') }, null, 2));

  if (args.dryRun === 'true' || args['dry-run'] === 'true') {
    console.log('Dry run: not writing database.');
    return;
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    const otaSequence = await resolveOtaSequence(prisma, payload);
    const displayVersion = buildDisplayVersion(payload, otaSequence);
    payload.otaSequence = otaSequence;
    payload.displayVersion = displayVersion;
    payload.metadata = {
      ...payload.metadata,
      otaSequence,
      displayVersion,
    };

    console.log('Resolved OTA display version:');
    console.log(JSON.stringify({ otaSequence, displayVersion }, null, 2));

    const saved = await prisma.appOtaUpdate.upsert({
      where: { updateId: payload.updateId },
      create: payload,
      update: payload,
    });
    console.log('AppOtaUpdate saved:');
    console.log(JSON.stringify({
      id: saved.id,
      updateId: saved.updateId,
      platform: saved.platform,
      channel: saved.channel,
      runtimeVersion: saved.runtimeVersion,
      otaSequence: saved.otaSequence,
      displayVersion: saved.displayVersion,
      isActive: saved.isActive,
    }, null, 2));
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
