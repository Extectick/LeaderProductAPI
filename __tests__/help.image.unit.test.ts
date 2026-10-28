import sharp from 'sharp';
import { helpImageMetadata, HELP_THUMBNAIL_MAX_BYTES } from '../src/modules/help/help.image';

describe('private Help image previews', () => {
  test('EXIF rotation produces display dimensions and a tiny stripped preview', async () => {
    const original = await sharp({create:{width:80,height:40,channels:3,background:'#8040ff'}}).jpeg().withMetadata({orientation:6}).toBuffer();
    const copy = Buffer.from(original);
    const metadata = await helpImageMetadata(original);
    expect(metadata).toMatchObject({width:40,height:80});
    expect(metadata.thumbnailDataUri).toMatch(/^data:image\/jpeg;base64,/);
    expect(Buffer.byteLength(metadata.thumbnailDataUri!)).toBeLessThanOrEqual(HELP_THUMBNAIL_MAX_BYTES);
    const preview = await sharp(Buffer.from(metadata.thumbnailDataUri!.split(',')[1],'base64')).metadata();
    expect(preview).toMatchObject({width:12,height:24,format:'jpeg'});
    expect(preview.exif).toBeUndefined();expect(preview.orientation).toBeUndefined();
    expect(original.equals(copy)).toBe(true);
  });
  test('small transparent images keep original dimensions without oversized previews', async () => {
    const original = await sharp({create:{width:8,height:6,channels:4,background:{r:255,g:0,b:0,alpha:0.4}}}).png().toBuffer();
    const metadata = await helpImageMetadata(original);
    expect(metadata).toMatchObject({width:8,height:6});
    expect(metadata.thumbnailDataUri).toMatch(/^data:image\/jpeg;base64,/);
    expect(Buffer.byteLength(metadata.thumbnailDataUri!)).toBeLessThanOrEqual(HELP_THUMBNAIL_MAX_BYTES);
  });
  test('unsupported/corrupt images retain the ordinary private-file fallback', async () => {
    expect(await helpImageMetadata(Buffer.from('not an image'))).toEqual({width:null,height:null,thumbnailDataUri:null});
  });
});
