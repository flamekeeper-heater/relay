// Board ids: the first 16 bytes of SHA-256 of the board's 65-byte uncompressed P-256 public key,
// as 26 lowercase RFC 4648 base32 characters, no padding (PROTOCOL.md).

import { sha256 } from './bytes';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const ID_BYTES = 16;

export function base32(bytes: Uint8Array): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(acc >> bits) & 31];
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

export async function boardIdOf(publicKey: Uint8Array): Promise<string> {
  return base32((await sha256(publicKey)).subarray(0, ID_BYTES));
}
