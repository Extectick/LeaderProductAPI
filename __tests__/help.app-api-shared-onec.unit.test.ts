jest.mock('../src/prisma/client',()=>({__esModule:true,default:{role:{findUnique:jest.fn()},rolePermissions:{findMany:jest.fn()}}}));
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import {authenticateToken} from '../src/middleware/auth';
import {assertNoSharedOnecForHelpApi,HELP_APP_API_ONEC_ERROR,runHelpAppApiRequest} from '../src/lib/helpAppApiContext';
import {getOnecLpAppStock,getOnecLpAppNomenclatureImageContent,ackOnecLpAppClientOrderInvoice,OnecLpAppHttpError} from '../src/modules/onec/onec.lpApp.client';

const originalEnv={...process.env},originalFetch=globalThis.fetch;
let transport:jest.Mock;
const app=express();
app.get('/cached',authenticateToken,async(_req,res)=>{await Promise.resolve();res.json({from:'application_cache',items:[{id:1}]});});
app.get('/live',authenticateToken,async(_req,res)=>{
 await new Promise(resolve=>setTimeout(resolve,1));
 try{res.json(await getOnecLpAppStock({}));}
 catch{res.status(502).json({code:'LEGACY_UPSTREAM_ERROR'});}
});
const token=(marker?:boolean|string)=>jwt.sign({userId:7,role:'employee',...(marker===undefined?{}:{helpApi:marker})},process.env.ACCESS_TOKEN_SECRET||'youraccesstokensecret',{expiresIn:60});
beforeEach(()=>{
 process.env={...originalEnv,ONEC_LP_APP_BASE_URL:'http://onec.fixture/qa/hs/lp-app',ONEC_LP_APP_API_KEY:'fixture-key'};
 transport=jest.fn(async()=>Response.json({items:[{id:1}]}));globalThis.fetch=transport;
});
afterEach(()=>{process.env=originalEnv;globalThis.fetch=originalFetch;jest.restoreAllMocks();});

test('normal contexts and ordinary APP JWTs retain existing shared transport behavior',async()=>{
 expect(()=>assertNoSharedOnecForHelpApi()).not.toThrow();
 const response=await request(app).get('/live').set('Authorization','Bearer '+token());
 expect(response.status).toBe(200);expect(response.headers['x-help-app-api-error']).toBeUndefined();expect(transport).toHaveBeenCalledTimes(1);
});
test('signed Help request context survives asynchronous route work and reports legacy-masked denial',async()=>{
 const response=await request(app).get('/live').set('Authorization','Bearer '+token(true));
 expect(response.status).toBe(502);expect(response.body).toEqual({code:'LEGACY_UPSTREAM_ERROR'});
 expect(response.headers['x-help-app-api-error']).toBe(HELP_APP_API_ONEC_ERROR);expect(transport).not.toHaveBeenCalled();
});
test('cached APP data remains readable under signed Help request without touching shared1C',async()=>{
 const response=await request(app).get('/cached').set('Authorization','Bearer '+token(true));
 expect(response.status).toBe(200);expect(response.body.from).toBe('application_cache');expect(response.headers['x-help-app-api-error']).toBeUndefined();expect(transport).not.toHaveBeenCalled();
});
test('unsigned headers or nonboolean token claims cannot establish the restricted Help context',async()=>{
 for(const marker of [undefined,'true']){
  const response=await request(app).get('/live').set('Authorization','Bearer '+token(marker)).set('X-Help-App-API','true').set('X-Help-App-API-Error',HELP_APP_API_ONEC_ERROR);
  expect(response.status).toBe(200);expect(response.headers['x-help-app-api-error']).toBeUndefined();
 }
 expect(transport).toHaveBeenCalledTimes(2);
});
test('concurrent ordinary APP requests are isolated from a Help request',async()=>{
 const [help,normal]=await Promise.all([request(app).get('/live').set('Authorization','Bearer '+token(true)),request(app).get('/live').set('Authorization','Bearer '+token())]);
 expect(help.headers['x-help-app-api-error']).toBe(HELP_APP_API_ONEC_ERROR);expect(normal.status).toBe(200);expect(normal.headers['x-help-app-api-error']).toBeUndefined();expect(transport).toHaveBeenCalledTimes(1);
});
test('JSON, binary and write transports are blocked before reading shared credentials',async()=>{
 delete process.env.ONEC_LP_APP_BASE_URL;delete process.env.ONEC_LP_APP_API_KEY;
 for(const call of [()=>getOnecLpAppStock({}),()=>getOnecLpAppNomenclatureImageContent('fixture-guid'),()=>ackOnecLpAppClientOrderInvoice('fixture-token',{state:'STORED'})]){
  let error:unknown;try{await runHelpAppApiRequest(7,call);}catch(value){error=value;}
  expect(error).toBeInstanceOf(OnecLpAppHttpError);expect(error).toMatchObject({code:HELP_APP_API_ONEC_ERROR,status:422,upstreamStatus:422,payload:{code:HELP_APP_API_ONEC_ERROR}});
 }
 expect(transport).not.toHaveBeenCalled();
});
test('a failed block-report callback cannot allow network and contexts release afterwards',async()=>{
 await expect(runHelpAppApiRequest(7,()=>getOnecLpAppStock({}),()=>{throw Error('response already closed')})).rejects.toMatchObject({code:HELP_APP_API_ONEC_ERROR});
 expect(()=>assertNoSharedOnecForHelpApi()).not.toThrow();await expect(getOnecLpAppStock({})).resolves.toMatchObject({items:[{id:1}]});expect(transport).toHaveBeenCalledTimes(1);
});
