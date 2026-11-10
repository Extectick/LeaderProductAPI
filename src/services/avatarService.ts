import { createHash } from 'node:crypto';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import type { Response } from 'express';
import sharp from 'sharp';
import prisma from '../prisma/client';
import { s3, s3EnvPrefix } from '../storage/minio';
import type { AuthRequest } from '../middleware/auth';

export type AvatarProfileType = 'USER' | 'CLIENT' | 'SUPPLIER' | 'EMPLOYEE';
const types: AvatarProfileType[] = ['USER', 'CLIENT', 'SUPPLIER', 'EMPLOYEE'];
const MAX_BYTES = 8 * 1024 * 1024;
const NOT_FOUND = { message: 'Фотография не найдена' };

/** Only application-owned avatar objects. Never fetch an arbitrary URL or another
 * storage namespace (in particular private Help files). */
export function avatarObjectKey(value?: string | null): string | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  let key = raw;
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      const known = [process.env.S3_ENDPOINT, process.env.S3_PUBLIC_BASE, process.env.S3_PRESIGN_ENDPOINT,
        process.env.FILES_BASE_URL, process.env.DOMEN_URL].filter(Boolean).some(base => {
          try { return new URL(base!).origin === url.origin; } catch { return false; }
        });
      if (!known || url.username || url.password) return null;
      key = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      if (process.env.S3_BUCKET && key.startsWith(process.env.S3_BUCKET + '/')) key = key.slice(process.env.S3_BUCKET.length + 1);
      else if (key.startsWith('files/')) key = key.slice(6);
    } catch { return null; }
  }
  if (/[\\\u0000-\u001f?#]/.test(key) || key.split('/').some(part => !part || part === '.' || part === '..')) return null;
  return key.startsWith('avatars/') || key.startsWith(`${s3EnvPrefix}/images/avatars/`) ? key : null;
}

export function profileAvatarAsset(ownerId: number, type: AvatarProfileType, value?: string | null): {avatarAssetUrl?:string|null;avatarVersion?:string|null} {
  const key = avatarObjectKey(value);
  if (!key) return String(value || '').trim() ? {} : { avatarAssetUrl: null, avatarVersion: null };
  const version = createHash('sha256').update(JSON.stringify(['profile-avatar-v1', ownerId, type, key])).digest('hex');
  return { avatarAssetUrl: `/users/${ownerId}/avatars/${type}/${version}`, avatarVersion: version };
}

function imageType(bytes: Buffer): string | null {
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes.length >= 6 && ['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6))) return 'image/gif';
  if (bytes.length >= 12 && bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP') return 'image/webp';
  return null;
}

/** Existing crop is retained; bound dimensions and strip EXIF/location metadata.
 * Decode validation prevents trusting a client-supplied image MIME type. */
export async function normalizeAvatarUpload(file: Express.Multer.File): Promise<Express.Multer.File> {
  if (!file.buffer.length || file.buffer.length > MAX_BYTES) throw new Error('AVATAR_INVALID_IMAGE');
  let buffer: Buffer;
  try {
    buffer = await sharp(file.buffer, { limitInputPixels: 25_000_000, animated: false })
      .rotate().resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }).jpeg({ quality: 85, mozjpeg: true }).toBuffer();
  } catch { throw new Error('AVATAR_INVALID_IMAGE'); }
  return { ...file, buffer, size: buffer.length, originalname: 'avatar.jpg', mimetype: 'image/jpeg' };
}

async function avatarState(requesterId: number, ownerId: number, type: AvatarProfileType) {
  // Matches the existing foreign-profile rule, with fresh account state as well.
  const requester = await prisma.user.findUnique({ where: { id: requesterId }, select: {
    isActive: true, deletedAt: true, profileStatus: true, role: {select:{name:true}}, currentProfileType:true,
    employeeProfile:{select:{id:true}}, departmentRoles:{select:{id:true},take:1},
  } });
  if (!requester || !requester.isActive || requester.deletedAt || requester.profileStatus === 'BLOCKED') return null;
  const role = String(requester.role?.name || '').toLowerCase().replace(/[\s_-]+/g, '');
  if (requesterId !== ownerId && !(['admin','administrator','employee','departmentmanager'].includes(role) ||
    requester.employeeProfile || requester.departmentRoles.length || requester.currentProfileType === 'EMPLOYEE')) return null;
  const owner = await prisma.user.findUnique({ where: { id: ownerId }, select: {
    isActive: true, deletedAt:true, avatarUrl:true, employeeProfile:{select:{avatarUrl:true}},
    clientProfile:{select:{avatarUrl:true}}, supplierProfile:{select:{avatarUrl:true}},
  } });
  if (!owner || !owner.isActive || owner.deletedAt) return null;
  const raw = type === 'USER' ? owner.avatarUrl : type === 'EMPLOYEE' ? owner.employeeProfile?.avatarUrl :
    type === 'CLIENT' ? owner.clientProfile?.avatarUrl : owner.supplierProfile?.avatarUrl;
  const key = avatarObjectKey(raw), asset = profileAvatarAsset(ownerId,type,raw);
  return key && asset.avatarVersion ? {key,version:asset.avatarVersion} : null;
}

export async function serveProfileAvatar(req: AuthRequest<{userId:string;type:string;version:string}>, res: Response) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.vary('Authorization');
  const ownerId = Number(req.params.userId), type = String(req.params.type) as AvatarProfileType, version = String(req.params.version);
  if (!req.user?.userId || !Number.isSafeInteger(ownerId) || ownerId < 1 || !types.includes(type) || !/^[a-f0-9]{64}$/.test(version)) return res.status(404).json(NOT_FOUND);
  try {
    const state = await avatarState(req.user.userId,ownerId,type);
    if (!state || state.version !== version) return res.status(404).json(NOT_FOUND);
    const etag = `"avatar-${version}"`;
    const cached = String(req.headers['if-none-match'] || '').split(',').map(value=>value.trim().replace(/^W\//,''));
    if (cached.includes(etag) || cached.includes('*')) {
      res.setHeader('ETag', etag);res.setHeader('Cache-Control','private, max-age=31536000, immutable');
      return res.status(304).end();
    }
    const signal = AbortSignal.timeout(15000);
    const object = await s3.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: state.key }), {abortSignal:signal});
    const body = object.Body as any;
    if (!body || object.ContentLength === undefined || object.ContentLength > MAX_BYTES || object.ContentLength < 1) {
      body?.destroy?.(); return res.status(404).json(NOT_FOUND);
    }
    const chunks:Buffer[]=[];let size=0;
    const abort=()=>body.destroy?.(new Error('AVATAR_READ_ABORTED'));
    signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted)abort();
    try {
      for await (const part of body) {
        signal.throwIfAborted(); const chunk=Buffer.from(part);size+=chunk.length;
        if(size>MAX_BYTES)throw new Error('AVATAR_TOO_LARGE'); chunks.push(chunk);
      }
    } finally {signal.removeEventListener('abort',abort);body.destroy?.();}
    const bytes=Buffer.concat(chunks), contentType=imageType(bytes);
    if (!contentType || size !== object.ContentLength) return res.status(404).json(NOT_FOUND);
    const fresh=await avatarState(req.user.userId,ownerId,type);
    if (!fresh || fresh.version !== version) return res.status(404).json(NOT_FOUND);
    res.setHeader('ETag',etag);res.setHeader('Content-Type',contentType);
    res.setHeader('Cache-Control','private, max-age=31536000, immutable');
    return res.status(200).send(bytes);
  } catch (error) {
    const failure = error as {name?:string;$metadata?:{httpStatusCode?:number}};
    if(failure.name === 'NoSuchKey' || failure.$metadata?.httpStatusCode === 404) return res.status(404).json(NOT_FOUND);
    return res.status(503).json({ message: 'Фотография временно недоступна' });
  }
}
