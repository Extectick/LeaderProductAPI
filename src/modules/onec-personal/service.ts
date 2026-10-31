import type { Prisma } from '@prisma/client';
import prisma from '../../prisma/client';
import { baseBinding, OnecBase, onecBase, onecBases, OnecPersonalError } from './config';
import { seal, unseal } from './vault';
import { mcpOperation } from './mcp';

type DB = Prisma.TransactionClient;
const aad = (b: OnecBase, userId: number, guid: string | null, part: string) => JSON.stringify(['onec-user-v1', baseBinding(b), userId, guid, part]);
export const directoryAad = (b: OnecBase, guid: string) => JSON.stringify(['onec-directory-v1', baseBinding(b), guid]);
export async function onecActor(userId: number, db: DB | typeof prisma = prisma) {
  const u = await db.user.findUnique({ where: { id: userId }, select: { isActive: true, deletedAt: true, profileStatus: true, employeeProfile: { select: { status: true, onecUserGuid: true } } } });
  if (!u || !u.isActive || u.deletedAt || u.profileStatus === 'BLOCKED' || !u.employeeProfile || u.employeeProfile.status === 'BLOCKED') throw new OnecPersonalError('ONEC_FORBIDDEN', 403);
  return u.employeeProfile;
}
async function locked<T>(userId: number, fn: (db: DB) => Promise<T>) {
  return prisma.$transaction(async db => { await db.$executeRaw`SELECT pg_advisory_xact_lock(190154, ${userId}::int)`; return fn(db); });
}
/** Resolve GUID hints only for the configured legacy base, never by name or across databases. */
async function ensure(db: DB, userId: number, base: OnecBase) {
  const employee = await onecActor(userId, db);
  const guid = base.legacyGuidBinding ? employee.onecUserGuid?.toLowerCase() || null : null;
  let row = await db.onecConnection.upsert({ where: { userId_baseKey: { userId, baseKey: base.key } }, create: { userId, baseKey: base.key, boundGuid: guid }, update: {} });
  if (row.boundGuid !== guid) row = await db.onecConnection.update({ where: { userId_baseKey: { userId, baseKey: base.key } }, data: { boundGuid: guid, loginCipher: null, displayNameCipher: null, passwordCipher: null, verifiedAt: null, loginSource: 'manual', revision: { increment: 1 } } });
  const directory = guid ? await db.onecDirectoryEntry.findUnique({ where: { baseKey_guid: { baseKey: base.key, guid } } }) : null;
  if (directory) {
    const login = unseal(directory.loginCipher, directoryAad(base, guid!));
    const displayName = directory.displayNameCipher ? unseal(directory.displayNameCipher, directoryAad(base, guid!) + ':display-name') : null;
    let previousName: string | null = null;
    try { previousName = row.displayNameCipher ? unseal(row.displayNameCipher, aad(base, userId, guid, 'display-name')) : null; } catch { /* replace invalid name from the authoritative directory */ }
    let same = false;
    try { same = !!row.loginCipher && unseal(row.loginCipher, aad(base, userId, guid, 'login')) === login; } catch { /* config/identity changed: require fresh authentication */ }
    if (!same || row.loginSource !== 'directory') row = await db.onecConnection.update({ where: { userId_baseKey: { userId, baseKey: base.key } }, data: {
      loginCipher: seal(login, aad(base, userId, guid, 'login')), loginSource: 'directory',
      ...(!same ? { passwordCipher: null, verifiedAt: null, revision: { increment: 1 } } : {}),
    } });
    if (displayName !== previousName) row = await db.onecConnection.update({ where: { userId_baseKey: { userId, baseKey: base.key } }, data: {
      displayNameCipher: displayName ? seal(displayName, aad(base, userId, guid, 'display-name')) : null,
    } });
  }
  return row;
}
function view(base: OnecBase, row: Awaited<ReturnType<typeof ensure>>) {
  let login = ''; let valid = true; let displayName: string | null = null;
  try { login = row.loginCipher ? unseal(row.loginCipher, aad(base, row.userId, row.boundGuid, 'login')) : ''; }
  catch (e) { if (e instanceof OnecPersonalError && e.code === 'ONEC_VAULT_UNAVAILABLE') throw e; valid = false; }
  if (row.displayNameCipher) displayName = unseal(row.displayNameCipher, aad(base, row.userId, row.boundGuid, 'display-name'));
  return { baseKey: base.key, label: base.label, login, displayName, loginLocked: row.loginSource === 'directory' && !!login,
    mapped: !!row.boundGuid, connected: valid && !!row.passwordCipher && !!row.verifiedAt, verifiedAt: valid ? row.verifiedAt?.toISOString() || null : null };
}
export async function listOnecConnections(userId: number) {
  await onecActor(userId);
  const bases = onecBases();
  return locked(userId, async db => Promise.all(bases.map(async b => view(b, await ensure(db, userId, b)))));
}
export async function connectOnec(userId: number, baseKey: string, suppliedLogin: string | undefined, password: string) {
  const base = onecBase(baseKey);
  const reservation = await locked(userId, async db => {
    const row = await ensure(db, userId, base), dto = view(base, row);
    const login = dto.loginLocked ? dto.login : (suppliedLogin ?? dto.login).trim();
    if (dto.loginLocked && suppliedLogin !== undefined && suppliedLogin.trim() !== dto.login) throw new OnecPersonalError('ONEC_LOGIN_MISMATCH', 403);
    if (!login || login.length > 128 || login.includes(':') || /[\r\n\0]/.test(login)) throw new OnecPersonalError('ONEC_LOGIN_REQUIRED', 400);
    const currentWindow = Date.now() - row.attemptWindow.getTime() < 15 * 60000;
    if (currentWindow && row.attempts >= 5) throw new OnecPersonalError('ONEC_RATE_LIMIT', 429);
    const reserved = await db.onecConnection.update({ where: { userId_baseKey: { userId, baseKey } }, data: {
      revision: { increment: 1 }, attempts: currentWindow ? { increment: 1 } : 1, ...(!currentWindow ? { attemptWindow: new Date() } : {}),
    } });
    return { row: reserved, login };
  });
  // Keep external I/O outside the DB lock. Disconnect or another save fences this attempt.
  await mcpOperation(base, reservation.login, password);
  return locked(userId, async db => {
    const row = await ensure(db, userId, base);
    if (row.revision !== reservation.row.revision) throw new OnecPersonalError('ONEC_CHANGED', 409);
    const saved = await db.onecConnection.update({ where: { userId_baseKey: { userId, baseKey } }, data: {
      loginCipher: seal(reservation.login, aad(base, userId, row.boundGuid, 'login')),
      passwordCipher: seal(password, aad(base, userId, row.boundGuid, 'password')), verifiedAt: new Date(),
      revision: { increment: 1 },
    } });
    return view(base, saved);
  });
}
export async function disconnectOnec(userId: number, baseKey: string) {
  const base = onecBase(baseKey);
  return locked(userId, async db => {
    await ensure(db, userId, base);
    const row = await db.onecConnection.update({ where: { userId_baseKey: { userId, baseKey } }, data: { passwordCipher: null, verifiedAt: null, revision: { increment: 1 } } });
    return view(base, row);
  });
}
export type OnecProof = { baseKey: string; revision: number; binding: string };
export async function validateOnecProofs(userId: number, proofs: OnecProof[], db: DB | typeof prisma = prisma) {
  const employee = await onecActor(userId, db);
  for (const proof of proofs) {
    const base = onecBase(proof.baseKey);
    const row = await db.onecConnection.findUnique({ where: { userId_baseKey: { userId, baseKey: base.key } } });
    const guid = base.legacyGuidBinding ? employee.onecUserGuid?.toLowerCase() || null : null;
    if (!row?.verifiedAt || !row.passwordCipher || row.revision !== proof.revision || row.boundGuid !== guid || proof.binding !== baseBinding(base)) throw new OnecPersonalError('ONEC_AUTH_REQUIRED');
  }
}
export async function userMcpCall(userId: number, baseKey: string, tool: string, args: unknown, signal?: AbortSignal) {
  const base = onecBase(baseKey), row = await locked(userId, db => ensure(db, userId, base));
  if (!row.loginCipher || !row.passwordCipher || !row.verifiedAt) throw new OnecPersonalError('ONEC_AUTH_REQUIRED');
  const proof = { baseKey, revision: row.revision, binding: baseBinding(base) };
  try {
    const value = await mcpOperation(base, unseal(row.loginCipher, aad(base, userId, row.boundGuid, 'login')),
      unseal(row.passwordCipher, aad(base, userId, row.boundGuid, 'password')), { tool, args }, signal);
    await validateOnecProofs(userId, [proof]);
    return { ...value, proof };
  } catch (e) {
    if (e instanceof OnecPersonalError && ['ONEC_AUTH_REQUIRED','ONEC_CREDENTIALS_INVALID'].includes(e.code)) {
      await prisma.onecConnection.updateMany({ where: { userId, baseKey, revision: row.revision }, data: { passwordCipher: null, verifiedAt: null, revision: { increment: 1 } } });
      throw new OnecPersonalError('ONEC_AUTH_REQUIRED');
    }
    throw e;
  }
}

/** Administrative importer only. Input is the minimal authoritative directory, never passwords. */
export async function importOnecDirectory(baseKey: string, entries: Array<{ guid: string; ibGuid: string; login: string; displayName?: string }>) {
  const base = onecBase(baseKey);
  for (const e of entries) {
    const guid = e.guid.toLowerCase();
    await prisma.onecDirectoryEntry.upsert({ where: { baseKey_guid: { baseKey, guid } },
      create: { baseKey, guid, ibGuid: e.ibGuid, loginCipher: seal(e.login, directoryAad(base, guid)), displayNameCipher: e.displayName ? seal(e.displayName, directoryAad(base, guid) + ':display-name') : null },
      update: { ibGuid: e.ibGuid, loginCipher: seal(e.login, directoryAad(base, guid)), ...(e.displayName !== undefined ? { displayNameCipher: e.displayName ? seal(e.displayName, directoryAad(base, guid) + ':display-name') : null } : {}) } });
  }
  let matched = 0;
  if (base.legacyGuidBinding) {
    const users = await prisma.employeeProfile.findMany({ where: { onecUserGuid: { not: null } }, select: { userId: true, onecUserGuid: true } });
    for (const u of users) if (entries.some(e => e.guid.toLowerCase() === u.onecUserGuid?.toLowerCase())) {
      try { await locked(u.userId, db => ensure(db, u.userId, base)); matched++; }
      catch (e) { if (!(e instanceof OnecPersonalError && e.code === 'ONEC_FORBIDDEN')) throw e; }
    }
  }
  return { directoryEntries: entries.length, eligibleUsersPrefilled: matched };
}
