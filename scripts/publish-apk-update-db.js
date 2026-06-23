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
  const candidates = ['.env', '.env.dev', '.env.production'];
  for (const name of candidates) {
    const filePath = path.resolve(process.cwd(), name);
    if (fs.existsSync(filePath)) {
      dotenv.config({ path: filePath, override: false, quiet: true });
    }
  }
}

function asBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const raw = String(value).trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function asInt(value, label) {
  const num = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(num)) throw new Error(`Invalid ${label}`);
  return num;
}

function asOptionalInt(value, label) {
  if (value === undefined || value === null || value === '') return null;
  return asInt(value, label);
}

function parsePlatform(raw) {
  const value = String(raw || 'android').trim().toLowerCase();
  if (value === 'android') return 'ANDROID';
  if (value === 'ios') return 'IOS';
  if (value === 'ANDROID' || value === 'IOS') return value;
  throw new Error('platform must be android or ios');
}

function resolveDatabaseUrl(args) {
  const explicit =
    args['database-url'] ||
    process.env.UPDATE_PUBLISH_DATABASE_URL ||
    process.env.DATABASE_URL;

  if (!explicit) {
    throw new Error('Missing database URL. Set UPDATE_PUBLISH_DATABASE_URL or DATABASE_URL.');
  }

  if (process.platform === 'win32' && !args['database-url'] && !process.env.UPDATE_PUBLISH_DATABASE_URL) {
    return String(explicit).replace('@postgres:', '@127.0.0.1:');
  }

  return String(explicit);
}

function buildUpdatePayload(metadata, args) {
  const channel = String(args.channel || metadata.channel || 'dev').trim();
  const versionCode = asInt(args.versionCode ?? metadata.versionCode, 'versionCode');
  const minSupportedVersionCode = asInt(
    args.minSupportedVersionCode ?? metadata.minSupportedVersionCode ?? metadata.versionCode,
    'minSupportedVersionCode'
  );

  if (minSupportedVersionCode > versionCode) {
    throw new Error('minSupportedVersionCode must not be greater than versionCode');
  }

  const payload = {
    platform: parsePlatform(args.platform || metadata.platform || 'android'),
    channel,
    versionCode,
    versionName: String(args.versionName ?? metadata.versionName ?? '').trim(),
    minSupportedVersionCode,
    isMandatory: asBool(args.isMandatory ?? metadata.isMandatory, false),
    rolloutPercent: Math.max(0, Math.min(100, asInt(args.rolloutPercent ?? metadata.rolloutPercent ?? 100, 'rolloutPercent'))),
    isActive: asBool(args.isActive ?? metadata.isActive, true),
    releaseNotes: String(args.releaseNotes ?? metadata.releaseNotes ?? '').trim() || null,
    storeUrl: metadata.storeUrl ? String(metadata.storeUrl).trim() : null,
    apkKey: metadata.apkKey ? String(metadata.apkKey).trim() : null,
    fileSize: asOptionalInt(metadata.fileSize, 'fileSize'),
    checksum: metadata.checksum || metadata.sha256 || null,
    checksumMd5: metadata.checksumMd5 || metadata.md5 || null,
  };

  if (!payload.versionName) throw new Error('Missing versionName');
  if (!payload.apkKey && !payload.storeUrl) throw new Error('Metadata must contain apkKey or storeUrl');

  return payload;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const metadataPath = args._[0] || args.metadata;
  if (!metadataPath) {
    throw new Error('Usage: npm run updates:publish-apk-db -- <release-metadata.json> [--dry-run]');
  }

  loadEnv();

  const metadata = JSON.parse(fs.readFileSync(path.resolve(metadataPath), 'utf8'));
  const payload = buildUpdatePayload(metadata, args);
  const databaseUrl = resolveDatabaseUrl(args);

  console.log('Publishing AppUpdate to database:');
  console.log(JSON.stringify({ ...payload, databaseUrl: databaseUrl.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@') }, null, 2));

  if (args['dry-run'] === 'true') {
    console.log('Dry run: not writing database.');
    return;
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    const saved = await prisma.appUpdate.upsert({
      where: {
        platform_channel_versionCode: {
          platform: payload.platform,
          channel: payload.channel,
          versionCode: payload.versionCode,
        },
      },
      create: payload,
      update: payload,
    });

    console.log('AppUpdate saved:');
    console.log(JSON.stringify({
      id: saved.id,
      platform: saved.platform,
      channel: saved.channel,
      versionCode: saved.versionCode,
      versionName: saved.versionName,
      isActive: saved.isActive,
      updatedAt: saved.updatedAt,
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
