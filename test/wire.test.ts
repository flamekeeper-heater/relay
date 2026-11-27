import { describe, expect, it } from 'vitest';
import {
  Op,
  authSignedBytes,
  decodeAuth,
  decodeClose,
  decodeRoster,
  encodeChallenge,
  encodeClose,
  encodeOpen,
} from '../src/wire';
import { concat, hex, toHex } from './bytes';

function auth(o: { key?: number; sig?: number; extra?: number } = {}): Uint8Array {
  const key = new Uint8Array(o.key ?? 65);
  key[0] = 4;
  return concat(new Uint8Array([0, Op.auth]), key, new Uint8Array(o.sig ?? 64).fill(7), new Uint8Array(o.extra ?? 0));
}

function roster(entries: Array<[number, number]>): Uint8Array {
  return concat(
    new Uint8Array([0, Op.roster]),
    ...entries.map(([slot, fill]) => concat(new Uint8Array([slot]), new Uint8Array(32).fill(fill))),
  );
}

describe('control messages', () => {
  it('encodes CHALLENGE, OPEN and CLOSE', () => {
    const c = new Uint8Array(32).fill(0xab);
    expect(toHex(encodeChallenge(c))).toBe('0001' + 'ab'.repeat(32));
    expect(toHex(encodeOpen(1, 2))).toBe('00040102');
    expect(toHex(encodeClose(1, 4001))).toBe('000501a10f');
    expect(decodeClose(encodeClose(2, 4001))).toEqual({ channel: 2, code: 4001 });
    expect(decodeClose(new Uint8Array([0, 5, 1, 0]))).toBeNull();
    expect(decodeClose(new Uint8Array([0, 5, 1, 0, 0, 0]))).toBeNull();
  });

  it('builds the signed bytes of AUTH (the vector)', () => {
    expect(toHex(authSignedBytes(new Uint8Array(32).fill(1), 'relay.flamekeeper.app'))).toBe(
      '666b312072656c617920626f61726401010101010101010101010101010101010101010101010101010101010101011572656c61792e666c616d656b65657065722e617070',
    );
  });

  it('refuses a malformed AUTH', () => {
    expect(decodeAuth(auth({ key: 64 }))).toBeNull();
    expect(decodeAuth(auth({ sig: 63 }))).toBeNull();
    expect(decodeAuth(auth({ extra: 1 }))).toBeNull();
    expect(decodeAuth(auth())).not.toBeNull();
    expect(decodeAuth(new Uint8Array([0, 2]))).toBeNull();
  });

  it('reads the ROSTER vector', () => {
    const r = decodeRoster(hex('000302d91429cfba5c46b38cfeb129eb4f263b616323ad4d7c20aeb3430d641258e834'))!;
    expect([...r.keys()]).toEqual([2]);
    expect(toHex(r.get(2)!)).toBe('d91429cfba5c46b38cfeb129eb4f263b616323ad4d7c20aeb3430d641258e834');
  });

  it('refuses a malformed ROSTER', () => {
    expect(decodeRoster(roster([[8, 1]]))).toBeNull();
    expect(decodeRoster(roster([[3, 1], [3, 2]]))).toBeNull();
    expect(decodeRoster(roster([0, 1, 2, 3, 4, 5, 6, 7, 0].map((s, i) => [i < 8 ? s : 7, 1] as [number, number])))).toBeNull();
    expect(decodeRoster(concat(roster([[0, 1]]), new Uint8Array(1)))).toBeNull();
    expect(decodeRoster(roster([[0, 1]]).subarray(0, 34))).toBeNull();
    expect(decodeRoster(new Uint8Array([0, 3]))).toEqual(new Map());
  });
});
