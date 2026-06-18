import path from 'path';
import dotenv from 'dotenv';

process.env.NODE_ENV = 'test';

const DEFAULT_LOCAL_TEST_DATABASE_URL =
  'postgresql://postgres:postgres@127.0.0.1:54329/LeaderAPI_test?schema=public';

dotenv.config({ path: path.resolve(process.cwd(), '.env.test'), quiet: true });

process.env.DATABASE_URL =
  process.env.DATABASE_URL || process.env.TEST_DATABASE_URL || DEFAULT_LOCAL_TEST_DATABASE_URL;
process.env.REDIS_DISABLE = process.env.REDIS_DISABLE || '1';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6389';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret';
process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || process.env.JWT_SECRET;
process.env.REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || 'test_refresh_secret';
process.env.S3_ENDPOINT = process.env.S3_ENDPOINT || 'http://127.0.0.1:9009';
process.env.S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || 'test_access_key';
process.env.S3_SECRET_KEY = process.env.S3_SECRET_KEY || 'test_secret_key';
process.env.S3_BUCKET = process.env.S3_BUCKET || 'test-bucket';
