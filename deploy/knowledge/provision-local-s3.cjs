/* Run in a one-shot container on the knowledge network with only its private S3 env. */
const { S3Client, HeadBucketCommand, CreateBucketCommand, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { randomUUID } = require('node:crypto');
async function main() {
  const endpoint = 'http://knowledge-s3:9000';
  const bucket = 'leader-knowledge-126';
  const s3 = new S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true,
    credentials: { accessKeyId: process.env.RUSTFS_ACCESS_KEY, secretAccessKey: process.env.RUSTFS_SECRET_KEY } });
  try {
    try { await s3.send(new HeadBucketCommand({ Bucket: bucket })); }
    catch (error) {
      if (error.$metadata?.httpStatusCode !== 404) throw error;
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    }
    const key = '.deployment-probe/' + randomUUID() + '.txt';
    try {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: 'knowledge-126-private-s3-probe' }));
      const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (await result.Body.transformToString() !== 'knowledge-126-private-s3-probe') throw Error('S3 roundtrip mismatch');
      const response = await fetch(endpoint + '/' + bucket + '/' + key, { signal: AbortSignal.timeout(5000) });
      await response.body?.cancel();
      if (response.status !== 403) throw Error('Anonymous object access was not denied');
    } finally {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    }
    console.log(JSON.stringify({ bucket, location: 'server-126', roundtripVerified: true, anonymousReadDenied: true }));
  } finally { s3.destroy(); }
}
main().catch(error => { console.error('Local S3 setup failed:', error.name); process.exitCode = 1; });
