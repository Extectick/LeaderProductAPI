import { readFileSync } from 'node:fs';
import { z } from 'zod';
import prisma from '../prisma/client';
import { importOnecDirectory } from '../modules/onec-personal/service';

async function main() {
  const [baseKey, file] = process.argv.slice(2);
  if (!baseKey || !file) throw new Error('Usage: importOnecDirectory BASE_KEY PRIVATE_JSON_FILE');
  const entries = z.array(z.object({ guid: z.uuid(), ibGuid: z.uuid(), login: z.string().min(1).max(128).refine(v => !/[:\r\n\0]/.test(v)), displayName: z.string().trim().max(256).optional() }).strict()).max(10000).parse(JSON.parse(readFileSync(file, 'utf8')));
  if (new Set(entries.map(e => e.guid.toLowerCase())).size !== entries.length) throw new Error('Duplicate directory GUID');
  console.log(JSON.stringify(await importOnecDirectory(baseKey, entries)));
}
main().catch(() => { console.error('ONEC_DIRECTORY_IMPORT_FAILED'); process.exitCode = 1; }).finally(() => prisma.$disconnect());
