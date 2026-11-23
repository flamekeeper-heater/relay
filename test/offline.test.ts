import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { BoardRoom } from '../src/boardRoom';
import { FIXED_TEXT, apnsForPresence } from '../src/push/apnsMessage';
import type { ApnsItem } from '../src/push/types';
import { hex, sha256, toHex } from './bytes';
import { type FakeBoardSocket, eventually, fakeBoard, fakeSender, register, room, rows, setClock, storedNothing } from './fakes';

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
  await eventually(async () => (await rows(b.id, 'meta'))[0]?.value === T0 / 1000);
  return { b, sender, mask: after1 === null ? '0008040000' : '0008060000' };
}

/** Runs the room's alarm at `ms`, whatever time it was set for. */
async function alarmAt(id: string, ms: number): Promise<void> {
  await setClock(id, ms);
  await runDurableObjectAlarm(room(id));
}

function alarmTime(id: string): Promise<number | null> {
  return runInDurableObject(room(id), (_o: BoardRoom, state) => state.storage.getAlarm());
}

async function backAt(b: FakeBoardSocket, ms: number, want: string): Promise<FakeBoardSocket> {
  await setClock(b.id, ms);
  const again = await fakeBoard({ keyOf: b.keys });
  await again.signIn(want);
  return again;
}

function fk(i: ApnsItem): Record<string, unknown> {
  return i.payload.fk as Record<string, unknown>;
}

describe('APNs message for presence', () => {
  it('offline: class 1, active, the default sound, no blob', () => {
    const m = apnsForPresence('offline', ID, 1_900_000_000);
    expect(m.priority).toBe(10);
    expect(m.payload).toEqual({
      aps: {
        alert: { title: 'Flamekeeper', body: 'A heater is offline. Open Flamekeeper.' },
        'mutable-content': 1,
        'interruption-level': 'active',
        sound: 'default',
        'thread-id': ID,
      },
      fk: { v: 1, b: ID, k: 'offline', t: 1_900_000_000 },
    });
  });

  it('online: class 0, passive, silent', () => {
    const m = apnsForPresence('online', ID, 1_900_000_600);
    expect(m.priority).toBe(5);
    expect(m.payload).toEqual({
      aps: {
        alert: { title: 'Flamekeeper', body: 'A heater is back online.' },
        'mutable-content': 1,
        'interruption-level': 'passive',
        'thread-id': ID,
      },
      fk: { v: 1, b: ID, k: 'online', t: 1_900_000_600 },
    });
  });
});

describe('heater offline watcher', () => {
  it('sends one offline push after the phone’s delay', async () => {
    const { b, sender } = await awayWith(null, 30);
    expect(await alarmTime(b.id)).toBe(T0 + 30 * MIN);
    await alarmAt(b.id, T0 + 29 * MIN);
    expect(await sender.items()).toEqual([]);
    await alarmAt(b.id, T0 + 30 * MIN);
    const items = await sender.items();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ env: 'sandbox', device: DEVICE_2, priority: 10, expiration: (T0 + 30 * MIN) / 1000 + 86_400 });
    expect(fk(items[0])).toEqual({ v: 1, b: b.id, k: 'offline', t: T0 / 1000 });
    expect(items[0].payload).toEqual(apnsForPresence('offline', b.id, T0 / 1000).payload);
    expect(await rows(b.id, 'push')).toMatchObject([{ slot: 2, offline_sent: 1 }]);
    expect(await alarmTime(b.id)).toBe(T0 + 90 * DAY); // only the forget deadline is left
    await alarmAt(b.id, T0 + 120 * MIN);
    expect(await sender.items()).toHaveLength(1);
  });

  it('each phone at its own delay', async () => {
    const { b, sender } = await awayWith(30, 180);
    await alarmAt(b.id, T0 + 30 * MIN);
    expect((await sender.items()).map((i) => i.device)).toEqual([DEVICE_1]);
    expect(await alarmTime(b.id)).toBe(T0 + 180 * MIN);
    await alarmAt(b.id, T0 + 179 * MIN);
    expect((await sender.items()).map((i) => i.device)).toEqual([DEVICE_1]);
    await alarmAt(b.id, T0 + 180 * MIN);
    expect((await sender.items()).map((i) => i.device)).toEqual([DEVICE_1, DEVICE_2]);
    expect((await sender.items()).map((i) => fk(i).t)).toEqual([T0 / 1000, T0 / 1000]);
  });

  it('a board back within the delay sends nothing, and no online push', async () => {
    const { b, sender, mask } = await awayWith(30, 30);
    const again = await backAt(b, T0 + 10 * MIN, mask);
    await setClock(b.id, T0 + 30 * MIN);
    await runDurableObjectAlarm(room(b.id));
    expect(await again.quiet()).toBe(true);
    expect(await sender.items()).toEqual([]);
    expect((await rows(b.id, 'push')).map((r) => r.offline_sent)).toEqual([0, 0]);
  });

  it('says back online once after an offline push', async () => {
    const { b, sender, mask } = await awayWith(null, 30);
    await alarmAt(b.id, T0 + 30 * MIN);
    expect(await sender.items()).toHaveLength(1);
    const again = await backAt(b, T0 + 40 * MIN, mask);
    await eventually(async () => (await sender.items()).length === 2);
    const online = (await sender.items())[1];
    expect(online).toMatchObject({ device: DEVICE_2, priority: 5 });
    expect(online.payload).toEqual(apnsForPresence('online', b.id, (T0 + 40 * MIN) / 1000).payload);
    expect((online.payload.aps as { alert: { body: string } }).alert.body).toBe(FIXED_TEXT.online);
    expect(await rows(b.id, 'push')).toMatchObject([{ slot: 2, offline_sent: 0 }]);
    // Neither counts toward the PUSH limit.
    expect((await rows(b.id, 'meta')).map((r) => r.key)).toEqual(['last_seen']);

    await backAt(again, T0 + 41 * MIN, mask); // the next AUTH (a newer socket)
    expect(await again.quiet(100)).toBe(true);
    expect(await sender.items()).toHaveLength(2);
  });

  it('delay 0 never notifies', async () => {
    const { b, sender } = await awayWith(0, 0);
    expect(await alarmTime(b.id)).toBe(T0 + 90 * DAY);
    await alarmAt(b.id, T0 + DAY);
    expect(await sender.items()).toEqual([]);
  });

  it('a row deleted while away is not notified', async () => {
    const { b, sender } = await awayWith(null, 30);
    expect((await register(b.id, T, null, 'DELETE')).status).toBe(204);
    await alarmAt(b.id, T0 + 30 * MIN);
    expect(await sender.items()).toEqual([]);
    expect(await alarmTime(b.id)).toBe(T0 + 90 * DAY);
  });

  it('a row without a device token is not notified and sets no alarm', async () => {
    const { b, sender } = await awayWith(null, 30);
    expect((await register(b.id, T, { device: null })).status).toBe(204);
    await alarmAt(b.id, T0 + 30 * MIN);
    expect(await sender.items()).toEqual([]);
    expect(await alarmTime(b.id)).toBe(T0 + 90 * DAY);
  });

  it('a PUT while the board is away moves the alarm: a first delay', async () => {
    const { b, sender } = await awayWith(null, 0);
    expect(await alarmTime(b.id)).toBe(T0 + 90 * DAY);
    expect((await register(b.id, T, { offlineAfter: 30 })).status).toBe(204);
    expect(await alarmTime(b.id)).toBe(T0 + 30 * MIN);
    await alarmAt(b.id, T0 + 30 * MIN);
    expect((await sender.items()).map((i) => [i.device, fk(i).k, fk(i).t])).toEqual([[DEVICE_2, 'offline', T0 / 1000]]);
  });

  it('a PUT while the board is away moves the alarm: a shorter delay already past fires at once', async () => {
    const { b, sender } = await awayWith(null, 180);
    expect(await alarmTime(b.id)).toBe(T0 + 180 * MIN);
    await setClock(b.id, T0 + 60 * MIN);
    expect((await register(b.id, T, { offlineAfter: 30 })).status).toBe(204);
    expect(await alarmTime(b.id)).toBe(T0 + 30 * MIN);
    await runDurableObjectAlarm(room(b.id));
    expect((await sender.items()).map((i) => fk(i).t)).toEqual([T0 / 1000]);
  });

  it('a PUT while the board is away moves the alarm: a device token back', async () => {
    const { b, sender } = await awayWith(null, 30);
    expect((await register(b.id, T, { device: null })).status).toBe(204);
    await alarmAt(b.id, T0 + 30 * MIN);
    expect(await sender.items()).toEqual([]);
    expect(await alarmTime(b.id)).toBe(T0 + 90 * DAY);
    await setClock(b.id, T0 + 31 * MIN);
    expect((await register(b.id, T, { device: DEVICE_2 })).status).toBe(204);
    expect(await alarmTime(b.id)).toBe(T0 + 30 * MIN);
    await runDurableObjectAlarm(room(b.id));
    expect((await sender.items()).map((i) => i.device)).toEqual([DEVICE_2]);
  });

  it('a row outside the roster sets no alarm', async () => {
    const { b, sender } = await awayWith(null, 0);
    await runInDurableObject(room(b.id), (_o: BoardRoom, state) => {
      state.storage.sql.exec(`INSERT INTO push (slot, kind, env, device, offline_after, updated) VALUES (5, 'apns', 'sandbox', ?, 30, 0)`, 'cc'.repeat(32));
    });
    await alarmAt(b.id, T0 + 30 * MIN);
    expect(await sender.items()).toEqual([]);
    expect(await alarmTime(b.id)).toBe(T0 + 90 * DAY);
  });

  it('forgets a token APNs calls gone', async () => {
    const { b } = await awayWith(30, 30);
    await fakeSender(b.id, (i) => (i.device === DEVICE_1 ? 'gone' : 'sent'));
    await alarmAt(b.id, T0 + 30 * MIN);
    expect((await rows(b.id, 'push')).map((r) => [r.slot, r.offline_sent])).toEqual([[2, 1]]);
  });

  it('the 90-day forget still happens', async () => {
    const { b, sender } = await awayWith(30, 60);
    await alarmAt(b.id, T0 + 91 * DAY);
    await eventually(() => storedNothing(b.id));
    expect(await sender.items()).toEqual([]);
  });
});
