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

/**
 * Требуемые env:
 *  - S3_ENDPOINT        (например: http://localhost:9010 или https://s3.example.com)
 *  - S3_REGION          (по умолчанию us-east-1)
 *  - S3_ACCESS_KEY
 *  - S3_SECRET_KEY
 *  - S3_BUCKET          (leader-product-dev / leader-product-prod)
 *  - S3_PUBLIC_BASE     (опц., если есть CDN/публичный прокси; напр. https://cdn.example.com/<bucket>)
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

export function attachmentTypeByMime(mime?: string): AttachmentType {
  if (mime?.startsWith("image/")) return "IMAGE";
  if (mime?.startsWith("audio/")) return "AUDIO";
  return "FILE";
}

function safeFilename(original?: string) {
  const base = (original || "file").replace(/[^\w.\- ]+/g, "_");
  return base.length > 150 ? base.slice(0, 150) : base;
}

function publicUrlOrNull(key: string): string | null {
  if (!S3_PUBLIC_BASE) return null;
  const base = S3_PUBLIC_BASE.replace(/\/+$/, "");
  return `${base}/${encodeURI(key)}`;
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
  const url = await getSignedUrl(s3, cmd, { expiresIn: ttlSec });
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
  const url = await getSignedUrl(s3, cmd, { expiresIn: ttlSec });
  return { bucket: S3_BUCKET!, key, url, expiresIn: ttlSec };
}

/** Заливка буфера в MinIO */
export async function uploadBuffer(
  key: string,
  buffer: Buffer,
  contentType = "application/octet-stream",
  asAttachment = false,
  originalName?: string
) {
  const contentDisposition = asAttachment
    ? `attachment; filename="${safeFilename(originalName)}"`
    : undefined;

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
  const ext = path.extname(file.originalname || "");
  const name = safeFilename(file.originalname);
  const hash = crypto.createHash("sha1").update(file.buffer).digest("hex").slice(0, 8);
  const key = `${keyPrefix}/${Date.now()}_${hash}${ext || ""}`;

  const { url, bucket } = await uploadBuffer(
    key,
    file.buffer,
    file.mimetype || "application/octet-stream",
    asAttachment,
    name
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
      fileUrl: stored.url,      // если бакет приватный, можно хранить stored.key
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
