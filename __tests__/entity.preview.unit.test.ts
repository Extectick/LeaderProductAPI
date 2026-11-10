jest.mock('../src/modules/entity-links/entity.stock-access',()=>({assertAppStockAccess:jest.fn(async()=>{})}));
import {assertAppStockAccess} from '../src/modules/entity-links/entity.stock-access';
jest.mock('../src/prisma/client',()=>({__esModule:true,default:{user:{findUnique:jest.fn()},productImage:{findFirst:jest.fn()},product:{findFirst:jest.fn()}}}));
jest.mock('../src/storage/minio',()=>({s3:{send:jest.fn()},buildStoragePrefix:(key:string)=>key==='avatars'?'dev/images/avatars':'dev/images'}));
jest.mock('../src/modules/onec-personal/service',()=>({userMcpCall:jest.fn(),validateOnecProofs:jest.fn()}));
jest.mock('../src/modules/onec-personal/config',()=>({onecBase:jest.fn(()=>({rpcUrl:'https://onec.invalid/test/hs/mcp/rpc'}))}));
import {Readable} from 'node:stream';
import sharp from 'sharp';
import prisma from '../src/prisma/client';
import {s3} from '../src/storage/minio';
import {readArguments} from '../src/modules/onec-personal/mcp';
import {userMcpCall,validateOnecProofs} from '../src/modules/onec-personal/service';
import {resolveEntityPreview,entityAvatarStorageKey,entityProductMirrorMatches,entityProductImageStorageKey} from '../src/modules/entity-links/entity.preview';
const actor={id:77,isActive:true,deletedAt:null,profileStatus:'ACTIVE',role:{name:'employee'},currentProfileType:'EMPLOYEE',employeeProfile:{id:8,avatarUrl:null},departmentRoles:[]};
const person={...actor,id:88,firstName:'Анна',lastName:'Иванова',avatarUrl:null,employeeProfile:{id:9,avatarUrl:'dev/images/avatars/person.png'}};
const target={v:1,source:'app',kind:'user',id:'88'};
const product={v:1,source:'onec',baseKey:'qa',metaType:'Catalogs',name:'Номенклатура',guid:'aaaa1111-bbbb-4111-8111-ccccdddd0001'};
const abort=()=>new AbortController().signal;
async function image(){return sharp({create:{width:40,height:30,channels:3,background:'#5577aa'}}).png().toBuffer();}
beforeEach(()=>{
 jest.clearAllMocks();delete process.env.ONEC_LP_APP_BASE_URL;
 (prisma.user.findUnique as jest.Mock).mockImplementation(({where})=>Promise.resolve(where.id===77?actor:person));
 (userMcpCall as jest.Mock).mockResolvedValue({text:JSON.stringify({success:true,data:{fields:{Наименование:'Товар'}}}),proof:{baseKey:'qa',revision:4}});
 (validateOnecProofs as jest.Mock).mockResolvedValue(undefined);
});
test('authenticated profile read produces a bounded re-encoded raster, never an address/token',async()=>{
 const bytes=await image();(s3.send as jest.Mock).mockResolvedValue({Body:Readable.from([bytes]),ContentLength:bytes.length});
 const result=await resolveEntityPreview(77,target,abort());
 expect(result).toMatchObject({target,title:'Иванова Анна',imageDataUrl:expect.stringMatching(/^data:image\/webp;base64,/)});
 expect(s3.send).toHaveBeenCalledWith(expect.objectContaining({input:expect.objectContaining({Key:'dev/images/avatars/person.png',Range:'bytes=0-2097152'})}),expect.objectContaining({abortSignal:expect.any(AbortSignal)}));
 expect(prisma.user.findUnique).toHaveBeenCalledTimes(4);expect(JSON.stringify(result)).not.toContain('avatars/');
});
test('nonemployee cannot read another profile or its image',async()=>{
 (prisma.user.findUnique as jest.Mock).mockImplementation(({where})=>Promise.resolve(where.id===77?{...actor,role:{name:'client'},employeeProfile:null,currentProfileType:'CLIENT'}:person));
 await expect(resolveEntityPreview(77,target,abort())).rejects.toMatchObject({status:403});expect(s3.send).not.toHaveBeenCalled();
});
test('access revoked during thumbnail reading blocks the complete result',async()=>{
 (s3.send as jest.Mock).mockImplementation(async()=>{
  (prisma.user.findUnique as jest.Mock).mockImplementation(({where})=>Promise.resolve(where.id===77?{...actor,isActive:false}:person));
  const bytes=await image();return {Body:Readable.from([bytes]),ContentLength:bytes.length};
 });
 await expect(resolveEntityPreview(77,target,abort())).rejects.toMatchObject({status:401});
});
test('invalid, remote, SVG and oversized pictures become an absent image',async()=>{
 expect(entityAvatarStorageKey('avatars/legacy.png')).toBe('avatars/legacy.png');expect(entityAvatarStorageKey('other/file.png')).toBeNull();expect(entityAvatarStorageKey('avatars/../secret')).toBeNull();expect(entityAvatarStorageKey('http://169.254.169.254/latest/')).toBeNull();expect(entityAvatarStorageKey('dev/images/avatars/../secrets')).toBeNull();
 for(const bytes of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),Buffer.from('broken')]){
  (s3.send as jest.Mock).mockResolvedValue({Body:Readable.from([bytes]),ContentLength:bytes.length});expect((await resolveEntityPreview(77,target,abort())).imageDataUrl).toBeUndefined();
 }
 const body=Readable.from([Buffer.alloc(1)]);(s3.send as jest.Mock).mockResolvedValue({Body:body,ContentLength:3*1024*1024});
 expect((await resolveEntityPreview(77,target,abort())).imageDataUrl).toBeUndefined();expect(body.destroyed).toBe(true);
 const prefix=Readable.from([await image()]);(s3.send as jest.Mock).mockResolvedValue({Body:prefix,ContentLength:1024,ContentRange:'bytes 0-1023/4194304'});
 expect((await resolveEntityPreview(77,target,abort())).imageDataUrl).toBeUndefined();expect(prefix.destroyed).toBe(true);
});
test('a product always uses personal get_object and current proof; another base mirror is ignored',async()=>{
 process.env.ONEC_LP_APP_BASE_URL='https://onec.invalid/different/hs/lp-app';
 expect(await resolveEntityPreview(77,product,abort())).toEqual({target:product,title:'Товар'});
 expect(userMcpCall).toHaveBeenCalledWith(77,'qa','get_object',expect.objectContaining({guid:product.guid,includeTabularSections:false}),expect.any(AbortSignal));
 const raw=(userMcpCall as jest.Mock).mock.calls[0][3];expect(raw).not.toHaveProperty('maxTabularRows');expect(readArguments('get_object',raw)).toMatchObject({includeTabularSections:false,maxTabularRows:0});
 expect(validateOnecProofs).toHaveBeenCalledWith(77,[{baseKey:'qa',revision:4}]);expect(prisma.productImage.findFirst).not.toHaveBeenCalled();
});
test('a verified matching publication can use an existing synced thumbnail without sync/writes',async()=>{
 process.env.ONEC_LP_APP_BASE_URL='https://onec.invalid/test/hs/lp-app';
 const key=`dev/images/client-orders/products/${product.guid}/image/hash/thumb.webp`;
 (prisma.productImage.findFirst as jest.Mock).mockResolvedValue({id:'image',s3KeyThumb:key});
 const bytes=await image();(s3.send as jest.Mock).mockResolvedValue({Body:Readable.from([bytes]),ContentLength:bytes.length});
 const result=await resolveEntityPreview(77,product,abort());expect(result.imageDataUrl).toMatch(/^data:image\/webp;base64,/);
 expect(prisma.productImage.findFirst).toHaveBeenCalledTimes(2);
});
test('a revoked 1C proof suppresses a prepared image result',async()=>{
 (validateOnecProofs as jest.Mock).mockRejectedValue(new Error('ONEC_AUTH_REQUIRED'));
 await expect(resolveEntityPreview(77,product,abort())).rejects.toThrow('ONEC_AUTH_REQUIRED');
});
test('unsupported object or preaborted read never touches storage',async()=>{
 await expect(resolveEntityPreview(77,{...product,name:'Другой'},abort())).rejects.toMatchObject({status:400});
 await expect(resolveEntityPreview(77,target,AbortSignal.abort())).rejects.toThrow();expect(s3.send).not.toHaveBeenCalled();expect(userMcpCall).not.toHaveBeenCalled();
});
test('publication comparison never matches another origin, another base, or a credential URL',()=>{
 const rpc='https://onec.invalid/test/hs/mcp/rpc';
 expect(entityProductMirrorMatches(rpc,'https://onec.invalid/test/hs/lp-app/')).toBe(true);
 for(const candidate of ['https://other.invalid/test/hs/lp-app','https://onec.invalid/other/hs/lp-app','https://user:pw@onec.invalid/test/hs/lp-app','https://onec.invalid/test/hs/lp-app?apiKey=x'])expect(entityProductMirrorMatches(rpc,candidate)).toBe(false);
});

test('APP product preview reads the application catalog with stock rights and never personal MCP',async()=>{
 const appTarget={v:1,source:'app',kind:'product',guid:product.guid};
 (prisma.product.findFirst as jest.Mock).mockResolvedValue({guid:product.guid,name:'Товар приложения'});(prisma.productImage.findFirst as jest.Mock).mockResolvedValue(null);
 expect(await resolveEntityPreview(77,appTarget,abort())).toEqual({target:appTarget,title:'Товар приложения'});
 expect(assertAppStockAccess).toHaveBeenCalledTimes(2);expect(userMcpCall).not.toHaveBeenCalled();
});


test('restored synced APP product pictures retain their historical namespace without changing buckets',async()=>{
 const appTarget={v:1,source:'app',kind:'product',guid:product.guid};
 const key=`prod/images/client-orders/products/${product.guid}/image/hash/thumb.webp`;
 (prisma.product.findFirst as jest.Mock).mockResolvedValue({guid:product.guid,name:'Товар приложения'});
 (prisma.productImage.findFirst as jest.Mock).mockResolvedValue({id:'image',s3KeyThumb:key});
 const bytes=await image();(s3.send as jest.Mock).mockResolvedValue({Body:Readable.from([bytes]),ContentLength:bytes.length});
 const result=await resolveEntityPreview(77,appTarget,abort());
 expect(result.imageDataUrl).toMatch(/^data:image\/webp;base64,/);
 expect(s3.send).toHaveBeenCalledWith(expect.objectContaining({input:expect.objectContaining({Key:key})}),expect.any(Object));
 expect(prisma.productImage.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({where:expect.objectContaining({id:'image',productGuid:product.guid,s3KeyThumb:key,deletedAt:null,syncState:'SYNCED'})}));
 expect(assertAppStockAccess).toHaveBeenCalledTimes(2);expect(userMcpCall).not.toHaveBeenCalled();
});
test('product image namespace validation never accepts another product, private file, URL or path escape',()=>{
 const path=`images/client-orders/products/${product.guid}/image/hash/thumb.webp`;
 for(const prefix of ['dev/','prod/'])expect(entityProductImageStorageKey(prefix+path,product.guid)).toBe(prefix+path);
 for(const key of ['https://storage.invalid/'+path,'avatars/private.png','prod/help/private.json','prod/'+path.replace(product.guid,'another-product'),'prod/'+path.replace('/image/','/../'),'prod/'+path+'?token=anything','prod/'+path+'#fragment','prod/'+path.replace('/image/','//image/')])expect(entityProductImageStorageKey(key,product.guid)).toBeNull();
});
test('revoking synced image metadata while reading discards the restored picture',async()=>{
 const appTarget={v:1,source:'app',kind:'product',guid:product.guid};
 const row={id:'image',s3KeyThumb:`prod/images/client-orders/products/${product.guid}/image/hash/thumb.webp`};
 (prisma.product.findFirst as jest.Mock).mockResolvedValue({guid:product.guid,name:'Товар приложения'});
 (prisma.productImage.findFirst as jest.Mock).mockResolvedValueOnce(row).mockResolvedValueOnce(null);
 const bytes=await image();(s3.send as jest.Mock).mockResolvedValue({Body:Readable.from([bytes]),ContentLength:bytes.length});
 expect((await resolveEntityPreview(77,appTarget,abort())).imageDataUrl).toBeUndefined();
});
