import { describe, expect, it } from 'vitest';
import { apnsForOffline } from '../src/push/apnsMessage';
import { hex, sha256, toHex } from './bytes';
import { type FakeBoardSocket, alarmAt, alarmTime, eventually, fakeBoard, fakeSender, meta, register, rows, setClock } from './fakes';

const T = hex('16c1df6a87aaeae336a68c3cb93442b2246922a2edaee096e2439ee205578c0a');
const H = hex('d91429cfba5c46b38cfeb129eb4f263b616323ad4d7c20aeb3430d641258e834');
const T1 = hex('01'.repeat(32));
const DEVICE_1 = 'bb'.repeat(32);
const DEVICE_2 = 'aa'.repeat(32);
const ID = 'ngf6uy64isruizr76fbjv2qqqq';
const T0 = 1_900_000_000_000;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/**
 * A board with phones in slots 1 (T1) and 2 (T), registered with these offline delays, a recording
 * APNs sender, and the board gone at T0.
 */
async function awayWith(after1: number | null, after2: number) {
  const b = await fakeBoard();
  await b.signIn();
  b.roster([
    [1, await sha256(T1)],
    [2, H],
  ]);
  expect(toHex(await b.next())).toBe('0008000000');
  if (after1 !== null) {
    expect((await register(b.id, T1, { env: 'production', device: DEVICE_1, offlineAfter: after1 })).status).toBe(204);
    await b.next();
  }
  expect((await register(b.id, T, { env: 'sandbox', device: DEVICE_2, offlineAfter: after2 })).status).toBe(204);
  await b.next();
  const sender = await fakeSender(b.id);
  await setClock(b.id, T0);
  b.ws.close(1000);
  await b.closed;
  await eventually(async () => (await meta(b.id, 'last_seen')) === T0 / 1000);
  return { b, sender, mask: after1 === null ? '0008040000' : '0008060000' };
}

async function backAt(b: FakeBoardSocket, ms: number, want: string): Promise<FakeBoardSocket> {
  await setClock(b.id, ms);
  const again = await fakeBoard({ keyOf: b.keys });
  await again.signIn(want);
  return again;
}

describe('heater offline watcher', () => {
  it('the offline message: active, the default sound, the board id and when it was last seen, no blob', () => {
    expect(apnsForOffline(ID, 1_900_000_000)).toEqual({
      priority: 10,
      payload: {
        aps: {
          alert: { title: 'Flamekeeper', body: 'A heater is offline. Open Flamekeeper.' },
          'mutable-content': 1,
          'interruption-level': 'active',
          sound: 'default',
          'thread-id': ID,
        },
        fk: { v: 1, b: ID, k: 'offline', t: 1_900_000_000 },
      },
    });
  });

  it('sends one offline push after the phone’s delay', async () => {
    const { b, sender } = await awayWith(null, 30);
    expect(await alarmTime(b.id)).toBe(T0 + 30 * MIN);
    await alarmAt(b.id, T0 + 29 * MIN);
    expect(await sender.items()).toEqual([]);
    await alarmAt(b.id, T0 + 30 * MIN);
    expect(await sender.items()).toEqual([
      {
        env: 'sandbox',
        token: DEVICE_2,
        pushType: 'alert',
        expiration: (T0 + 30 * MIN) / 1000 + 86_400,
        collapseId: `${b.id}-offline`,
        ...apnsForOffline(b.id, T0 / 1000),
      },
    ]);
    expect(await rows(b.id, 'registration')).toMatchObject([{ slot: 2, offline_sent: 1 }]);
    expect(await alarmTime(b.id)).toBe(T0 + 90 * DAY); // only the forget deadline is left
    await alarmAt(b.id, T0 + 120 * MIN);
    expect(await sender.items()).toHaveLength(1);
  });

  it('each phone at its own delay', async () => {
    const { b, sender } = await awayWith(30, 180);
    await alarmAt(b.id, T0 + 30 * MIN);
    expect((await sender.items()).map((i) => i.token)).toEqual([DEVICE_1]);
    expect(await alarmTime(b.id)).toBe(T0 + 180 * MIN);
    await alarmAt(b.id, T0 + 179 * MIN);
    expect((await sender.items()).map((i) => i.token)).toEqual([DEVICE_1]);
    await alarmAt(b.id, T0 + 180 * MIN);
    expect((await sender.items()).map((i) => i.token)).toEqual([DEVICE_1, DEVICE_2]);
  });

  it('a board back within the delay sends nothing', async () => {
    const { b, sender, mask } = await awayWith(30, 30);
    const again = await backAt(b, T0 + 10 * MIN, mask);
    await alarmAt(b.id, T0 + 30 * MIN);
    expect(await again.quiet()).toBe(true);
    expect(await sender.items()).toEqual([]);
  });

  it('a board that comes back and leaves again is a new absence', async () => {
    const { b, sender, mask } = await awayWith(null, 30);
    await alarmAt(b.id, T0 + 30 * MIN);
    const again = await backAt(b, T0 + 40 * MIN, mask);
    expect(await rows(b.id, 'registration')).toMatchObject([{ slot: 2, offline_sent: 0 }]);
    again.ws.close(1000);
    await again.closed;
    await alarmAt(b.id, T0 + 70 * MIN);
    expect((await sender.items()).map((i) => (i.payload.fk as { t: number }).t)).toEqual([T0 / 1000, (T0 + 40 * MIN) / 1000]);
  });

  it('delay 0 never notifies', async () => {
    const { b, sender } = await awayWith(0, 0);
    expect(await alarmTime(b.id)).toBe(T0 + 90 * DAY);
    await alarmAt(b.id, T0 + DAY);
    expect(await sender.items()).toEqual([]);
  });

  it('a PUT while the board is away moves the alarm: a shorter delay already past fires at once', async () => {
    const { b, sender } = await awayWith(null, 180);
    expect(await alarmTime(b.id)).toBe(T0 + 180 * MIN);
    await setClock(b.id, T0 + 60 * MIN);
    expect((await register(b.id, T, { env: 'sandbox', device: DEVICE_2, offlineAfter: 30 })).status).toBe(204);
    expect(await alarmTime(b.id)).toBe(T0 + 30 * MIN);
    await alarmAt(b.id, T0 + 60 * MIN);
    expect((await sender.items()).map((i) => (i.payload.fk as { t: number }).t)).toEqual([T0 / 1000]);
  });

  it('a registration without a device token is not notified, until the token is back', async () => {
    const { b, sender } = await awayWith(null, 30);
    expect((await register(b.id, T, { env: 'sandbox', startToken: 'cc'.repeat(32), offlineAfter: 30 })).status).toBe(204);
    await alarmAt(b.id, T0 + 30 * MIN);
    expect(await sender.items()).toEqual([]);
    expect(await alarmTime(b.id)).toBe(T0 + 90 * DAY);
    expect((await register(b.id, T, { env: 'sandbox', device: DEVICE_2, offlineAfter: 30 })).status).toBe(204);
    expect(await alarmTime(b.id)).toBe(T0 + 30 * MIN);
    await alarmAt(b.id, T0 + 31 * MIN);
    expect((await sender.items()).map((i) => i.token)).toEqual([DEVICE_2]);
  });
});
