import { describe, expect, it } from 'vitest';
import {
  Close,
  MAX_MESSAGE,
  Op,
  SUBPROTOCOL,
  authSignedBytes,
  decodeAuth,
  decodeClose,
  decodeRoster,
  encodeChallenge,
  encodeClose,
  encodeOpen,
  encodeWant,
} from '../src/wire';
import { P256_G, concat, sha256, toHex } from './bytes';

const enc = new TextEncoder();

function auth(o: { key?: number; sig?: number; firmware?: Uint8Array; extra?: number } = {}): Uint8Array {
  const fw = o.firmware ?? enc.encode('1.4.0');
  const key = new Uint8Array(o.key ?? 65);
  key[0] = 4;
  return concat(
    new Uint8Array([0, Op.auth]),
    key,
    new Uint8Array(o.sig ?? 64).fill(7),
    new Uint8Array([fw.length]),
    fw,
    new Uint8Array(o.extra ?? 0),
  );
}

function roster(format: number, entries: Array<[number, number]>): Uint8Array {
  return concat(
    new Uint8Array([0, Op.roster, format]),
    ...entries.map(([slot, fill]) => concat(new Uint8Array([slot]), new Uint8Array(32).fill(fill))),
  );
}

describe('wire constants', () => {
  it('match PROTOCOL.md', () => {
    expect(SUBPROTOCOL).toBe('flamekeeper-relay.v1');
    expect(MAX_MESSAGE).toBe(2048);
    expect(Op).toEqual({ challenge: 1, auth: 2, roster: 3, open: 4, close: 5, push: 6, live: 7, want: 8 });
    expect(Close).toEqual({
      replaced: 4001,
      authFailed: 4002,
      notPaired: 4003,
      offline: 4004,
      full: 4005,
      policy: 4008,
    });
  });
});

describe('control messages', () => {
  it('encodes CHALLENGE, OPEN and CLOSE', () => {
    const c = new Uint8Array(32).fill(0xab);
    expect(toHex(encodeChallenge(c))).toBe('0001' + 'ab'.repeat(32));
    expect(toHex(encodeOpen(1, 2))).toBe('00040102');
    expect(toHex(encodeWant(0, 0))).toBe('00080000');
    expect(toHex(encodeWant(0x81, 0x04))).toBe('00088104');
    expect(toHex(encodeClose(1, 4001))).toBe('000501a10f');
    expect(decodeClose(encodeClose(2, 4001))).toEqual({ channel: 2, code: 4001 });
    expect(decodeClose(new Uint8Array([0, 5, 1, 0]))).toBeNull();
    expect(decodeClose(new Uint8Array([0, 5, 1, 0, 0, 0]))).toBeNull();
  });

  it('builds the signed bytes of AUTH', async () => {
    const b = authSignedBytes(new Uint8Array(32).fill(1), 'relay.flamekeeper.app', '1.4.0');
    expect(b.length).toBe(75);
    expect(toHex(await sha256(b))).toBe('74fb627cbe5d30589bd59e83f30b9e88c4d78629a0111bd22f2d516259d54600');
  });

  it('decodes AUTH', () => {
    const a = decodeAuth(concat(new Uint8Array([0, 2]), P256_G, new Uint8Array(64).fill(9), new Uint8Array([3]), enc.encode('1.0')));
    expect(a).not.toBeNull();
    expect(toHex(a!.publicKey)).toBe(toHex(P256_G));
    expect(toHex(a!.signature)).toBe('09'.repeat(64));
    expect(a!.firmware).toBe('1.0');
    expect(decodeAuth(auth({ firmware: new Uint8Array(32).fill(0x31) }))!.firmware).toBe('1'.repeat(32));
    expect(decodeAuth(auth({ firmware: new Uint8Array(0) }))!.firmware).toBe('');
  });

  it('refuses a malformed AUTH', () => {
    expect(decodeAuth(auth({ key: 64 }))).toBeNull();
    expect(decodeAuth(auth({ sig: 63 }))).toBeNull();
    expect(decodeAuth(auth({ firmware: new Uint8Array(33).fill(0x31) }))).toBeNull();
    expect(decodeAuth(auth({ extra: 1 }))).toBeNull();
    expect(decodeAuth(auth({ firmware: new Uint8Array([0xff]) }))).toBeNull();
    expect(decodeAuth(new Uint8Array([0, 2]))).toBeNull();
  });

  it('decodes ROSTER', () => {
    expect(decodeRoster(roster(1, []))!.size).toBe(0);
    const eight = decodeRoster(roster(1, [0, 1, 2, 3, 4, 5, 6, 7].map((s) => [s, s + 0x10] as [number, number])))!;
    expect(eight.size).toBe(8);
    expect(toHex(eight.get(7)!)).toBe('17'.repeat(32));
  });

  it('refuses a malformed ROSTER', () => {
    expect(decodeRoster(roster(2, []))).toBeNull();
    expect(decodeRoster(roster(1, [[8, 1]]))).toBeNull();
    expect(decodeRoster(roster(1, [[3, 1], [3, 2]]))).toBeNull();
    expect(decodeRoster(roster(1, [0, 1, 2, 3, 4, 5, 6, 7, 0].map((s, i) => [i < 8 ? s : 7, 1] as [number, number])))).toBeNull();
    expect(decodeRoster(concat(roster(1, [[0, 1]]), new Uint8Array(1)))).toBeNull();
    expect(decodeRoster(roster(1, [[0, 1]]).subarray(0, 34))).toBeNull();
    expect(decodeRoster(new Uint8Array([0, 3]))).toBeNull();
  });
});
