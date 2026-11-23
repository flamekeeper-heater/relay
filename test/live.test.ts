import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { type BoardRoom, freshMemory } from '../src/boardRoom';
import { RENEW_AFTER_S } from '../src/push/live';
import type { ApnsItem } from '../src/push/types';
import { decodeLive, encodeWant } from '../src/wire';
import { concat, hex, sha256, toHex } from './bytes';
import { type FakeBoardSocket, base64url, eventually, fakeBoard, fakeSender, freshIp, HOST, register, room, rows, setClock } from './fakes';

const T = hex('16c1df6a87aaeae336a68c3cb93442b2246922a2edaee096e2439ee205578c0a');
const H = hex('d91429cfba5c46b38cfeb129eb4f263b616323ad4d7c20aeb3430d641258e834');
const T1 = hex('01'.repeat(32));
const START_1 = '51'.repeat(40);
const START_2 = '52'.repeat(40);
const CARD_1 = 'c1'.repeat(40);
const CARD_2 = 'c2'.repeat(40);
const DEVICE_2 = 'aa'.repeat(32);
const NOW = 1_900_000_000_000;
const NOW_S = NOW / 1000;
const MIN = 60_000;

// The live card vector (apps/ios/FlamekeeperKit/Tests/FlamekeeperKitTests/Vectors/live.json): an
// update's record sealed for one phone, and the content state the relay sends for it.
const VECTOR_BLOB = hex(
  '010101010101010101010101dee795673ed1a003854d2fde33e72751d2a6f3abdc34b974ea9b646c32bdf3a241faa5b5587acda7e9e51a74b16b40320c',
);
const VECTOR_SEALED = 'AQEBAQEBAQEBAQEB3ueVZz7RoAOFTS/eM+cnUdKm86vcNLl06ptkbDK986JB+qW1WHrNp+nlGnSxa0AyDA==';

// The firmware's golden LIVE frames (dump_vectors.cpp, "relay"): slot 2, starter 2, stale 360.
const FRAMES = {
  start: '00070001680100000201023dd0d1d2d3d4d5d6d7d8d9dadb9714fb592e976ff78314ad15786657c1dbc3c4f280159ff94e12e4d9f6c093ee2e9a76bdb8f90cb06883d3005c0d75aaaf',
  update: '00070100680100000201023dd0d1d2d3d4d5d6d7d8d9dadb9714fb592e976ff78314ad15786657c1dbc3c4f280159ff94e12e4d9f6c093ee2efe149027d8e2dc28e58eb47e3452ab34',
  end: '00070203680184030201023dd0d1d2d3d4d5d6d7d8d9dadb9714fb592e976ff78314ad15786657c1dbc3c4f280159ff94e12e4d9f6c093ee2e52b2e686bad068e84f6868187f3ba999',
};
const FRAME_BLOBS = {
  start: 'd0d1d2d3d4d5d6d7d8d9dadb9714fb592e976ff78314ad15786657c1dbc3c4f280159ff94e12e4d9f6c093ee2e9a76bdb8f90cb06883d3005c0d75aaaf',
  update: 'd0d1d2d3d4d5d6d7d8d9dadb9714fb592e976ff78314ad15786657c1dbc3c4f280159ff94e12e4d9f6c093ee2efe149027d8e2dc28e58eb47e3452ab34',
  end: 'd0d1d2d3d4d5d6d7d8d9dadb9714fb592e976ff78314ad15786657c1dbc3c4f280159ff94e12e4d9f6c093ee2e52b2e686bad068e84f6868187f3ba999',
};

/** `00 07` ‖ event ‖ flags ‖ u16 stale ‖ u16 dismissal ‖ starter ‖ n ‖ n × (slot, length, blob). */
function live(
  event: number,
  entries: Array<[slot: number, blob: Uint8Array]>,
  o: { important?: boolean; faultEnd?: boolean; stale?: number; dismissal?: number; starter?: number | null } = {},
): Uint8Array {
  const stale = o.stale ?? 360;
  const dismissal = o.dismissal ?? (event === 2 ? 300 : 0);
  const flags = (o.important ?? event !== 1 ? 1 : 0) | (o.faultEnd ? 2 : 0);
  const starter = o.starter === undefined || o.starter === null ? 0xff : o.starter;
  return concat(
    new Uint8Array([0, 7, event, flags, stale & 0xff, stale >> 8, dismissal & 0xff, dismissal >> 8, starter, entries.length]),
    ...entries.map(([slot, b]) => concat(new Uint8Array([slot, b.length]), b)),
  );
}

function blob(fill: number): Uint8Array {
  return new Uint8Array(61).fill(fill);
}

function b64(b: Uint8Array): string {
  return btoa(String.fromCharCode(...b));
}

type Aps = Record<string, unknown> & { 'content-state': Record<string, unknown> };
function aps(i: ApnsItem): Aps {
  return i.payload.aps as Aps;
}

function activityEnd(id: string, token: Uint8Array, body: object | null, method = 'DELETE'): Promise<Response> {
  return exports.default.fetch(`https://${HOST}/v1/app/${id}/push/activity`, {
    method,
    headers: { Authorization: `Bearer ${base64url(token)}`, 'CF-Connecting-IP': freshIp() },
    body: body === null ? undefined : JSON.stringify(body),
  });
}

/** A signed-in board with phones in slots 1 (T1) and 2 (T), the clock at NOW, no registrations yet. */
async function board(): Promise<FakeBoardSocket> {
  const b = await fakeBoard();
  await b.signIn();
  b.roster([
    [1, await sha256(T1)],
    [2, H],
  ]);
  expect(toHex(await b.next())).toBe('0008000000');
  await setClock(b.id, NOW);
  return b;
}

/** Registers slot 1 and 2's live card tokens and reads the WANTs that follow. */
async function registered(
  b: FakeBoardSocket,
  p1: Record<string, unknown> = { startToken: START_1, iosVersion: '17.4' },
  p2: Record<string, unknown> = { startToken: START_2, iosVersion: '18.1' },
): Promise<void> {
  expect((await register(b.id, T1, { env: 'production', ...p1 })).status).toBe(204);
  await b.next();
  expect((await register(b.id, T, { env: 'sandbox', ...p2 })).status).toBe(204);
  await b.next();
}

async function at(b: FakeBoardSocket, ms: number): Promise<void> {
  await setClock(b.id, ms);
}

async function row(id: string, slot: number): Promise<Record<string, SqlStorageValue>> {
  return (await rows(id, 'push')).find((r) => r.slot === slot)!;
}

describe('LIVE decoding', () => {
  it('reads the firmware vectors', () => {
    const expected = {
      start: { event: 0, important: true, faultEnd: false, dismissalS: 0 },
      update: { event: 1, important: false, faultEnd: false, dismissalS: 0 },
      end: { event: 2, important: true, faultEnd: true, dismissalS: 900 },
    } as const;
    for (const k of ['start', 'update', 'end'] as const) {
      const l = decodeLive(hex(FRAMES[k]))!;
      expect(l).toMatchObject({ ...expected[k], staleS: 360, starter: 2 });
      expect([...l.blobs.keys()]).toEqual([2]);
      expect(toHex(l.blobs.get(2)!)).toBe(FRAME_BLOBS[k]);
    }
    expect(toHex(encodeWant(4, 4, 4))).toBe('0008040404');
  });

  it('reads event, flags, times, starter and blobs', () => {
    const l = decodeLive(live(2, [[1, blob(1)], [3, blob(3)]], { faultEnd: true, dismissal: 900, starter: 3 }))!;
    expect(l.event).toBe(2);
    expect(l.important).toBe(true);
    expect(l.faultEnd).toBe(true);
    expect(l.staleS).toBe(360);
    expect(l.dismissalS).toBe(900);
    expect(l.starter).toBe(3);
    expect([...l.blobs.keys()]).toEqual([1, 3]);
    expect(decodeLive(live(1, [[1, blob(1)]], { starter: null }))!.starter).toBeNull();
    expect(decodeLive(live(1, [[1, blob(1)]]))!.important).toBe(false);
  });

  it('refuses bad frames', () => {
    const good = live(1, [[1, blob(1)]]);
    expect(decodeLive(good)).not.toBeNull();
    expect(decodeLive(live(3, [[1, blob(1)]]))).toBeNull();
    expect(decodeLive(live(1, [[1, blob(1)]], { starter: 8 }))).toBeNull();
    expect(decodeLive(live(1, [[8, blob(1)]]))).toBeNull();
    expect(decodeLive(live(1, [[1, blob(1)], [1, blob(2)]]))).toBeNull();
    expect(decodeLive(live(1, [[1, new Uint8Array(27)]]))).toBeNull();
    expect(decodeLive(good.subarray(0, good.length - 1))).toBeNull();
    expect(decodeLive(concat(good, new Uint8Array([0])))).toBeNull();
    expect(decodeLive(good.subarray(0, 9))).toBeNull();
  });
});

describe('live card registrations', () => {
  it('stores the tokens, the card start and the iOS version, and WANT has three masks', async () => {
    const b = await board();
    expect((await register(b.id, T1, { env: 'production', startToken: START_1, iosVersion: '17.2' })).status).toBe(204);
    expect(toHex(await b.next())).toBe('0008000002');
    expect((await register(b.id, T, { env: 'sandbox', device: DEVICE_2, activityToken: CARD_2, activityStartedAt: NOW_S })).status).toBe(204);
    expect(toHex(await b.next())).toBe('0008040402');
    expect(await row(b.id, 1)).toMatchObject({ device: null, start_token: START_1, activity_token: null, ios: '17.2' });
    expect(await row(b.id, 2)).toMatchObject({ device: DEVICE_2, start_token: null, activity_token: CARD_2, activity_started: NOW_S });
  });

  it('refuses a first PUT without any token, and bad values', async () => {
    const b = await board();
    expect((await register(b.id, T, { env: 'sandbox', iosVersion: '18.1' })).status).toBe(400);
    expect((await register(b.id, T, { env: 'sandbox', startToken: 'xyz' })).status).toBe(400);
    expect((await register(b.id, T, { env: 'sandbox', startToken: START_2, iosVersion: '18' })).status).toBe(400);
    expect((await register(b.id, T, { env: 'sandbox', startToken: START_2, activityStartedAt: -1 })).status).toBe(400);
    expect((await register(b.id, T, { env: 'sandbox', startToken: START_2, activityStartedAt: 1.5 })).status).toBe(400);
    expect(await rows(b.id, 'push')).toEqual([]);
  });

  it('a card ended drops its token; a card swiped away also blocks push-to-start in this run', async () => {
    const b = await board();
    await registered(b, { startToken: START_1, activityToken: CARD_1, activityStartedAt: NOW_S }, { startToken: START_2, activityToken: CARD_2, activityStartedAt: NOW_S });
    await fakeSender(b.id);
    b.send(live(0, [[3, blob(3)]])); // a run, for no phone here
    await eventually(async () => (await rows(b.id, 'meta')).some((r) => r.key === 'live_run'));
    expect((await activityEnd(b.id, T1, null)).status).toBe(204);
    expect(toHex(await b.next())).toBe('0008000406');
    expect(await row(b.id, 1)).toMatchObject({ activity_token: null, activity_started: null, dismissed_run: null, start_token: START_1 });
    expect((await activityEnd(b.id, T, { reason: 'dismissed' })).status).toBe(204);
    expect(toHex(await b.next())).toBe('0008000006');
    expect((await row(b.id, 2)).dismissed_run).toBe(NOW);
    // A new card clears it.
    expect((await register(b.id, T, { activityToken: CARD_2, activityStartedAt: NOW_S + 60 })).status).toBe(204);
    expect((await row(b.id, 2)).dismissed_run).toBeNull();
    // A later card without its start time has none, not the old card's.
    expect((await register(b.id, T, { activityToken: 'c3'.repeat(40) })).status).toBe(204);
    expect(await row(b.id, 2)).toMatchObject({ activity_token: 'c3'.repeat(40), activity_started: null });
    expect((await register(b.id, T, { iosVersion: '18.2' })).status).toBe(204);
    expect(await row(b.id, 2)).toMatchObject({ activity_token: 'c3'.repeat(40), ios: '18.2' });
  });

  it('a card that ended names its token, so a newer card stays', async () => {
    const b = await board();
    await registered(b, { startToken: START_1, activityToken: CARD_1, activityStartedAt: NOW_S });
    expect((await activityEnd(b.id, T1, { reason: 'ended', activityToken: 'c9'.repeat(40) })).status).toBe(204);
    expect(await row(b.id, 1)).toMatchObject({ activity_token: CARD_1 });
    expect(await b.quiet()).toBe(true);
    expect((await activityEnd(b.id, T1, { reason: 'ended', activityToken: CARD_1 })).status).toBe(204);
    expect(await row(b.id, 1)).toMatchObject({ activity_token: null });
    expect((await activityEnd(b.id, T1, { activityToken: 'XY' })).status).toBe(400);
  });

  it('answers 405 to a PUT of the activity path, 400 to a bad reason, 401 to a stranger', async () => {
    const b = await board();
    await registered(b);
    expect((await activityEnd(b.id, T, { reason: 'ended' }, 'PUT')).status).toBe(405);
    expect((await activityEnd(b.id, T, { reason: 'gone' })).status).toBe(400);
    expect((await activityEnd(b.id, T, { reason: 'ended', x: 1 })).status).toBe(400);
    expect((await activityEnd(b.id, hex('07'.repeat(32)), null)).status).toBe(401);
  });

  it('adds the live card columns to a push table stored before them', async () => {
    const b = await board();
    await runInDurableObject(room(b.id), (o: BoardRoom, state) => {
      state.storage.sql.exec(`DROP TABLE IF EXISTS push`);
      state.storage.sql.exec(
        `CREATE TABLE push (slot INTEGER PRIMARY KEY, kind TEXT NOT NULL, env TEXT NOT NULL, device TEXT,
           offline_after INTEGER NOT NULL DEFAULT 0, offline_sent INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL)`,
      );
      state.storage.sql.exec(`INSERT INTO push (slot, kind, env, device, updated) VALUES (2, 'apns', 'sandbox', ?, 1)`, DEVICE_2);
      o.mem = freshMemory();
    });
    expect((await register(b.id, T, { startToken: START_2 })).status).toBe(204);
    expect(await row(b.id, 2)).toMatchObject({ device: DEVICE_2, start_token: START_2, live_blob: null });
  });
});

describe('LIVE to Live Activity pushes', () => {
  it('a start sends push-to-start to each startable phone but the starter', async () => {
    const b = await board();
    await registered(b);
    const sender = await fakeSender(b.id);
    b.send(live(0, [[1, blob(1)], [2, blob(2)]], { starter: 1 }));
    await eventually(async () => (await sender.items()).length === 1);
    const [i] = await sender.items();
    expect(i).toMatchObject({ env: 'sandbox', device: START_2, pushType: 'liveactivity', priority: 10, expiration: NOW_S + 360 });
    expect(aps(i)).toEqual({
      timestamp: NOW_S,
      event: 'start',
      'content-state': { v: 1, sealed: b64(blob(2)), e: 0, card: NOW_S, via: 'internet' },
      'stale-date': NOW_S + 360,
      'attributes-type': 'HeaterActivityAttributes',
      attributes: { board: b.id },
      alert: { title: 'Flamekeeper', body: { 'loc-key': 'card.started' } },
      'input-push-token': 1,
    });
    expect(await b.quiet()).toBe(true);
    expect((await row(b.id, 2)).started_run).toBe(NOW);
    expect((await row(b.id, 1)).started_run).toBeNull();
  });

  it('iOS 17 gets no input-push-token', async () => {
    const b = await board();
    await registered(b);
    const sender = await fakeSender(b.id);
    b.send(live(0, [[1, blob(1)]]));
    await eventually(async () => (await sender.items()).length === 1);
    expect(aps((await sender.items())[0])['input-push-token']).toBeUndefined();
  });

  it('an update goes to the card at priority 5, 10 when important, with the card start', async () => {
    const b = await board();
    await registered(b, { activityToken: CARD_1, activityStartedAt: NOW_S - 100, startToken: START_1 });
    const sender = await fakeSender(b.id);
    b.send(live(1, [[1, blob(1)]]));
    await eventually(async () => (await sender.items()).length === 1);
    await at(b, NOW + 20_000);
    b.send(live(1, [[1, blob(3)]], { important: true, stale: 400 }));
    await eventually(async () => (await sender.items()).length === 2);
    const [u, v] = await sender.items();
    expect(u).toMatchObject({ device: CARD_1, env: 'production', priority: 5, pushType: 'liveactivity' });
    expect(aps(u)).toEqual({
      timestamp: NOW_S,
      event: 'update',
      'content-state': { v: 1, sealed: b64(blob(1)), e: 1, card: NOW_S - 100, via: 'internet' },
      'stale-date': NOW_S + 360,
    });
    expect(v.priority).toBe(10);
    expect(aps(v)['stale-date']).toBe(NOW_S + 20 + 400);
  });

  it('the content state for the vector blob carries the vector sealed content', async () => {
    const b = await board();
    await registered(b, { activityToken: CARD_1, startToken: START_1 });
    const sender = await fakeSender(b.id);
    b.send(live(1, [[1, VECTOR_BLOB]]));
    await eventually(async () => (await sender.items()).length === 1);
    expect(aps((await sender.items())[0])['content-state']).toEqual({ v: 1, sealed: VECTOR_SEALED, e: 1, via: 'internet' });
  });

  it('an update to a phone without a card starts one once per run, never for the starter', async () => {
    const b = await board();
    await registered(b);
    const sender = await fakeSender(b.id);
    b.send(live(1, [[1, blob(1)], [2, blob(2)]], { starter: 1 }));
    await eventually(async () => (await sender.items()).length === 1);
    expect((await sender.items())[0]).toMatchObject({ device: START_2 });
    expect(aps((await sender.items())[0]).event).toBe('start');
    await at(b, NOW + 20_000);
    b.send(live(1, [[1, blob(1)], [2, blob(2)]], { starter: 1 }));
    await at(b, NOW + 40_000);
    b.send(live(0, [[1, blob(1)], [2, blob(2)]], { starter: 1 }));
    await eventually(async () => (await sender.items()).length === 2);
    expect((await sender.items())[1]).toMatchObject({ device: START_2 });
  });

  it('a phone that swiped its card away gets no new one until the next start (Review Focus)', async () => {
    const b = await board();
    await registered(b, { startToken: START_1 }, { startToken: START_2, activityToken: CARD_2, activityStartedAt: NOW_S });
    const sender = await fakeSender(b.id);
    b.send(live(0, [[2, blob(2)]]));
    await eventually(async () => (await sender.items()).length === 1);
    expect((await sender.items())[0].device).toBe(CARD_2);
    expect((await activityEnd(b.id, T, { reason: 'dismissed' })).status).toBe(204);
    await b.next();
    await at(b, NOW + 20_000);
    b.send(live(1, [[2, blob(2)]]));
    expect(await b.quiet(100)).toBe(true);
    expect(await sender.items()).toHaveLength(1);
    await at(b, NOW + 40_000);
    b.send(live(0, [[2, blob(2)]]));
    await eventually(async () => (await sender.items()).length === 2);
    expect((await sender.items())[1]).toMatchObject({ device: START_2 });
  });

  it('an end ends the card with its dismissal and forgets the token', async () => {
    const b = await board();
    await registered(b, { startToken: START_1, activityToken: CARD_1, activityStartedAt: NOW_S - 100 });
    const sender = await fakeSender(b.id);
    b.send(live(2, [[1, blob(1)], [2, blob(2)]], { faultEnd: true, dismissal: 900 }));
    await eventually(async () => (await sender.items()).length === 1);
    const [e] = await sender.items();
    expect(e).toMatchObject({ device: CARD_1, priority: 10, expiration: NOW_S + 8 * 3600 });
    expect(aps(e)).toEqual({
      timestamp: NOW_S,
      event: 'end',
      'content-state': { v: 1, sealed: b64(blob(1)), e: 2, card: NOW_S - 100, via: 'internet' },
      'dismissal-date': NOW_S + 900,
    });
    expect(toHex(await b.next())).toBe('0008000006');
    expect((await row(b.id, 1)).activity_token).toBeNull();
  });

  it('a card token APNs calls gone is forgotten and the board gets WANT', async () => {
    const b = await board();
    await registered(b, { startToken: START_1, activityToken: CARD_1 });
    const sender = await fakeSender(b.id, (i) => (i.device === CARD_1 ? 'gone' : 'sent'));
    b.send(live(1, [[1, blob(1)]]));
    expect(toHex(await b.next())).toBe('0008000006');
    expect(await sender.items()).toHaveLength(1);
    expect(await row(b.id, 1)).toMatchObject({ activity_token: null, start_token: START_1 });
  });

  it('a row with no token left goes when APNs calls the last one gone', async () => {
    const b = await board();
    await registered(b, { startToken: START_1 });
    await fakeSender(b.id, () => 'gone');
    b.send(live(0, [[1, blob(1)]]));
    expect(toHex(await b.next())).toBe('0008000004');
    expect(await row(b.id, 1)).toBeUndefined();
  });

  it('drops a LIVE within 20 s of the last; an end always passes', async () => {
    const b = await board();
    await registered(b, { startToken: START_1, activityToken: CARD_1 });
    const sender = await fakeSender(b.id);
    b.send(live(1, [[1, blob(1)]]));
    await eventually(async () => (await sender.items()).length === 1);
    await at(b, NOW + 19_999);
    b.send(live(1, [[1, blob(2)]]));
    await at(b, NOW + 20_000);
    b.send(live(2, [[1, blob(3)]]));
    await eventually(async () => (await sender.items()).length === 2);
    expect(aps((await sender.items())[1]).event).toBe('end');
  });

  it('ignores a malformed LIVE and keeps the board; logs carry no blob', async () => {
    const b = await board();
    await registered(b, { startToken: START_1, activityToken: CARD_1 });
    const sender = await fakeSender(b.id);
    b.send(new Uint8Array([0, 7, 1, 0]));
    expect(await b.quiet(100)).toBe(true);
    expect(b.ws.readyState).toBe(WebSocket.OPEN);
    expect(await sender.items()).toEqual([]);
  });
});

describe('runs', () => {
  it('a start right after an end passes the limit and is a new run', async () => {
    const b = await board();
    await registered(b);
    const sender = await fakeSender(b.id);
    b.send(live(0, [[2, blob(2)]]));
    await eventually(async () => (await sender.items()).length === 1);
    await at(b, NOW + 5000);
    b.send(live(2, [[2, blob(2)]]));
    await at(b, NOW + 10_000);
    b.send(live(0, [[2, blob(2)]]));
    await eventually(async () => (await sender.items()).length === 2);
    expect((await sender.items()).map((i) => [i.device, aps(i).event])).toEqual([
      [START_2, 'start'],
      [START_2, 'start'],
    ]);
  });

  it('an update after an end, with no start seen, is a new run too', async () => {
    const b = await board();
    await registered(b);
    const sender = await fakeSender(b.id);
    b.send(live(0, [[2, blob(2)]]));
    await eventually(async () => (await sender.items()).length === 1);
    await at(b, NOW + 30_000);
    b.send(live(2, [[2, blob(2)]]));
    await at(b, NOW + 60_000);
    b.send(live(1, [[2, blob(2)]]));
    await eventually(async () => (await sender.items()).length === 2);
    expect(aps((await sender.items())[1]).event).toBe('start');
  });

  it('a card whose token comes after its run ended is ended at once, until the run end dismissal', async () => {
    const b = await board();
    await registered(b);
    const sender = await fakeSender(b.id);
    b.send(live(0, [[2, blob(2)]]));
    await eventually(async () => (await sender.items()).length === 1);
    await at(b, NOW + 8000);
    b.send(live(2, [[2, blob(4)]], { dismissal: 300 }));
    expect(await b.quiet(100)).toBe(true);
    expect(await sender.items()).toHaveLength(1);
    await at(b, NOW + 30_000);
    expect((await register(b.id, T, { activityToken: CARD_2, activityStartedAt: NOW_S })).status).toBe(204);
    expect(toHex(await b.next())).toBe('0008000406');
    await eventually(async () => (await sender.items()).length === 2);
    const e = (await sender.items())[1];
    expect(e.device).toBe(CARD_2);
    expect(aps(e)).toEqual({
      timestamp: NOW_S + 30,
      event: 'end',
      'content-state': { v: 1, sealed: b64(blob(4)), e: 2, card: NOW_S, via: 'internet' },
      'dismissal-date': NOW_S + 8 + 300,
    });
    expect(toHex(await b.next())).toBe('0008000006');
    // A card the app starts itself for the next run is left alone.
    expect((await register(b.id, T, { activityToken: CARD_2, activityStartedAt: NOW_S + 30 })).status).toBe(204);
    expect(await b.quiet(100)).toBe(false);
    expect(await sender.items()).toHaveLength(2);
  });

  it('an end APNs did not take keeps the card token', async () => {
    const b = await board();
    await registered(b, { startToken: START_1, activityToken: CARD_1 });
    await fakeSender(b.id, () => 'failed');
    b.send(live(2, [[1, blob(1)]]));
    expect(await b.quiet(100)).toBe(true);
    expect((await row(b.id, 1)).activity_token).toBe(CARD_1);
  });
});

describe('the 8-hour renewal', () => {
  it('renews on the first update after 7 h 45 min: a new card, then the old one ends at once', async () => {
    const b = await board();
    await registered(b, { startToken: START_1, activityToken: CARD_1, activityStartedAt: NOW_S - RENEW_AFTER_S + 1, iosVersion: '18.0' });
    const sender = await fakeSender(b.id);
    b.send(live(1, [[1, blob(1)]]));
    await eventually(async () => (await sender.items()).length === 1);
    expect(aps((await sender.items())[0]).event).toBe('update');

    await at(b, NOW + 20_000);
    b.send(live(1, [[1, blob(2)]]));
    await eventually(async () => (await sender.items()).length === 3);
    const [, start, end] = await sender.items();
    expect(start).toMatchObject({ device: START_1, priority: 10 });
    expect(aps(start)).toMatchObject({
      event: 'start',
      'content-state': { v: 1, sealed: b64(blob(2)), e: 1, card: NOW_S + 20, via: 'internet', relay: { renewed: true } },
      'input-push-token': 1,
    });
    expect(end).toMatchObject({ device: CARD_1, priority: 10 });
    expect(aps(end)).toMatchObject({ event: 'end', 'dismissal-date': NOW_S + 20 });
    expect(toHex(await b.next())).toBe('0008000006');
    expect(await row(b.id, 1)).toMatchObject({ activity_token: null, started_run: expect.any(Number) });

    // No second card in this run before the app registers the new one.
    await at(b, NOW + 40_000);
    b.send(live(1, [[1, blob(3)]]));
    expect(await b.quiet(100)).toBe(true);
    expect(await sender.items()).toHaveLength(3);
  });

  it('a phone without a start token keeps updating its card', async () => {
    const b = await board();
    await registered(b, { activityToken: CARD_1, activityStartedAt: NOW_S - RENEW_AFTER_S - 10 });
    const sender = await fakeSender(b.id);
    b.send(live(1, [[1, blob(1)]]));
    await eventually(async () => (await sender.items()).length === 1);
    expect(aps((await sender.items())[0]).event).toBe('update');
  });
});

describe('lost contact', () => {
  /** A board whose phone in slot 1 has a card that got one update, gone at NOW + 1 s. */
  async function awayWithCard(offlineAfter = 0) {
    const b = await board();
    await registered(b, { startToken: START_1, activityToken: CARD_1, activityStartedAt: NOW_S - 100, device: 'bb'.repeat(32), offlineAfter });
    const sender = await fakeSender(b.id);
    b.send(live(1, [[1, blob(9)]]));
    await eventually(async () => (await sender.items()).length === 1);
    await at(b, NOW + 1000);
    b.ws.close(1000);
    await b.closed;
    await eventually(async () => (await rows(b.id, 'meta')).some((r) => r.key === 'last_seen' && r.value === NOW_S + 1));
    return { b, sender };
  }

  async function alarmAt(id: string, ms: number): Promise<void> {
    await setClock(id, ms);
    await runDurableObjectAlarm(room(id));
  }

  function alarmTime(id: string): Promise<number | null> {
    return runInDurableObject(room(id), (_o: BoardRoom, state) => state.storage.getAlarm());
  }

  it('says so at 10 minutes and ends the card at 60, once each', async () => {
    const { b, sender } = await awayWithCard();
    const gone = NOW + 1000;
    expect(await alarmTime(b.id)).toBe(gone + 10 * MIN);
    await alarmAt(b.id, gone + 10 * MIN - 1);
    expect(await sender.items()).toHaveLength(1);
    await alarmAt(b.id, gone + 10 * MIN);
    expect(await sender.items()).toHaveLength(2);
    const u = (await sender.items())[1];
    expect(u).toMatchObject({ device: CARD_1, priority: 10 });
    expect(aps(u)).toEqual({
      timestamp: (gone + 10 * MIN) / 1000,
      event: 'update',
      'content-state': { v: 1, sealed: b64(blob(9)), e: 1, card: NOW_S - 100, via: 'internet', relay: { lostAt: NOW_S + 1 } },
      'stale-date': (gone + 10 * MIN) / 1000,
    });
    expect(await alarmTime(b.id)).toBe(gone + 60 * MIN);
    await alarmAt(b.id, gone + 60 * MIN);
    const e = (await sender.items())[2];
    expect(aps(e)).toMatchObject({ event: 'end', 'dismissal-date': (gone + 60 * MIN) / 1000 + 900, 'content-state': { relay: { lostAt: NOW_S + 1 } } });
    expect((await row(b.id, 1)).activity_token).toBeNull();
    expect(await row(b.id, 1)).toMatchObject({ started_run: null });
    await alarmAt(b.id, gone + 120 * MIN);
    expect(await sender.items()).toHaveLength(3);
  });

  it('a board back within 10 minutes sends nothing', async () => {
    const { b, sender } = await awayWithCard();
    await at(b, NOW + 5 * MIN);
    const again = await fakeBoard({ keyOf: b.keys });
    await again.signIn('0008020206');
    await alarmAt(b.id, NOW + 11 * MIN);
    expect(await sender.items()).toHaveLength(1);
  });

  it('the offline notification and the lost-contact update fire from one alarm', async () => {
    const { b, sender } = await awayWithCard(30);
    const gone = NOW + 1000;
    await alarmAt(b.id, gone + 10 * MIN);
    expect((await sender.items()).map((i) => i.pushType)).toEqual(['liveactivity', 'liveactivity']);
    expect(await alarmTime(b.id)).toBe(gone + 30 * MIN);
    await alarmAt(b.id, gone + 30 * MIN);
    expect((await sender.items()).map((i) => i.pushType)).toEqual(['liveactivity', 'liveactivity', 'alert']);
    expect(await alarmTime(b.id)).toBe(gone + 60 * MIN);
  });
});
