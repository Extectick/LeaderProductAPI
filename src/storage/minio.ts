import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "node:crypto";
import path from "node:path";
import type { Prisma, AttachmentType } from "@prisma/client";
import { signFileToken } from "../utils/fileTokens";

/**
 * Требуемые env:
 *  - S3_ENDPOINT        (например: http://localhost:9010 или https://s3.example.com)
 *  - S3_REGION          (по умолчанию us-east-1)
 *  - S3_ACCESS_KEY
 *  - S3_SECRET_KEY
 *  - S3_BUCKET          (leader-product-dev / leader-product-prod)
 *  - S3_PUBLIC_BASE     (опц., если есть CDN/публичный прокси; напр. https://cdn.example.com/<bucket>)
 *  - FILES_BASE_URL     (опц., если отдаём файлы через API; напр. https://api.example.com)
 *  - FILES_REQUIRE_TOKEN (опц., 1 = требовать токен для /files)
 *  - FILES_TOKEN_TTL     (опц., ttl токена в секундах)
 *  - FILE_TOKEN_SECRET   (опц., отдельный секрет для файловых токенов)
 *  - PRESIGN_PUT_TTL    (сек., по умолчанию 600)
 *  - PRESIGN_GET_TTL    (сек., по умолчанию 600)
 *  - S3_KEY_PREFIX      (опц., базовый префикс для ключей; по умолчанию "uploads")
 */

 const {
  S3_ENDPOINT,
  S3_REGION = "us-east-1",
  S3_ACCESS_KEY,
  S3_SECRET_KEY,
  S3_BUCKET,
  S3_PUBLIC_BASE,
  S3_PRESIGN_ENDPOINT,
  FILES_BASE_URL,
  DOMEN_URL,
  FILES_REQUIRE_TOKEN,
  FILES_TOKEN_TTL,
  PRESIGN_PUT_TTL = "600",
  PRESIGN_GET_TTL = "600",
  S3_KEY_PREFIX = "uploads",
} = process.env;

console.log(S3_BUCKET + ' и ' + S3_ENDPOINT)

if (!S3_ENDPOINT || !S3_ACCESS_KEY || !S3_SECRET_KEY || !S3_BUCKET) {
  console.warn(
    "[minio] S3 env vars missing. Required: S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET"
  );
}

export const s3 = new S3Client({
  endpoint: S3_ENDPOINT,
  region: S3_REGION,
  forcePathStyle: true,
  credentials: {
    accessKeyId: S3_ACCESS_KEY || "",
    secretAccessKey: S3_SECRET_KEY || "",
  },
});

const presignClient = new S3Client({
  endpoint: S3_PRESIGN_ENDPOINT || S3_ENDPOINT,
  region: S3_REGION,
  forcePathStyle: true,
  credentials: {
    accessKeyId: S3_ACCESS_KEY || "",
    secretAccessKey: S3_SECRET_KEY || "",
  },
});

export function attachmentTypeByMime(mime?: string): AttachmentType {
  if (mime?.startsWith("image/")) return "IMAGE";
  if (mime?.startsWith("audio/")) return "AUDIO";
  return "FILE";
}

function safeFilename(original?: string) {
  const base = (original || "file").normalize("NFC");
  const cleaned = base.replace(/[^\p{L}\p{N}.\- _]+/gu, "_");
  const collapsed = cleaned.replace(/\s+/g, " ").trim();
  const trimmed = collapsed.length > 150 ? collapsed.slice(0, 150) : collapsed;
  return trimmed || "file";
}

function decodeLatin1ToUtf8(input: string) {
  return Buffer.from(input, "latin1").toString("utf8");
}

function looksMojibake(name: string) {
  const hasCyrillic = /[\u0400-\u04FF]/.test(name);
  const hasReplacement = name.includes("�");
  const hasMojibakeChars = /[ÃÂÐÑ]/.test(name);
  return !hasCyrillic && (hasReplacement || hasMojibakeChars);
}

function normalizeOriginalName(original?: string) {
  const raw = (original || "file").normalize("NFC");
  if (!looksMojibake(raw)) return raw;
  const decoded = decodeLatin1ToUtf8(raw);
  if (/[\u0400-\u04FF]/.test(decoded)) return decoded;
  return raw;
}

function safeAsciiFilename(original?: string) {
  const base = (original || "file").normalize("NFC");
  const ascii = base
    .replace(/[^\x20-\x7E]+/g, "_")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/[;]+/g, "_");
  const collapsed = ascii.replace(/\s+/g, " ").trim();
  const trimmed = collapsed.length > 150 ? collapsed.slice(0, 150) : collapsed;
  return trimmed || "file";
}

function buildContentDisposition(original?: string) {
  const unicodeName = safeFilename(original);
  const asciiFallback = safeAsciiFilename(unicodeName);
  const encoded = encodeURIComponent(unicodeName);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

export function buildObjectKey(originalName?: string, keyPrefix = S3_KEY_PREFIX) {
  const normalized = normalizeOriginalName(originalName);
  const ext = path.extname(normalized || "");
  const name = safeFilename(normalized);
  const hash = crypto.randomBytes(4).toString("hex");
  const key = `${keyPrefix}/${Date.now()}_${hash}${ext || ""}`;
  return { key, fileName: name, ext };
}

function publicUrlOrNull(key: string): string | null {
  if (!S3_PUBLIC_BASE) return null;
  const base = S3_PUBLIC_BASE.replace(/\/+$/, "");
  return `${base}/${encodeURI(key)}`;
}

function encodeKeyForPath(key: string) {
  return key
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

/** Presign PUT — клиент грузит напрямую в MinIO */
export async function presignPut(
  key: string,
  contentType = "application/octet-stream",
  ttlSec = Number(PRESIGN_PUT_TTL)
) {
  const cmd = new PutObjectCommand({
    Bucket: S3_BUCKET!,
    Key: key,
    ContentType: contentType,
  });
  const url = await getSignedUrl(presignClient, cmd, { expiresIn: ttlSec });
  return { bucket: S3_BUCKET!, key, url, expiresIn: ttlSec };
}

/** Presign GET — временная ссылка на скачивание */
export async function presignGet(
  key: string,
  ttlSec = Number(PRESIGN_GET_TTL)
) {
  const cmd = new GetObjectCommand({
    Bucket: S3_BUCKET!,
    Key: key,
  });
  const url = await getSignedUrl(presignClient, cmd, { expiresIn: ttlSec });
  return { bucket: S3_BUCKET!, key, url, expiresIn: ttlSec };
}

function extractKeyFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/^\/+/, '');
    if (S3_BUCKET && path.startsWith(`${S3_BUCKET}/`)) {
      return path.slice(S3_BUCKET.length + 1);
    }
  } catch {}
  return null;
}

export async function resolveObjectUrl(value?: string | null): Promise<string | null> {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const key = raw.startsWith('http') ? extractKeyFromUrl(raw) : raw;
  if (!key) return raw;

  if (S3_PUBLIC_BASE) {
    const base = S3_PUBLIC_BASE.replace(/\/+$/, '');
    return `${base}/${encodeURI(key)}`;
  }

  const filesBase = (FILES_BASE_URL || DOMEN_URL || '').trim().replace(/\/+$/, '');
  if (filesBase) {
    const path = `${filesBase}/files/${encodeKeyForPath(key)}`;
    if (FILES_REQUIRE_TOKEN === '1') {
      const ttl = Number(FILES_TOKEN_TTL || 600);
      const token = signFileToken(key, ttl);
      return `${path}?token=${encodeURIComponent(token)}`;
    }
    return path;
  }

  const presigned = await presignGet(key);
  return presigned.url;
}

/** Заливка буфера в MinIO */
export async function uploadBuffer(
  key: string,
  buffer: Buffer,
  contentType = "application/octet-stream",
  asAttachment = false,
  originalName?: string
) {
  const contentDisposition = asAttachment ? buildContentDisposition(originalName) : undefined;

  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET!,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      ContentDisposition: contentDisposition,
    })
  );

  const p = publicUrlOrNull(key);
  const url =
    p ??
    (await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: S3_BUCKET!, Key: key }),
      { expiresIn: Number(PRESIGN_GET_TTL) }
    ));

  return { bucket: S3_BUCKET!, key, url, contentType };
}

/** Удаление объекта в MinIO */
export async function deleteObject(key: string) {
  await s3.send(
    new DeleteObjectCommand({
      Bucket: S3_BUCKET!,
      Key: key,
    })
  );
  return { bucket: S3_BUCKET!, key };
}

/** Заливка файла из multer */
export async function uploadMulterFile(
  file: Express.Multer.File,
  asAttachment = false,
  keyPrefix = S3_KEY_PREFIX
) {
  const normalized = normalizeOriginalName(file.originalname);
  const ext = path.extname(normalized || "");
  const name = safeFilename(normalized);
  const hash = crypto.createHash("sha1").update(file.buffer).digest("hex").slice(0, 8);
  const key = `${keyPrefix}/${Date.now()}_${hash}${ext || ""}`;

  const { url, bucket } = await uploadBuffer(
    key,
    file.buffer,
    file.mimetype || "application/octet-stream",
    asAttachment,
    normalized
  );

  return {
    bucket,
    key,
    url,
    fileName: name,
    contentType: file.mimetype || "application/octet-stream",
    size: file.size ?? file.buffer.length,
  };
}

/* ===== Хелперы с записью в БД (AppealAttachment) ===== */

type AttachmentDB = { appealAttachment: Prisma.AppealAttachmentDelegate<any> };

/** Один файл: залить в MinIO и создать AppealAttachment */
export async function saveAppealAttachment(
  db: AttachmentDB,
  messageId: number,
  file: Express.Multer.File,
  asAttachment = false,
  keyPrefix = S3_KEY_PREFIX
) {
  const stored = await uploadMulterFile(file, asAttachment, keyPrefix);
  const fileType = attachmentTypeByMime(file.mimetype);

  return db.appealAttachment.create({
    data: {
      messageId,
      fileUrl: stored.key,
      fileName: stored.fileName,
      fileType,
    },
  });
}

/** Массив файлов: залить и создать записи AppealAttachment */
export async function saveAppealAttachments(
  db: AttachmentDB,
  messageId: number,
  files: Express.Multer.File[] | undefined,
  asAttachment = false,
  keyPrefix = S3_KEY_PREFIX
) {
  const list = files ?? [];
  const results = [];
  for (const f of list) {
    results.push(await saveAppealAttachment(db, messageId, f, asAttachment, keyPrefix));
  }
  return results;
}

export default {
  s3,
  presignPut,
  presignGet,
  uploadBuffer,
  deleteObject,
  uploadMulterFile,
  saveAppealAttachment,
  saveAppealAttachments,
  attachmentTypeByMime,
};
