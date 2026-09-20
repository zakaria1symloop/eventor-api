import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';

/**
 * argon2id parameters, pinned rather than left to the library's defaults so a
 * dependency bump can never silently weaken them: 64 MiB of memory, 3 passes,
 * 4 lanes, 32-byte tag. Comfortably above the OWASP minimum (19 MiB, t=2, p=1)
 * and ~100 ms on the target VPS. The cost is encoded in the stored hash, so
 * raising these values later keeps existing hashes verifiable.
 */
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 4,
  hashLength: 32,
} as const;

/** argon2id hashing. `verify` never throws and takes similar time for unknown users. */
@Injectable()
export class PasswordService {
  private dummyHash: Promise<string> | null = null;

  hash(password: string): Promise<string> {
    return argon2.hash(password, ARGON2_OPTIONS);
  }

  async verify(hash: string | null | undefined, password: string): Promise<boolean> {
    if (!hash) {
      this.dummyHash ??= this.hash('dummy-password-for-timing-1');
      await argon2.verify(await this.dummyHash, password).catch(() => false);
      return false;
    }
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }
}
