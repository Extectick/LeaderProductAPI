import express from 'express';
import request from 'supertest';

const mockSend=jest.fn();
const mockRedis=jest.fn(()=>({isOpen:false}));
const mockVerify=jest.fn((..._args:any[])=>true);
jest.mock('../src/storage/minio',()=>({s3:{send:(...args:any[])=>mockSend(...args)}}));
jest.mock('../src/lib/redis',()=>({getRedis:()=>mockRedis(),redisKeys:{byPathCache:(key:string)=>key}}));
jest.mock('../src/utils/fileTokens',()=>({verifyFileToken:(...args:any[])=>mockVerify(...args)}));

process.env.S3_BUCKET='private-test';
process.env.FILES_REQUIRE_TOKEN='0';
const router=require('../src/routes/files').default;
const app=express();app.use('/files',router);

describe('Help attachments cannot bypass membership through generic file proxy',()=>{
  beforeEach(()=>{jest.clearAllMocks();mockSend.mockResolvedValue({Body:Buffer.from('ordinary file'),ContentType:'text/plain'});});
  test.each(['dev/help/uuid','prod/help/uuid','help-qa/help/uuid','dev%2Fhelp%2Fuuid','%64ev/help/uuid'])('blocks %s before tokens, cache or S3',async key=>{
    const result=await request(app).get('/files/'+key).query({token:'even-a-valid-general-file-token'});
    expect(result.status).toBe(404);
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(mockSend).not.toHaveBeenCalled();expect(mockRedis).not.toHaveBeenCalled();expect(mockVerify).not.toHaveBeenCalled();
  });
  test('HEAD cannot expose metadata',async()=>{
    expect((await request(app).head('/files/dev/help/uuid')).status).toBe(404);
    expect(mockSend).not.toHaveBeenCalled();
  });
  test('ordinary existing file paths remain supported',async()=>{
    const result=await request(app).get('/files/dev/files/uploads/ordinary.txt');
    expect(result.status).toBe(200);expect(result.text).toBe('ordinary file');
    expect(mockSend.mock.calls[0][0].input.Key).toBe('dev/files/uploads/ordinary.txt');
  });
});
