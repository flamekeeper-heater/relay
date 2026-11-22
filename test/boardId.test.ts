import { describe, expect, it } from 'vitest';
import { base32, base32Decode, boardIdOf, isBoardId } from '../src/boardId';
import { P256_G, hex, toHex } from './bytes';

describe('board ids', () => {
  it('names the generator point G as PROTOCOL.md does', async () => {
    expect(await boardIdOf(P256_G)).toBe('ngf6uy64isruizr76fbjv2qqqq');
    expect(base32(hex('698bea63dc44a344663ff1429aea1084'))).toBe('ngf6uy64isruizr76fbjv2qqqq');
    expect(toHex(base32Decode('ngf6uy64isruizr76fbjv2qqqq')!)).toBe('698bea63dc44a344663ff1429aea1084');
  });

  it('round-trips 16 random bytes', () => {
    for (let i = 0; i < 50; i++) {
      const b = crypto.getRandomValues(new Uint8Array(16));
      const s = base32(b);
      expect(s).toMatch(/^[a-z2-7]{26}$/);
      expect(isBoardId(s)).toBe(true);
      expect(toHex(base32Decode(s)!)).toBe(toHex(b));
    }
  });

  it('round-trips other lengths', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 6, 10, 32]) {
      const b = crypto.getRandomValues(new Uint8Array(n));
      expect(toHex(base32Decode(base32(b))!)).toBe(toHex(b));
    }
  });

  it('accepts only canonical lowercase ids of 26 characters', () => {
    expect(isBoardId('ngf6uy64isruizr76fbjv2qqqq')).toBe(true);
    expect(isBoardId('NGF6UY64ISRUIZR76FBJV2QQQQ')).toBe(false);
    expect(isBoardId('ngf6uy64isruizr76fbjv2qqq')).toBe(false);
    expect(isBoardId('ngf6uy64isruizr76fbjv2qqqqa')).toBe(false);
    expect(isBoardId('ngf6uy64isruizr76fbjv2qqq0')).toBe(false);
    expect(isBoardId('ngf6uy64isruizr76fbjv2qqq1')).toBe(false);
    expect(isBoardId('ngf6uy64isruizr76fbjv2qqq8')).toBe(false);
    expect(isBoardId('ngf6uy64isruizr76fbjv2qqqr')).toBe(false);
    expect(base32Decode('ngf6uy64isruizr76fbjv2qqqr')).toBeNull();
    expect(isBoardId('')).toBe(false);
  });
});
