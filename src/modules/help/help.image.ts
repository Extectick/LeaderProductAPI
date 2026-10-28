import sharp from 'sharp';

export type HelpImageMetadata = { width: number | null; height: number | null; thumbnailDataUri: string | null };
export const HELP_THUMBNAIL_MAX_BYTES = 2048;
const emptyMetadata: HelpImageMetadata = { width: null, height: null, thumbnailDataUri: null };

/** Private, stripped, blurred first-frame preview; the immutable original remains unchanged. */
export async function helpImageMetadata(bytes: Buffer): Promise<HelpImageMetadata> {
  let width: number | null = null, height: number | null = null;
  try {
    // Bound decoder work for oversized/animated uploads. Missing previews retain the existing download fallback.
    const source = sharp(bytes, { limitInputPixels: 64 * 1024 * 1024, pages: 1 });
    const metadata = await source.metadata();
    if (!metadata.width || !metadata.height) return { ...emptyMetadata };
    const rotated = metadata.orientation !== undefined && metadata.orientation >= 5 && metadata.orientation <= 8;
    width = rotated ? metadata.height : metadata.width;
    height = rotated ? metadata.width : metadata.height;
    const preview = await source.rotate().resize(24, 24, { fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#202830' }).blur(0.8).jpeg({ quality: 35, chromaSubsampling: '4:2:0' }).toBuffer();
    const uri = `data:image/jpeg;base64,${preview.toString('base64')}`;
    return { width, height, thumbnailDataUri: Buffer.byteLength(uri, 'utf8') <= HELP_THUMBNAIL_MAX_BYTES ? uri : null };
  } catch {
    // Legacy/unsupported decoders must not turn an otherwise accepted original into a failed upload.
    return { width, height, thumbnailDataUri: null };
  }
}
