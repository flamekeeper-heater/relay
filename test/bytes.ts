// Small helpers shared by the tests.

export { concat, sha256, toHex } from '../src/bytes';
import { fromHex } from '../src/bytes';

export function hex(s: string): Uint8Array {
  return fromHex(s.replace(/\s+/g, ''));
}

/** The P-256 generator point G, uncompressed (04 ‖ x ‖ y). */
export const P256_G = hex(
  '04' +
    '6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296' +
    '4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5',
);
