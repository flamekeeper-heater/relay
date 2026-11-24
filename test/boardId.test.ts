import { describe, expect, it } from 'vitest';
import { base32, boardIdOf } from '../src/boardId';
import { P256_G, hex } from './bytes';

describe('board ids', () => {
  it('names the generator point G as PROTOCOL.md does', async () => {
    expect(await boardIdOf(P256_G)).toBe('ngf6uy64isruizr76fbjv2qqqq');
    expect(base32(hex('698bea63dc44a344663ff1429aea1084'))).toBe('ngf6uy64isruizr76fbjv2qqqq');
  });
});
