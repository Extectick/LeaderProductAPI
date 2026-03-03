import path from 'path';
import dotenv from 'dotenv';

process.env.NODE_ENV = 'test';

const DEFAULT_LOCAL_TEST_DATABASE_URL =
  'postgresql://postgres:postgres@127.0.0.1:54329/LeaderAPI_test?schema=public';
const DEFAULT_LOCAL_TEST_REDIS_URL = 'redis://127.0.0.1:6389';
const DEFAULT_LOCAL_TEST_S3_ENDPOINT = 'http://127.0.0.1:9009';
const DEFAULT_LOCAL_TEST_S3_BUCKET = 'leader-api-test';
const DEFAULT_LOCAL_TEST_S3_ACCESS_KEY = 'minioadmin';
const DEFAULT_LOCAL_TEST_S3_SECRET_KEY = 'minioadmin';

dotenv.config({ path: path.resolve(process.cwd(), '.env.test') });

process.env.DATABASE_URL =
  process.env.DATABASE_URL || process.env.TEST_DATABASE_URL || DEFAULT_LOCAL_TEST_DATABASE_URL;
process.env.REDIS_URL =
  process.env.REDIS_URL || process.env.TEST_REDIS_URL || DEFAULT_LOCAL_TEST_REDIS_URL;
process.env.S3_ENDPOINT =
  process.env.S3_ENDPOINT || process.env.TEST_S3_ENDPOINT || DEFAULT_LOCAL_TEST_S3_ENDPOINT;
process.env.S3_PRESIGN_ENDPOINT =
  process.env.S3_PRESIGN_ENDPOINT ||
  process.env.TEST_S3_PRESIGN_ENDPOINT ||
  process.env.S3_ENDPOINT;
process.env.S3_REGION = process.env.S3_REGION || process.env.TEST_S3_REGION || 'us-east-1';
process.env.S3_BUCKET =
  process.env.S3_BUCKET || process.env.TEST_S3_BUCKET || DEFAULT_LOCAL_TEST_S3_BUCKET;
process.env.S3_ACCESS_KEY =
  process.env.S3_ACCESS_KEY || process.env.TEST_S3_ACCESS_KEY || DEFAULT_LOCAL_TEST_S3_ACCESS_KEY;
process.env.S3_SECRET_KEY =
  process.env.S3_SECRET_KEY || process.env.TEST_S3_SECRET_KEY || DEFAULT_LOCAL_TEST_S3_SECRET_KEY;
delete process.env.REDIS_DISABLE;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret';
process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || process.env.JWT_SECRET;
process.env.REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || 'test_refresh_secret';
