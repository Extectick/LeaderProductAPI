jest.mock('../src/prisma/client',()=>({__esModule:true,default:{user:{findUnique:jest.fn()}}}));
jest.mock('../src/storage/minio',()=>({s3:{send:jest.fn()},s3EnvPrefix:'dev'}));
import express from 'express';
import request from 'supertest';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import prisma from '../src/prisma/client';
import {s3} from '../src/storage/minio';
import {avatarObjectKey,profileAvatarAsset,serveProfileAvatar,normalizeAvatarUpload} from '../src/services/avatarService';
const key='avatars/old-avatar.png',ownerId=7;
const version=profileAvatarAsset(ownerId,'EMPLOYEE',key).avatarVersion!;
const path=`/users/${ownerId}/avatars/EMPLOYEE/${version}`;
const app=express();app.use((req,_res,next)=>{(req as any).user={userId:Number(req.headers['x-test-user']||7)};next();});app.get('/users/:userId/avatars/:type/:version',serveProfileAvatar);
const actor={isActive:true,deletedAt:null,profileStatus:'ACTIVE',role:{name:'client'},currentProfileType:'CLIENT',employeeProfile:null,departmentRoles:[]};
const owner={isActive:true,deletedAt:null,avatarUrl:null,employeeProfile:{avatarUrl:key},clientProfile:null,supplierProfile:null};
let bytes:Buffer;
beforeAll(async()=>{bytes=await sharp({create:{width:3,height:3,channels:3,background:'#f00'}}).png().toBuffer();});
beforeEach(()=>{jest.clearAllMocks();(prisma.user.findUnique as jest.Mock).mockImplementation(async args=>args.select.role?actor:owner);(s3.send as jest.Mock).mockImplementation(async()=>({ContentLength:bytes.length,ContentType:'application/octet-stream',Body:Readable.from([bytes])}));});
test('asset identity is stable and changes for every object, owner and profile type',()=>{
 const asset=profileAvatarAsset(ownerId,'EMPLOYEE',key);expect(asset.avatarAssetUrl).toBe(path);
 expect(profileAvatarAsset(ownerId,'EMPLOYEE',key)).toEqual(asset);
 expect(profileAvatarAsset(ownerId,'EMPLOYEE','avatars/replacement.png').avatarVersion).not.toBe(version);
 expect(profileAvatarAsset(8,'EMPLOYEE',key).avatarVersion).not.toBe(version);
 expect(profileAvatarAsset(7,'CLIENT',key).avatarVersion).not.toBe(version);
});
test('external legacy photos omit managed asset fields; explicit null means absent photo',()=>{
 expect(profileAvatarAsset(7,'USER','https://legacy-photo.example/photo.jpg')).toEqual({});
 expect(profileAvatarAsset(7,'USER',null)).toEqual({avatarAssetUrl:null,avatarVersion:null});
});
test('accepts only avatar namespace and configured URL origins, never Help/general/external URLs',()=>{
 const previous=process.env.FILES_BASE_URL;process.env.FILES_BASE_URL='https://avatar-fixture.example';
 try{
  expect(avatarObjectKey(key)).toBe(key);expect(avatarObjectKey('dev/images/avatars/new.jpg')).toBe('dev/images/avatars/new.jpg');
  expect(avatarObjectKey('https://avatar-fixture.example/files/avatars/old-avatar.png?token=expired')).toBe(key);
  for(const input of ['dev/help/private.jpg','prod/images/avatars/photo.jpg','uploads/photo.jpg','avatars/../secret','avatars/a\\b','https://external.example/files/avatars/a.jpg','data:image/png,abc'])expect(avatarObjectKey(input)).toBeNull();
 }finally{if(previous===undefined)delete process.env.FILES_BASE_URL;else process.env.FILES_BASE_URL=previous;}
});
test('streams actual image bytes with stable private immutable caching and sniffed MIME',async()=>{
 const result=await request(app).get(path);expect(result.status).toBe(200);expect(result.headers['content-type']).toContain('image/png');
 expect(result.body).toEqual(bytes);expect(result.headers['cache-control']).toBe('private, max-age=31536000, immutable');expect(result.headers.vary).toContain('Authorization');expect(result.headers.etag).toBe(`"avatar-${version}"`);
 expect(s3.send).toHaveBeenCalledTimes(1);expect(prisma.user.findUnique).toHaveBeenCalledTimes(4);
});
test('conditional GET rechecks access but transfers no bytes and makes no storage request',async()=>{
 const result=await request(app).get(path).set('If-None-Match',`W/"avatar-${version}"`);expect(result.status).toBe(304);expect(s3.send).not.toHaveBeenCalled();expect(prisma.user.findUnique).toHaveBeenCalledTimes(2);
});
test('old version, removed avatar, invalid type and forbidden foreign reader are never immutable cached',async()=>{
 const old=await request(app).get(path.replace(version,'0'.repeat(64)));expect(old.status).toBe(404);expect(old.headers['cache-control']).toContain('no-store');
 const foreign=await request(app).get(path).set('x-test-user','8');expect(foreign.status).toBe(404);expect(foreign.headers['cache-control']).toContain('no-store');
 expect((await request(app).get(path.replace('/EMPLOYEE/','/INVALID/'))).status).toBe(404);
 (prisma.user.findUnique as jest.Mock).mockImplementation(async args=>args.select.role?actor:{...owner,employeeProfile:{avatarUrl:null}});
 expect((await request(app).get(path)).status).toBe(404);expect(s3.send).not.toHaveBeenCalled();
});
test('existing employee foreign-profile permission works without publishing a bearer token',async()=>{
 (prisma.user.findUnique as jest.Mock).mockImplementation(async args=>args.select.role?{...actor,role:{name:'employee'}}:owner);
 const result=await request(app).get(path).set('x-test-user','8');expect(result.status).toBe(200);expect(result.headers.location).toBeUndefined();expect(JSON.stringify(result.headers)).not.toContain('token=');
});
test('photo replacement and access revocation during download fence late content',async()=>{
 let checks=0;(prisma.user.findUnique as jest.Mock).mockImplementation(async args=>args.select.role?actor:(++checks===1?owner:{...owner,employeeProfile:{avatarUrl:'avatars/new.png'}}));
 let result=await request(app).get(path);expect(result.status).toBe(404);expect(result.headers['cache-control']).toContain('no-store');
 checks=0;(prisma.user.findUnique as jest.Mock).mockImplementation(async args=>args.select.role?(++checks===1?actor:{...actor,profileStatus:'BLOCKED'}):owner);
 result=await request(app).get(path);expect(result.status).toBe(404);
});
test('invalid/oversized storage bodies and errors never return image cache headers or private error content',async()=>{
 (s3.send as jest.Mock).mockResolvedValueOnce({ContentLength:8*1024*1024+1,Body:Readable.from([bytes])});expect((await request(app).get(path)).status).toBe(404);
 (s3.send as jest.Mock).mockResolvedValueOnce({ContentLength:7,Body:Readable.from([Buffer.from('<html/>')])});expect((await request(app).get(path)).status).toBe(404);
 (s3.send as jest.Mock).mockRejectedValueOnce(Error('PRIVATE_STORAGE_CREDENTIAL'));
 const result=await request(app).get(path);expect(result.status).toBe(503);expect(result.headers['cache-control']).toContain('no-store');expect(JSON.stringify(result.body)).not.toContain('PRIVATE');
});
test('uploads are decoded, resized, oriented and stripped rather than trusting provided image MIME',async()=>{
 const original=await sharp({create:{width:1500,height:1000,channels:4,background:'#f008'}}).withMetadata({orientation:6}).png().toBuffer();
 const file=await normalizeAvatarUpload({buffer:original,size:original.length,mimetype:'image/png',originalname:'private-name.png'} as Express.Multer.File);
 const metadata=await sharp(file.buffer).metadata();expect(metadata.format).toBe('jpeg');expect(metadata.width).toBeLessThanOrEqual(512);expect(metadata.height).toBeLessThanOrEqual(512);expect(metadata.exif).toBeUndefined();expect(file.originalname).toBe('avatar.jpg');
 await expect(normalizeAvatarUpload({buffer:Buffer.from('not an image'),mimetype:'image/png'} as Express.Multer.File)).rejects.toThrow('AVATAR_INVALID_IMAGE');
});
