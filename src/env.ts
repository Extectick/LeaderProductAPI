import path from 'node:path';
import dotenv from 'dotenv';

const ENV = process.env.NODE_ENV;
const envFile =
  ENV === 'production' ? '.env.production' :
  ENV === 'test'       ? '.env.test' :
                         '.env.dev';

dotenv.config({ path: path.resolve(process.cwd(), envFile) });
