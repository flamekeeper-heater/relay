import { afterEach, describe, expect, it, vi } from 'vitest';
import { apnsForBlob } from '../src/push/apnsMessage';
import { decodePush } from '../src/wire';
import { concat, hex, sha256, toHex } from './bytes';
import { type FakeBoardSocket, eventually, fakeBoard, fakeSender, logged, register, rows, setClock } from './fakes';

// The test vectors in PROTOCOL.md: a class 1 PUSH for slot 2, and its blob.
const PUSH_MESSAGE =
  '000601010253c0c1c2c3c4c5c6c7c8c9cacb4876b3e19822be890adb585de818669c2c976e95c2954fd98602d395ed91fa37070d498a90e599316ce1c94aa597c5658e883dca81b7903a416591331330ae3f75cf565b785d73';
const PUSH_BLOB =
  'c0c1c2c3c4c5c6c7c8c9cacb4876b3e19822be890adb585de818669c2c976e95c2954fd98602d395ed91fa37070d498a90e599316ce1c94aa597c5658e883dca81b7903a416591331330ae3f75cf565b785d73';

// The relay token of the Wi-Fi key secret 32 × 09, and its hash (PROTOCOL.md).
const T = hex('16c1df6a87aaeae336a68c3cb93442b2246922a2edaee096e2439ee205578c0a');
const H = hex('d91429cfba5c46b38cfeb129eb4f263b616323ad4d7c20aeb3430d641258e834');
const T1 = hex('01'.repeat(32));
const DEVICE_1 = 'bb'.repeat(32);
const DEVICE_2 = 'aa'.repeat(32);
const ID = 'ngf6uy64isruizr76fbjv2qqqq';
const NOW = 1_900_000_000_000;

/** `00 06` ‖ class ‖ n ‖ n × (slot, length, blob). */
function pushMessage(cls: number, entries: Array<[slot: number, blob: Uint8Array]>): Uint8Array {
  return concat(
    new Uint8Array([0, 6, cls, entries.length]),
    ...entries.map(([slot, blob]) => concat(new Uint8Array([slot, blob.length]), blob)),
  );
}

function blob(fill: number, length = 40): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

function base64(b: Uint8Array): string {
  return btoa(String.fromCharCode(...b));
}

interface Aps {
  alert: { title: string; body: string };
  'mutable-content': number;
  'interruption-level': string;
  sound?: unknown;
  'thread-id': string;
}

function aps(p: Record<string, unknown>): Aps {
  return p.aps as Aps;
}

/** A signed-in board with phones in slots 1 (T1, production) and 2 (T, sandbox), both registered. */
async function boardWithPhones(): Promise<FakeBoardSocket> {
  const b = await fakeBoard();
  await b.signIn();
  b.roster([
    [1, await sha256(T1)],
    [2, H],
  ]);
  expect(toHex(await b.next())).toBe('0008000000');
  await setClock(b.id, NOW);
  expect((await register(b.id, T1, { env: 'production', device: DEVICE_1 })).status).toBe(204);
  expect(toHex(await b.next())).toBe('0008020000');
  expect((await register(b.id, T, { env: 'sandbox', device: DEVICE_2 })).status).toBe(204);
  expect(toHex(await b.next())).toBe('0008060000');
  return b;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PUSH decoding', () => {
  it('reads the vector', () => {
    const p = decodePush(hex(PUSH_MESSAGE))!;
    expect(p.cls).toBe(1);
    expect([...p.blobs].map(([slot, b]) => [slot, toHex(b)])).toEqual([[2, PUSH_BLOB]]);
  });

  it('takes up to 8 unique slots, blobs of 28 bytes or more', () => {
    const eight = Array.from({ length: 8 }, (_, i) => [i, blob(i, 28)] as [number, Uint8Array]);
    expect([...decodePush(pushMessage(3, eight))!.blobs.keys()]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(decodePush(pushMessage(0, []))).toEqual({ cls: 0, blobs: new Map() });
  });

  it('refuses a malformed PUSH', () => {
    const good = pushMessage(1, [[2, blob(1)]]);
    for (const [what, m] of [
      ['class 4', pushMessage(4, [[2, blob(1)]])],
      ['slot 8', pushMessage(1, [[8, blob(1)]])],
      ['a repeated slot', pushMessage(1, [[2, blob(1)], [2, blob(2)]])],
      ['n 9', pushMessage(1, Array.from({ length: 9 }, (_, i) => [i % 8, blob(i)] as [number, Uint8Array]))],
      ['a blob under 28 bytes', pushMessage(1, [[2, blob(1, 27)]])],
      ['a length past the end', good.subarray(0, good.length - 1)],
      ['trailing bytes', concat(good, new Uint8Array([0]))],
      ['n past the end', new Uint8Array([0, 6, 1, 1])],
      ['no n', new Uint8Array([0, 6, 1])],
      ['another op', concat(new Uint8Array([0, 7]), good.subarray(2))],
    ] as const) {
      expect(decodePush(m), what).toBeNull();
    }
  });
});

describe('APNs message for a blob', () => {
  const b = hex(PUSH_BLOB);

  it('class 2: priority 10, time-sensitive, the default sound', () => {
    const m = apnsForBlob(2, ID, b, false);
    expect(m.priority).toBe(10);
    expect(aps(m.payload)).toEqual({
      alert: { title: 'Flamekeeper', body: 'A heater needs you. Open Flamekeeper.' },
      'mutable-content': 1,
      'interruption-level': 'time-sensitive',
      sound: 'default',
      'thread-id': ID,
    });
    expect(m.payload.fk).toEqual({ v: 1, b: ID, d: base64(b) });
    const d = atob((m.payload.fk as { d: string }).d);
    expect(toHex(Uint8Array.from(d, (c) => c.charCodeAt(0)))).toBe(PUSH_BLOB);
  });

  it('class 1: active; class 0: priority 5, passive and no sound', () => {
    const one = apnsForBlob(1, ID, b, false);
    expect([one.priority, aps(one.payload)['interruption-level'], aps(one.payload).sound]).toEqual([10, 'active', 'default']);
    expect(aps(one.payload).alert.body).toBe('Heater alert. Open Flamekeeper.');
    const zero = apnsForBlob(0, ID, b, false);
    expect(zero.priority).toBe(5);
    expect(aps(zero.payload)['interruption-level']).toBe('passive');
    expect('sound' in aps(zero.payload)).toBe(false);
    expect(aps(zero.payload).alert.body).toBe('Heater update.');
  });

  it('class 3: time-sensitive until critical alerts are on, then critical with the critical sound', () => {
    const plain = apnsForBlob(3, ID, b, false);
    expect(plain.priority).toBe(10);
    expect(aps(plain.payload)['interruption-level']).toBe('time-sensitive');
    expect(aps(plain.payload).sound).toBe('default');
    expect(aps(plain.payload).alert.body).toBe('Heater alarm. Open Flamekeeper now.');
    const critical = apnsForBlob(3, ID, b, true);
    expect(aps(critical.payload)['interruption-level']).toBe('critical');
    expect(aps(critical.payload).sound).toEqual({ critical: 1, name: 'default', volume: 1 });
    expect(aps(critical.payload)['thread-id']).toBe(ID);
  });
});

describe('PUSH fan-out', () => {
  it('sends one APNs item per registered slot', async () => {
    const b = await boardWithPhones();
    const sender = await fakeSender(b.id);
    b.send(pushMessage(1, [[1, blob(1)], [2, blob(2)], [5, blob(5)]]));
    await eventually(async () => (await sender.items()).length === 2);
    const items = (await sender.items()).sort((x, y) => x.token.localeCompare(y.token));
    expect(items.map((i) => [i.env, i.token, i.priority, i.expiration])).toEqual([
      ['sandbox', DEVICE_2, 10, NOW / 1000 + 86_400],
      ['production', DEVICE_1, 10, NOW / 1000 + 86_400],
    ]);
    expect(items[0].payload).toEqual(apnsForBlob(1, b.id, blob(2), false).payload);
    expect(items[1].payload).toEqual(apnsForBlob(1, b.id, blob(1), false).payload);
    expect(await b.quiet()).toBe(true);
  });

  it('skips a slot whose registration has no device', async () => {
    const b = await boardWithPhones();
    expect((await register(b.id, T1, { env: 'production', startToken: 'cc'.repeat(32) })).status).toBe(204);
    expect(toHex(await b.next())).toBe('0008040002');
    const sender = await fakeSender(b.id);
    b.send(pushMessage(1, [[1, blob(1)], [2, blob(2)]]));
    await eventually(async () => (await sender.items()).length === 1);
    expect(await b.quiet()).toBe(true);
    expect((await sender.items()).map((i) => i.token)).toEqual([DEVICE_2]);
  });

  it('forgets a token APNs calls gone', async () => {
    const b = await boardWithPhones();
    const sender = await fakeSender(b.id, (i) => (i.token === DEVICE_1 ? 'gone' : 'sent'));
    b.send(pushMessage(1, [[1, blob(1)], [2, blob(2)]]));
    expect(toHex(await b.next())).toBe('0008040000');
    expect((await rows(b.id, 'registration')).map((r) => r.slot)).toEqual([2]);
    expect((await sender.items()).length).toBe(2);
  });

  it('a failed send keeps the registration', async () => {
    const b = await boardWithPhones();
    const sender = await fakeSender(b.id, () => 'failed');
    b.send(pushMessage(2, [[1, blob(1)], [2, blob(2)]]));
    await eventually(async () => (await sender.items()).length === 2);
    expect(await b.quiet()).toBe(true);
    expect((await rows(b.id, 'registration')).map((r) => r.slot)).toEqual([1, 2]);
  });

  it('drops a PUSH over 20 a minute but never a class 3', async () => {
    const b = await boardWithPhones();
    const sender = await fakeSender(b.id);
    // 41 at once: however the limiter's minute splits them, one minute holds 21.
    for (let i = 0; i < 41; i++) b.send(pushMessage(1, [[2, blob(i)]]));
    b.send(pushMessage(3, [[2, blob(99)]])); // a CO alarm: always
    await eventually(async () => (await sender.items()).some((i) => aps(i.payload).alert.body === 'Heater alarm. Open Flamekeeper now.'));
    expect((await sender.items()).length).toBeLessThan(42);
  });

  it('ignores a malformed PUSH and keeps the board; logs never carry blobs or device tokens', async () => {
    const log = vi.spyOn(console, 'log');
    const b = await boardWithPhones();
    const sender = await fakeSender(b.id);
    const secret = blob(0xab, 60);
    b.send(pushMessage(4, [[2, secret]]));
    b.send(pushMessage(1, [[2, secret]]));
    await eventually(async () => (await sender.items()).length === 1);
    expect(await b.quiet()).toBe(true);
    expect(b.ws.readyState).toBe(WebSocket.OPEN);
    const lines = logged(log);
    expect(lines).toContain(JSON.stringify({ board: b.id, event: 'push malformed' }));
    expect(lines).toContain(JSON.stringify({ board: b.id, event: 'push', sends: [{ push: 'alert', to: 'device', env: 'sandbox', outcome: 'sent' }] }));
    for (const l of lines) {
      expect(l).not.toMatch(/class/); // a line naming the class would say "CO alarm at T"
      expect(l).not.toContain('abab');
      expect(l).not.toContain(base64(secret).slice(0, 16));
      expect(l).not.toContain(DEVICE_2.slice(0, 16));
    }
  });

  it('with an APNs key that does not import every item fails and the log says so', async () => {
    const log = vi.spyOn(console, 'log');
    const b = await boardWithPhones();
    b.send(pushMessage(1, [[2, blob(2)]]));
    await eventually(() => logged(log).some((l) => l.includes('"outcome":"failed"')));
    expect(logged(log).some((l) => l.includes('apns failed'))).toBe(true);
    expect((await rows(b.id, 'registration')).length).toBe(2);
    expect(await b.quiet()).toBe(true);
  });
});
