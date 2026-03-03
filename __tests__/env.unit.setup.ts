import path from 'path';
import dotenv from 'dotenv';

process.env.NODE_ENV = 'test';

const DEFAULT_LOCAL_TEST_DATABASE_URL =
  'postgresql://postgres:postgres@127.0.0.1:54329/LeaderAPI_test?schema=public';

dotenv.config({ path: path.resolve(process.cwd(), '.env.test') });

process.env.DATABASE_URL =
  process.env.DATABASE_URL || process.env.TEST_DATABASE_URL || DEFAULT_LOCAL_TEST_DATABASE_URL;
process.env.REDIS_DISABLE = process.env.REDIS_DISABLE || '1';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6389';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret';
process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || process.env.JWT_SECRET;
process.env.REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || 'test_refresh_secret';
