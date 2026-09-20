import sharp from 'sharp';
import { processImage } from './image-pipeline.js';

async function makeJpeg(width: number, height: number, orientation?: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 30, g: 120, b: 200 } } })
    .jpeg({ quality: 95 })
    .withMetadata({
      ...(orientation ? { orientation } : {}),
      exif: { IFD0: { Copyright: 'Private camera data', Make: 'TestCam' } },
    })
    .toBuffer();
}

describe('processImage', () => {
  it('converts to WebP, caps the longest side and builds thumb/medium variants', async () => {
    const input = await makeJpeg(3000, 1500);
    const { main, variants } = await processImage(input, { maxDimension: 1920, quality: 80 });

    expect(main).toMatchObject({ mimeType: 'image/webp', width: 1920, height: 960 });
    expect((await sharp(main.buffer).metadata()).format).toBe('webp');
    expect(main.sizeBytes).toBe(main.buffer.length);

    expect(variants.thumb).toMatchObject({ width: 320, height: 160 });
    expect(variants.medium).toMatchObject({ width: 800, height: 400 });
  });

  it('strips EXIF and other metadata', async () => {
    const input = await makeJpeg(640, 480);
    expect((await sharp(input).metadata()).exif).toBeDefined();

    const { main, variants } = await processImage(input, { maxDimension: 1920, quality: 80 });
    for (const image of [main, variants.thumb!, variants.medium!]) {
      const meta = await sharp(image.buffer).metadata();
      expect(meta.exif).toBeUndefined();
      expect(meta.icc).toBeUndefined();
      expect(meta.xmp).toBeUndefined();
      expect(image.buffer.includes(Buffer.from('Private camera data'))).toBe(false);
    }
  });

  it('rotates upright from the EXIF orientation', async () => {
    // Orientation 6 = rotate 90° clockwise to display: a 400×200 image shows as 200×400.
    const input = await makeJpeg(400, 200, 6);
    const { main } = await processImage(input, { maxDimension: 1920, quality: 80 });
    expect([main.width, main.height]).toEqual([200, 400]);
  });

  it('never enlarges small images', async () => {
    const input = await makeJpeg(120, 90);
    const { main, variants } = await processImage(input, { maxDimension: 1920, quality: 80 });
    expect([main.width, main.height]).toEqual([120, 90]);
    expect([variants.thumb!.width, variants.medium!.width]).toEqual([120, 120]);
  });

  it('applies the quality setting', async () => {
    // Random pixels: a flat colour compresses to almost nothing at any quality.
    const pixels = Buffer.alloc(600 * 400 * 3);
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 7919) % 251;
    const input = await sharp(pixels, { raw: { width: 600, height: 400, channels: 3 } }).png().toBuffer();
    const low = await processImage(input, { maxDimension: 1920, quality: 10 });
    const high = await processImage(input, { maxDimension: 1920, quality: 100 });
    expect(low.main.sizeBytes).toBeLessThan(high.main.sizeBytes);
  });

  it('fails on a corrupt image', async () => {
    await expect(
      processImage(Buffer.from('not an image'), { maxDimension: 1920, quality: 80 }),
    ).rejects.toThrow();
  });
});
