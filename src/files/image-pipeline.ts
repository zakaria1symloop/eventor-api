import sharp from 'sharp';
import { FileVariantKind } from '../common/enums/file.enums.js';

export interface ProcessedImage {
  buffer: Buffer;
  width: number;
  height: number;
  sizeBytes: number;
  mimeType: 'image/webp';
}

export interface ImagePipelineOptions {
  /** Longest side of the main image (`photo_max_dimension_px`). */
  maxDimension: number;
  /** WebP quality 1–100 (`photo_quality`). */
  quality: number;
}

/** Longest side of each generated variant. */
export const VARIANT_SIZES: Partial<Record<FileVariantKind, number>> = {
  [FileVariantKind.Thumb]: 320,
  [FileVariantKind.Medium]: 800,
};

/**
 * Photo rules (docs/db-schema.md §2): rotate upright from EXIF, strip all
 * metadata (sharp drops EXIF/ICC/XMP unless asked to keep it), convert to WebP,
 * cap the longest side, never enlarge. Produces the main image plus the thumb
 * and medium variants.
 */
export async function processImage(
  input: Buffer,
  options: ImagePipelineOptions,
): Promise<{ main: ProcessedImage; variants: Partial<Record<FileVariantKind, ProcessedImage>> }> {
  const quality = Math.min(100, Math.max(1, Math.round(options.quality)));
  const upright = sharp(input, { failOn: 'error' }).rotate();

  const render = async (maxSide: number): Promise<ProcessedImage> => {
    const { data, info } = await upright
      .clone()
      .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
      .webp({ quality })
      .toBuffer({ resolveWithObject: true });
    return {
      buffer: data,
      width: info.width,
      height: info.height,
      sizeBytes: data.length,
      mimeType: 'image/webp',
    };
  };

  const main = await render(options.maxDimension);
  const variants: Partial<Record<FileVariantKind, ProcessedImage>> = {};
  for (const [kind, size] of Object.entries(VARIANT_SIZES) as [FileVariantKind, number][]) {
    variants[kind] = await render(size);
  }
  return { main, variants };
}
