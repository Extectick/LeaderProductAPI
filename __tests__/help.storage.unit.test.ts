import { createHelpStorageGuard, helpStorageConfig, helpStorageRequest } from '../src/modules/help/help.storage';

const missingPolicy=Object.assign(new Error(),{name:'NoSuchBucketPolicy',$metadata:{httpStatusCode:404}});
const denied=Object.assign(new Error('must never expose provider details'),{name:'AccessDenied',$metadata:{httpStatusCode:403}});
const mockClient=(policy:any={Statement:[]},grants:any[]=[])=>({send:jest.fn(async(command:any)=>{
  if(command.constructor.name==='GetBucketPolicyCommand') {
    if(policy instanceof Error) throw policy;
    return {Policy:JSON.stringify(policy)};
  }
  if(command.constructor.name==='GetBucketAclCommand') return {Grants:grants};
  return {};
})});

describe('isolated Help storage configuration and fail-closed privacy',()=>{
  beforeEach(()=>jest.spyOn(console,'warn').mockImplementation(()=>{}));
  afterEach(()=>jest.restoreAllMocks());
  test('default config uses shared credentials without changing the source environment',()=>{
    const env={S3_ENDPOINT:'https://shared.invalid',S3_REGION:'shared',S3_ACCESS_KEY:'shared-id',S3_SECRET_KEY:'shared-secret'};
    expect(helpStorageConfig(env)).toMatchObject({endpoint:env.S3_ENDPOINT,region:'shared',credentials:{accessKeyId:'shared-id',secretAccessKey:'shared-secret'}});
    expect(env).not.toHaveProperty('HELP_S3_ENDPOINT');
  });
  test('Help endpoint, region and credential pair override shared settings',()=>{
    expect(helpStorageConfig({S3_ENDPOINT:'shared',S3_REGION:'shared',S3_ACCESS_KEY:'shared-id',S3_SECRET_KEY:'shared-secret',HELP_S3_ENDPOINT:'private',HELP_S3_REGION:'private-region',HELP_S3_ACCESS_KEY:'private-id',HELP_S3_SECRET_KEY:'private-secret'})).toMatchObject({endpoint:'private',region:'private-region',credentials:{accessKeyId:'private-id',secretAccessKey:'private-secret'}});
  });
  test('partial dedicated key pair never mixes shared secrets',()=>{
    expect(helpStorageConfig({S3_ACCESS_KEY:'shared-id',S3_SECRET_KEY:'shared-secret',HELP_S3_ACCESS_KEY:'private-id'}).credentials).toEqual({accessKeyId:'private-id',secretAccessKey:''});
  });
  test('private policy and private ACL permit storage, cached for at most60s',async()=>{
    let now=10;const client=mockClient();const ensure=createHelpStorageGuard(client as any,'private',()=>now);
    await ensure();await ensure();expect(client.send).toHaveBeenCalledTimes(3);
    now+=60_001;await ensure();expect(client.send).toHaveBeenCalledTimes(6);
  });
  test('explicit NoSuchBucketPolicy is private when ACL is private',async()=>{
    await expect(createHelpStorageGuard(mockClient(missingPolicy) as any,'private')()).resolves.toBeUndefined();
  });
  test.each([{Statement:{Effect:'Allow',Principal:'*'}},{Statement:[{Effect:'Allow',Principal:{AWS:'*'}}]}])('wildcard policy rejects even singleton Statement',async policy=>{
    await expect(createHelpStorageGuard(mockClient(policy) as any,'private')()).rejects.toMatchObject({status:503,code:'HELP_STORAGE_NOT_PRIVATE'});
  });
  test.each(['AllUsers','AuthenticatedUsers'])('public ACL group %s fails closed',async group=>{
    await expect(createHelpStorageGuard(mockClient({},[{Grantee:{URI:`http://acs.amazonaws.com/groups/global/${group}`},Permission:'READ'}]) as any,'private')()).rejects.toMatchObject({code:'HELP_STORAGE_NOT_PRIVATE'});
  });
  test('denied bucket creation is actionable503 and retry is possible, no fallback bucket',async()=>{
    const client=mockClient();client.send.mockImplementation(async command=>{
      if(command.constructor.name==='HeadBucketCommand') throw Object.assign(new Error(),{$metadata:{httpStatusCode:404}});
      throw denied;
    });
    const ensure=createHelpStorageGuard(client as any,'private');
    for(let i=0;i<2;i++) await expect(ensure()).rejects.toMatchObject({code:'HELP_STORAGE_UNAVAILABLE',status:503});
    expect(client.send).toHaveBeenCalledTimes(4);
    expect(client.send.mock.calls.every(([command])=>command.input.Bucket==='private')).toBe(true);
  });
  test('denied privacy inspection is not treated as private',async()=>{
    await expect(createHelpStorageGuard(mockClient(denied) as any,'private')()).rejects.toMatchObject({code:'HELP_STORAGE_UNAVAILABLE'});
  });
  test('missing bucket or unknown404 is not mistaken for a missing policy',async()=>{
    await expect(createHelpStorageGuard(mockClient(Object.assign(new Error(),{name:'NoSuchBucket',$metadata:{httpStatusCode:404}})) as any,'private')()).rejects.toMatchObject({code:'HELP_STORAGE_UNAVAILABLE'});
  });
  test('object storage errors map503 but preserve range416',async()=>{
    await expect(helpStorageRequest(async()=>{throw denied;})).rejects.toMatchObject({code:'HELP_STORAGE_UNAVAILABLE'});
    const range={$metadata:{httpStatusCode:416}};
    await expect(helpStorageRequest(async()=>{throw range;})).rejects.toBe(range);
  });
});
