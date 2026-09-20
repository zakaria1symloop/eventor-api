/**
 * Multer limits for single-file routes: the file size cap (services then check the
 * stricter platform setting), one file, and a few small text fields, so a multipart
 * body cannot smuggle megabytes of form fields past the JSON body limit.
 */
export function uploadLimits(maxMb: number) {
  return { fileSize: maxMb * 1024 * 1024, files: 1, fields: 20, fieldSize: 64 * 1024, parts: 21 };
}
