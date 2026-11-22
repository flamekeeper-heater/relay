// Board ids: the first 16 bytes of SHA-256 of the board's 65-byte uncompressed P-256 public key,
// as 26 lowercase RFC 4648 base32 characters, no padding (PROTOCOL.md).

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const ID_BYTES = 16;
const ID_CHARS = 26;

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

/** Decodes unpadded lowercase base32; null for a foreign character, an impossible length or spare bits set. */
export function base32Decode(s: string): Uint8Array | null {
  const spare = (s.length * 5) % 8;
  if (spare >= 5) return null; // no byte count gives this many characters
  const out = new Uint8Array(Math.floor((s.length * 5) / 8));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (const ch of s) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
    acc &= (1 << bits) - 1;
  }
  if (acc !== 0) return null; // not canonical: the spare bits must be zero
  return out;
}

export function isBoardId(s: string): boolean {
  return s.length === ID_CHARS && base32Decode(s)?.length === ID_BYTES;
}

export async function boardIdOf(publicKey: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', publicKey));
  return base32(digest.subarray(0, ID_BYTES));
}
