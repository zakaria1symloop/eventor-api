import { createHmac, timingSafeEqual } from 'node:crypto';

export type SignatureCheck = 'valid' | 'invalid' | 'expired';

/**
 * HMAC-SHA256 signatures for expiring file URLs. The signature covers the file
 * id, the variant and the expiry, so none of them can be changed in the URL.
 */
export class FileSigner {
  constructor(private readonly secret: string) {
    if (!secret) {
      throw new Error('FileSigner needs a secret');
    }
  }

  /** `exp` is a Unix time in seconds. */
  sign(fileId: string, variant: string | null | undefined, exp: number): string {
    return createHmac('sha256', this.secret)
      .update(`${fileId}:${variant ?? ''}:${exp}`)
      .digest('base64url');
  }

  verify(
    fileId: string,
    variant: string | null | undefined,
    exp: number | undefined,
    signature: string | undefined,
    now = Date.now(),
  ): SignatureCheck {
    if (!signature || exp === undefined || !Number.isInteger(exp)) {
      return 'invalid';
    }
    const expected = Buffer.from(this.sign(fileId, variant, exp));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      return 'invalid';
    }
    return exp * 1000 < now ? 'expired' : 'valid';
  }
}
