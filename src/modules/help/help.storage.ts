import { S3Client, S3ClientConfig, HeadBucketCommand, CreateBucketCommand, GetBucketPolicyCommand, GetBucketAclCommand } from '@aws-sdk/client-s3';

export class HelpStorageError extends Error {
  readonly status=503;
  constructor(readonly code='HELP_STORAGE_UNAVAILABLE',message='Хранилище вложений временно недоступно. Попробуйте позже или обратитесь к администратору.') { super(message); }
}

/** Independent client: Help overrides never alter shared file storage. */
export function helpStorageConfig(env:NodeJS.ProcessEnv):S3ClientConfig {
  // Never combine one dedicated key with the other shared key.
  const dedicatedKeys=!!(env.HELP_S3_ACCESS_KEY||env.HELP_S3_SECRET_KEY);
  return {
    endpoint:env.HELP_S3_ENDPOINT||env.S3_ENDPOINT,
    region:env.HELP_S3_REGION||env.S3_REGION||'us-east-1',forcePathStyle:true,
    credentials:{accessKeyId:dedicatedKeys?env.HELP_S3_ACCESS_KEY||'':env.S3_ACCESS_KEY||'',secretAccessKey:dedicatedKeys?env.HELP_S3_SECRET_KEY||'':env.S3_SECRET_KEY||''},
  };
}
export const helpS3=new S3Client(helpStorageConfig(process.env));
// Existing private storage is supported; the guard below still rejects public
// policies/ACLs. An explicit dedicated bucket remains available when required.
export function resolveHelpBucket(env:NodeJS.ProcessEnv):string {
  return env.HELP_S3_BUCKET||env.S3_BUCKET||'leader-product';
}
export const helpBucket=resolveHelpBucket(process.env);

export async function helpStorageRequest<T>(operation:()=>Promise<T>):Promise<T> {
  try { return await operation(); }
  catch(error:any) {
    if(error instanceof HelpStorageError||error?.$metadata?.httpStatusCode===416) throw error;
    // No messages, request headers, credentials, endpoints or object keys in logs.
    console.warn('[help] storage unavailable',{name:error?.name,code:error?.Code||error?.code,status:error?.$metadata?.httpStatusCode});
    throw new HelpStorageError();
  }
}

export function createHelpStorageGuard(client:Pick<S3Client,'send'>,bucket:string,now=Date.now) {
  let pending:Promise<void>|null=null;
  let checkedAt=0;
  return async()=>{
    if(pending&&now()-checkedAt<60_000) return pending;
    checkedAt=now();
    pending=helpStorageRequest(async()=>{
      try { await client.send(new HeadBucketCommand({Bucket:bucket})); }
      catch(error:any) {
        if(error?.$metadata?.httpStatusCode!==404) throw error;
        await client.send(new CreateBucketCommand({Bucket:bucket}));
      }
      try {
        const policy=await client.send(new GetBucketPolicyCommand({Bucket:bucket}));
        const raw=JSON.parse(policy.Policy||'{}').Statement||[];
        const statements=Array.isArray(raw)?raw:[raw];
        if(statements.some((s:any)=>s.Effect==='Allow'&&(s.Principal==='*'||JSON.stringify(s.Principal||{}).includes('"*"')))) {
          throw new HelpStorageError('HELP_STORAGE_NOT_PRIVATE','Хранилище вложений не настроено как приватное');
        }
      } catch(error:any) {
        // A missing policy is private; missing bucket/denied inspection is NOT proof of privacy.
        if(error?.name!=='NoSuchBucketPolicy'&&error?.Code!=='NoSuchBucketPolicy') throw error;
      }
      const acl=await client.send(new GetBucketAclCommand({Bucket:bucket}));
      if((acl.Grants||[]).some(grant=>grant.Grantee?.URI?.endsWith('/AllUsers')||grant.Grantee?.URI?.endsWith('/AuthenticatedUsers'))) {
        throw new HelpStorageError('HELP_STORAGE_NOT_PRIVATE','Хранилище вложений не настроено как приватное');
      }
    }).catch(error=>{pending=null;throw error;});
    return pending;
  };
}
export const ensureHelpBucket=createHelpStorageGuard(helpS3,helpBucket);
