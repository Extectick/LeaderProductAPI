jest.mock('../src/middleware/auth',()=>({authenticateToken:(req:any,res:any,next:any)=>{if(req.headers.authorization!=='Bearer fixture')return res.status(401).json({code:'NO_TOKEN'});req.user={userId:77};next()}}));
jest.mock('../src/middleware/checkUserStatus',()=>({checkUserStatus:(_req:any,_res:any,next:any)=>next()}));
jest.mock('../src/modules/entity-links/entity.service',()=>({...jest.requireActual('../src/modules/entity-links/entity.service'),resolveEntityTarget:jest.fn()}));
jest.mock('../src/modules/onec-personal/service',()=>({userMcpCall:jest.fn(),validateOnecProofs:jest.fn()}));
import express from 'express';
import request from 'supertest';
import router from '../src/modules/entity-links/entity.routes';
import {resolveEntityTarget,EntityResolveError} from '../src/modules/entity-links/entity.service';
import {OnecPersonalError} from '../src/modules/onec-personal/config';
const app=express();app.use(express.json());app.use('/entity-links',router);
const target={v:1,source:'onec',baseKey:'qa',metaType:'Catalogs',name:'Номенклатура',guid:'aaaa1111-bbbb-4111-8111-ccccdddd0001'};
beforeEach(()=>{jest.clearAllMocks();(resolveEntityTarget as jest.Mock).mockResolvedValue({target,view:'product',title:'Товар',fields:[],tables:[],truncated:false})});
test('anonymous resolution is rejected before reading any object',async()=>{
 expect((await request(app).post('/entity-links/resolve').send({target})).status).toBe(401);expect(resolveEntityTarget).not.toHaveBeenCalled();
});
test('authenticated target reaches the resolver with the authenticated user and is never publicly cached',async()=>{
 const r=await request(app).post('/entity-links/resolve').set('Authorization','Bearer fixture').send({target});
 expect(r.status).toBe(200);expect(r.headers['cache-control']).toBe('private, no-store');expect(r.body.data.title).toBe('Товар');
 expect(resolveEntityTarget).toHaveBeenCalledWith(77,target,expect.any(AbortSignal),100);
});
test.each([{target:{...target,url:'https://other.invalid'}},{target,userId:1},{target:{...target,source:'http'}},{}])('target/body cannot override the requesting identity or endpoint: %p',async body=>{
 const r=await request(app).post('/entity-links/resolve').set('Authorization','Bearer fixture').send(body);expect(r.status).toBe(400);expect(resolveEntityTarget).not.toHaveBeenCalled();
});
test.each(['ONEC_AUTH_REQUIRED','ONEC_ACCESS_DENIED','ONEC_CREDENTIALS_INVALID'])('personal access error %s offers the protected form without changing the base',async code=>{
 (resolveEntityTarget as jest.Mock).mockRejectedValue(new OnecPersonalError(code));
 const r=await request(app).post('/entity-links/resolve').set('Authorization','Bearer fixture').send({target});
 expect(r.status).toBe(422);expect(r.body.action).toEqual({type:'connect_onec',baseKey:'qa'});expect(r.body.error.code).toBe(code);
});
test('a not-found object stays not-found, unexpected diagnostics stay private',async()=>{
 (resolveEntityTarget as jest.Mock).mockRejectedValueOnce(new EntityResolveError('ENTITY_NOT_FOUND',404)).mockRejectedValueOnce(new Error('password=never-leak https://private.invalid'));
 const a=await request(app).post('/entity-links/resolve').set('Authorization','Bearer fixture').send({target});expect(a.status).toBe(404);
 const b=await request(app).post('/entity-links/resolve').set('Authorization','Bearer fixture').send({target});expect(b.status).toBe(503);expect(JSON.stringify(b.body)).not.toMatch(/never-leak|private.invalid|password/);
});
test.each([1,100,250,1000])('a larger bounded view can be requested explicitly: %s',async maxTabularRows=>{
 const r=await request(app).post('/entity-links/resolve').set('Authorization','Bearer fixture').send({target,maxTabularRows});
 expect(r.status).toBe(200);expect(resolveEntityTarget).toHaveBeenCalledWith(77,target,expect.any(AbortSignal),maxTabularRows);
});
test.each([0,-1,1001,1.5,'250',null])('invalid page bound is rejected before reading: %p',async maxTabularRows=>{
 const r=await request(app).post('/entity-links/resolve').set('Authorization','Bearer fixture').send({target,maxTabularRows});
 expect(r.status).toBe(400);expect(r.body.error.code).toBe('ENTITY_INVALID_LIMIT');expect(resolveEntityTarget).not.toHaveBeenCalled();
});
