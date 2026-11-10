jest.mock('../src/middleware/auth',()=>({authenticateToken:(req:any,res:any,next:any)=>{if(req.headers.authorization!=='Bearer fixture')return res.status(401).json({code:'NO_TOKEN'});req.user={userId:77};next()}}));
jest.mock('../src/middleware/checkUserStatus',()=>({checkUserStatus:(_req:any,_res:any,next:any)=>next()}));
jest.mock('../src/modules/entity-links/entity.preview',()=>({resolveEntityPreview:jest.fn()}));
jest.mock('../src/modules/onec-personal/service',()=>({userMcpCall:jest.fn(),validateOnecProofs:jest.fn()}));
import express from 'express';
import request from 'supertest';
import router from '../src/modules/entity-links/entity.routes';
import {resolveEntityPreview} from '../src/modules/entity-links/entity.preview';
import {EntityResolveError} from '../src/modules/entity-links/entity.service';
import {OnecPersonalError} from '../src/modules/onec-personal/config';
const app=express();app.use(express.json());app.use('/entity-links',router);
const target={v:1,source:'app',kind:'user',id:'88'};
beforeEach(()=>{jest.clearAllMocks();(resolveEntityPreview as jest.Mock).mockResolvedValue({target,title:'Сотрудник'})});
test('preview requires authentication before resolving a private image',async()=>{
 expect((await request(app).post('/entity-links/preview').send({target})).status).toBe(401);expect(resolveEntityPreview).not.toHaveBeenCalled();
});
test('preview binds the authenticated actor and never publicly caches data',async()=>{
 const r=await request(app).post('/entity-links/preview').set('Authorization','Bearer fixture').send({target});
 expect(r.status).toBe(200);expect(r.headers['cache-control']).toBe('private, no-store');expect(r.body.data).toEqual({target,title:'Сотрудник'});
 expect(resolveEntityPreview).toHaveBeenCalledWith(77,target,expect.any(AbortSignal));
});
test.each([{target,userId:1},{target,imageUrl:'https://remote.invalid'},{target,maxTabularRows:1},{target:{...target,url:'https://remote.invalid'}},{}])('preview does not accept model image addresses or identity overrides: %p',async body=>{
 const r=await request(app).post('/entity-links/preview').set('Authorization','Bearer fixture').send(body);expect(r.status).toBe(400);expect(resolveEntityPreview).not.toHaveBeenCalled();
});
test('access denial and unknown diagnostics stay safe',async()=>{
 (resolveEntityPreview as jest.Mock).mockRejectedValueOnce(new EntityResolveError('ENTITY_ACCESS_DENIED',403)).mockRejectedValueOnce(new Error('secret=private'));
 const a=await request(app).post('/entity-links/preview').set('Authorization','Bearer fixture').send({target});expect(a.status).toBe(403);
 const b=await request(app).post('/entity-links/preview').set('Authorization','Bearer fixture').send({target});expect(b.status).toBe(503);expect(JSON.stringify(b.body)).not.toContain('secret');
});
test('product personal connection errors use the existing protected action',async()=>{
 (resolveEntityPreview as jest.Mock).mockRejectedValue(new OnecPersonalError('ONEC_AUTH_REQUIRED'));
 const onec={v:1,source:'onec',baseKey:'qa',metaType:'Catalogs',name:'Номенклатура',guid:'aaaa1111-bbbb-4111-8111-ccccdddd0001'};
 const r=await request(app).post('/entity-links/preview').set('Authorization','Bearer fixture').send({target:onec});
 expect(r.status).toBe(422);expect(r.body.action).toEqual({type:'connect_onec',baseKey:'qa'});
});
