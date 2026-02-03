import jwt from 'jsonwebtoken';

const FILE_TOKEN_SECRET =
  process.env.FILE_TOKEN_SECRET ||
  process.env.ACCESS_TOKEN_SECRET ||
  'file-token-secret';

const DEFAULT_TTL = Number(process.env.FILES_TOKEN_TTL || 600);

export function signFileToken(key: string, ttlSec = DEFAULT_TTL) {
  return jwt.sign({ key }, FILE_TOKEN_SECRET, { expiresIn: ttlSec });
}

export function verifyFileToken(token: string, key: string) {
  try {
    const payload = jwt.verify(token, FILE_TOKEN_SECRET) as { key?: string };
    return Boolean(payload?.key && payload.key === key);
  } catch {
    return false;
  }
}
