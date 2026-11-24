import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BoardRoom, SILENT_MS } from '../src/boardRoom';
import { RENEW_AFTER_S } from '../src/push/live';
import type { ApnsItem } from '../src/push/types';
import { decodeLive, encodeWant } from '../src/wire';
import { concat, hex, sha256, toHex } from './bytes';
import { type FakeBoardSocket, alarmAt, alarmTime, cardEnd, eventually, fakeApp, fakeBoard, fakeSender, logged, meta, register, room, rows, setClock } from './fakes';

const T = hex('16c1df6a87aaeae336a68c3cb93442b2246922a2edaee096e2439ee205578c0a');
const H = hex('d91429cfba5c46b38cfeb129eb4f263b616323ad4d7c20aeb3430d641258e834');
const T1 = hex('01'.repeat(32));
const START_1 = '51'.repeat(40);
const START_2 = '52'.repeat(40);
const CARD_1 = 'c1'.repeat(40);
const CARD_2 = 'c2'.repeat(40);
const NOW = 1_900_000_000_000;
const NOW_S = NOW / 1000;
const MIN = 60_000;
/** The run id the board gives a run unless a test says otherwise. */
const RUN = 0x0102_0003;

// The LIVE vectors of PROTOCOL.md: slot 2, starter 2, run 42, stale 360, the record 33 × d0..f0.
const RECORD = Uint8Array.from({ length: 33 }, (_, i) => 0xd0 + i);
const FRAMES = {
  start: `0007000168010000022a00000004${toHex(RECORD)}`,
  update: `0007010068010000022a00000004${toHex(RECORD)}`,
  end: `0007020368018403022a00000004${toHex(RECORD)}`,
};

/** `00 07` ‖ event ‖ flags ‖ u16 stale ‖ u16 dismissal ‖ starter ‖ u32 run ‖ slots ‖ the record. */
function live(
  event: number,
  slots: number[],
  record: Uint8Array,
  o: { important?: boolean; stale?: number; dismissal?: number; starter?: number | null; run?: number } = {},
): Uint8Array {
  const stale = o.stale ?? 360;
  const dismissal = o.dismissal ?? (event === 2 ? 300 : 0);
  const flags = o.important ?? event !== 1 ? 1 : 0;
  const run = o.run ?? RUN;
  const starter = o.starter === undefined || o.starter === null ? 0xff : o.starter;
  const mask = slots.reduce((m, s) => m | (1 << s), 0);
  return concat(
    new Uint8Array([0, 7, event, flags, stale & 0xff, stale >> 8, dismissal & 0xff, dismissal >> 8, starter, run & 0xff, (run >> 8) & 0xff, (run >> 16) & 0xff, run >>> 24, mask]),
    record,
  );
}

/** A 33-byte record. */
function blob(fill: number): Uint8Array {
  return new Uint8Array(33).fill(fill);
}

function b64(b: Uint8Array): string {
  return btoa(String.fromCharCode(...b));
}

type Aps = Record<string, unknown> & { 'content-state': Record<string, unknown> };
function aps(i: ApnsItem): Aps {
  return i.payload.aps as Aps;
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
  return (await rows(id, 'registration')).find((r) => r.slot === slot)!;
}

afterEach(() => vi.restoreAllMocks());

describe('LIVE decoding', () => {
  it('reads the vectors', () => {
    const expected = {
      start: { event: 0, important: true, dismissalS: 0 },
      update: { event: 1, important: false, dismissalS: 0 },
      end: { event: 2, important: true, dismissalS: 900 },
    } as const;
    for (const k of ['start', 'update', 'end'] as const) {
      expect(decodeLive(hex(FRAMES[k]))).toEqual({ ...expected[k], staleS: 360, run: 42, slots: 4, record: RECORD });
    }
    expect(toHex(encodeWant(4, 4, 4))).toBe('0008040404');
    expect(decodeLive(live(1, [1], blob(1), { starter: null, run: 0xfedcba98 }))).toMatchObject({ run: 0xfedcba98, slots: 2 });
  });

  it('refuses bad frames', () => {
    const good = live(1, [1], blob(1));
    expect(decodeLive(good)).not.toBeNull();
    expect(decodeLive(live(3, [1], blob(1)))).toBeNull();
    expect(decodeLive(live(1, [1], blob(1), { starter: 8 }))).toBeNull();
    expect(decodeLive(live(1, [1], blob(1), { run: 0 }))).toBeNull();
    expect(decodeLive(good.subarray(0, 14))).toBeNull();
    expect(decodeLive(live(1, [1], new Uint8Array(65)))).toBeNull();
  });
});

describe('token environments', () => {
  it('a start or card token refused in its env is tried in the other once, remembered there, and the card follows its start; a device token is not', async () => {
    const b = await board();
    const DEVICE_2 = 'd2'.repeat(32);
    await registered(b, { startToken: START_1, iosVersion: '18.1' }, { startToken: START_2, device: DEVICE_2, iosVersion: '18.1' });
    // The phone in slot 2 is a development build holding a production install's Live Activity tokens.
    const sender = await fakeSender(b.id, (i) => (i.token === DEVICE_2 || i.env === 'sandbox' ? 'gone' : 'sent'));
    b.send(live(0, [2], blob(1)));
    await eventually(async () => (await row(b.id, 2)).start_env === 'production');
    expect((await sender.items()).map((i) => [i.token, i.env])).toEqual([
      [START_2, 'sandbox'],
      [START_2, 'production'],
    ]);
    expect(await row(b.id, 2)).toMatchObject({ start_token: START_2, no_start_run: RUN });
    expect((await register(b.id, T, { env: 'sandbox', startToken: START_2, device: DEVICE_2, activityToken: CARD_2, activityStartedAt: NOW_S, iosVersion: '18.1' })).status).toBe(204);
    await b.next();
    expect(await row(b.id, 2)).toMatchObject({ start_env: 'production', activity_env: 'production' });
    b.send(live(1, [2], blob(2)));
    await eventually(async () => (await sender.items()).length === 3);
    expect((await sender.items())[2]).toMatchObject({ token: CARD_2, env: 'production' });
    // A refused device token is dropped without a second try.
    b.send(concat(new Uint8Array([0, 6, 1, 1, 2, 40]), new Uint8Array(40).fill(7)));
    await eventually(async () => (await row(b.id, 2)).device === null);
    expect((await sender.items()).slice(3).map((i) => [i.token, i.env])).toEqual([[DEVICE_2, 'sandbox']]);
  });
});

describe('a card that ended', () => {
  it('drops its token; a card swiped away also blocks push-to-start for the rest of the run', async () => {
    const b = await board();
    await registered(b, { startToken: START_1, activityToken: CARD_1, activityStartedAt: NOW_S }, { startToken: START_2, activityToken: CARD_2, activityStartedAt: NOW_S });
    const sender = await fakeSender(b.id);
    b.send(live(0, [1, 2], blob(1)));
    await eventually(async () => (await sender.items()).length === 2);
    expect((await cardEnd(b.id, T1, null)).status).toBe(204);
    expect(toHex(await b.next())).toBe('0008000406');
    expect(await row(b.id, 1)).toMatchObject({ activity_token: null, activity_started: null, no_start_run: null, start_token: START_1 });
    expect((await cardEnd(b.id, T, { dismissed: true })).status).toBe(204);
    expect(toHex(await b.next())).toBe('0008000006');
    expect((await row(b.id, 2)).no_start_run).toBe(RUN);
    // The next update starts a card again for the phone whose card just ended, not for the one that swiped.
    b.send(live(1, [1, 2], blob(1)));
    await eventually(async () => (await sender.items()).length === 3);
    expect((await sender.items())[2].token).toBe(START_1);
    // The next run starts one for both.
    b.send(live(0, [2], blob(2), { run: RUN + 1 }));
    await eventually(async () => (await sender.items()).length === 4);
    expect((await sender.items())[3].token).toBe(START_2);
  });

  it('names its token, so a newer card stays', async () => {
    const b = await board();
    await registered(b, { startToken: START_1, activityToken: CARD_1, activityStartedAt: NOW_S });
    expect((await cardEnd(b.id, T1, { activityToken: 'c9'.repeat(40) })).status).toBe(204);
    expect(await row(b.id, 1)).toMatchObject({ activity_token: CARD_1 });
    expect(await b.quiet()).toBe(true);
    expect((await cardEnd(b.id, T1, { activityToken: CARD_1 })).status).toBe(204);
    expect(await row(b.id, 1)).toMatchObject({ activity_token: null });
  });
});

describe('LIVE to Live Activity pushes', () => {
  it('a start sends push-to-start to every startable phone, the starter too, with the one record', async () => {
    const b = await board();
    await registered(b);
    const sender = await fakeSender(b.id);
    b.send(live(0, [1, 2], blob(1), { starter: 1 }));
    await eventually(async () => (await sender.items()).length === 2);
    const i = (await sender.items()).find((x) => x.token === START_2)!;
    expect(i).toMatchObject({ env: 'sandbox', pushType: 'liveactivity', priority: 10, expiration: NOW_S + 360 });
    expect(aps(i)).toEqual({
      timestamp: NOW_S,
      event: 'start',
      'content-state': { v: 2, record: b64(blob(1)), card: NOW_S },
      'stale-date': NOW_S + 360,
      'attributes-type': 'HeaterActivityAttributes',
      attributes: { board: b.id },
      alert: { title: 'Flamekeeper', body: { 'loc-key': 'card.started' } },
      'input-push-token': 1,
    });
    expect((await sender.items()).map((x) => x.token).sort()).toEqual([START_1, START_2]);
    expect(await b.quiet()).toBe(true);
    expect((await row(b.id, 1)).no_start_run).toBe(RUN);
    expect((await row(b.id, 2)).no_start_run).toBe(RUN);
  });

  it('iOS 17 gets no input-push-token', async () => {
    const b = await board();
    await registered(b);
    const sender = await fakeSender(b.id);
    b.send(live(0, [1], blob(1)));
    await eventually(async () => (await sender.items()).length === 1);
    expect(aps((await sender.items())[0])['input-push-token']).toBeUndefined();
  });

  it('an update goes to the card at priority 5, 10 when important, with the card start; none is dropped for coming soon', async () => {
    const b = await board();
    await registered(b, { activityToken: CARD_1, activityStartedAt: NOW_S - 100, startToken: START_1 });
    const sender = await fakeSender(b.id);
    b.send(live(1, [1], blob(1)));
    b.send(live(1, [1], blob(3), { important: true, stale: 400 }));
    await eventually(async () => (await sender.items()).length === 2);
    const [u, v] = await sender.items();
    expect(u).toMatchObject({ token: CARD_1, env: 'production', priority: 5, pushType: 'liveactivity' });
    expect(aps(u)).toEqual({
      timestamp: NOW_S,
      event: 'update',
      'content-state': { v: 2, record: b64(blob(1)), card: NOW_S - 100 },
      'stale-date': NOW_S + 360,
    });
    expect(v.priority).toBe(10);
    expect(aps(v)['stale-date']).toBe(NOW_S + 400);
  });

  it('an update to a phone without a card starts one, once per run', async () => {
    const b = await board();
    await registered(b);
    const sender = await fakeSender(b.id);
    b.send(live(1, [2], blob(2)));
    await eventually(async () => (await sender.items()).length === 1);
    expect((await sender.items())[0]).toMatchObject({ token: START_2 });
    expect(aps((await sender.items())[0]).event).toBe('start');
    b.send(live(1, [2], blob(2)));
    b.send(live(1, [2], blob(2), { run: RUN + 1 }));
    await eventually(async () => (await sender.items()).length === 2);
    expect(await b.quiet(100)).toBe(true);
    expect(await sender.items()).toHaveLength(2);
  });

  it('an end ends the card with its dismissal and forgets the token', async () => {
    const b = await board();
    await registered(b, { startToken: START_1, activityToken: CARD_1, activityStartedAt: NOW_S - 100 });
    const sender = await fakeSender(b.id);
    b.send(live(2, [1, 2], blob(1), { dismissal: 900 }));
    await eventually(async () => (await sender.items()).length === 1);
    const [e] = await sender.items();
    expect(e).toMatchObject({ token: CARD_1, priority: 10, expiration: NOW_S + 8 * 3600 });
    expect(aps(e)).toEqual({
      timestamp: NOW_S,
      event: 'end',
      'content-state': { v: 2, record: b64(blob(1)), card: NOW_S - 100 },
      'dismissal-date': NOW_S + 900,
    });
    expect(toHex(await b.next())).toBe('0008000006');
    expect((await row(b.id, 1)).activity_token).toBeNull();
  });

  it('an end APNs did not take keeps the card token', async () => {
    const b = await board();
    await registered(b, { startToken: START_1, activityToken: CARD_1 });
    await fakeSender(b.id, () => 'failed');
    b.send(live(2, [1], blob(1)));
    expect(await b.quiet(100)).toBe(true);
    expect((await row(b.id, 1)).activity_token).toBe(CARD_1);
  });

  it('a token APNs calls gone is forgotten, the board gets WANT, and a registration with none left goes', async () => {
    const b = await board();
    await registered(b, { startToken: START_1, activityToken: CARD_1 });
    await fakeSender(b.id, () => 'gone');
    b.send(live(1, [1], blob(1)));
    expect(toHex(await b.next())).toBe('0008000006');
    expect(await row(b.id, 1)).toMatchObject({ activity_token: null, start_token: START_1 });
    b.send(live(1, [1], blob(1)));
    expect(toHex(await b.next())).toBe('0008000004');
    expect(await row(b.id, 1)).toBeUndefined();
  });

  it('logs the LIVE event, its slots and each send by kind, never a token; a malformed LIVE is ignored', async () => {
    const b = await board();
    await registered(b, { startToken: START_1, activityToken: CARD_1 });
    await fakeSender(b.id);
    const log = vi.spyOn(console, 'log');
    b.send(new Uint8Array([0, 7, 1, 0]));
    b.send(live(1, [1, 2], blob(1), { starter: 1 }));
    await eventually(() => logged(log).some((l) => l.includes('live update')));
    expect(b.ws.readyState).toBe(WebSocket.OPEN);
    const lines = logged(log);
    expect(lines).toContain(JSON.stringify({ board: b.id, event: 'live malformed' }));
    expect(lines).toContain(
      JSON.stringify({
        board: b.id,
        event: 'live update',
        slots: [1, 2],
        sends: [
          { push: 'update', to: 'activity', env: 'production', outcome: 'sent' },
          { push: 'start', to: 'start', env: 'sandbox', outcome: 'sent' },
        ],
      }),
    );
    for (const l of lines) expect(l).not.toContain(CARD_1);
  });
});

describe('a run that ended', () => {
  it('a card whose token comes after its run ended is ended at once, until the run end dismissal', async () => {
    const b = await board();
    await registered(b);
    const sender = await fakeSender(b.id);
    b.send(live(0, [2], blob(2)));
    await eventually(async () => (await sender.items()).length === 1);
    await at(b, NOW + 8000);
    b.send(live(2, [2], blob(4), { dismissal: 300 }));
    await eventually(async () => (await meta(b.id, 'live_ended')) === NOW_S + 8);
    await at(b, NOW + 30_000);
    const reg = { env: 'sandbox', startToken: START_2, iosVersion: '18.1' };
    expect((await register(b.id, T, { ...reg, activityToken: CARD_2, activityStartedAt: NOW_S })).status).toBe(204);
    expect(toHex(await b.next())).toBe('0008000406');
    await eventually(async () => (await sender.items()).length === 2);
    const e = (await sender.items())[1];
    expect(e.token).toBe(CARD_2);
    expect(aps(e)).toEqual({
      timestamp: NOW_S + 30,
      event: 'end',
      'content-state': { v: 2, record: b64(blob(4)), card: NOW_S },
      'dismissal-date': NOW_S + 8 + 300,
    });
    expect(toHex(await b.next())).toBe('0008000006');
    // A card the app starts itself for the next run is left alone.
    expect((await register(b.id, T, { ...reg, activityToken: CARD_2, activityStartedAt: NOW_S + 30 })).status).toBe(204);
    expect(toHex(await b.next())).toBe('0008000406');
    expect(await b.quiet(100)).toBe(true);
    expect(await sender.items()).toHaveLength(2);
  });
});

describe('the 8-hour renewal', () => {
  it('renews on the first update after 7 h 45 min: a new card, then the old one ends at once', async () => {
    const b = await board();
    await registered(b, { startToken: START_1, activityToken: CARD_1, activityStartedAt: NOW_S - RENEW_AFTER_S + 1, iosVersion: '18.0' });
    const sender = await fakeSender(b.id);
    b.send(live(1, [1], blob(1)));
    await eventually(async () => (await sender.items()).length === 1);
    expect(aps((await sender.items())[0]).event).toBe('update');

    await at(b, NOW + 20_000);
    b.send(live(1, [1], blob(2)));
    await eventually(async () => (await sender.items()).length === 3);
    const [, start, end] = await sender.items();
    expect(start).toMatchObject({ token: START_1, priority: 10 });
    expect(aps(start)).toMatchObject({
      event: 'start',
      'content-state': { v: 2, record: b64(blob(2)), card: NOW_S + 20, relay: { renewed: true } },
      alert: { title: 'Flamekeeper', body: { 'loc-key': 'card.renewed' } },
      'input-push-token': 1,
    });
    expect(end).toMatchObject({ token: CARD_1, priority: 10 });
    expect(aps(end)).toMatchObject({ event: 'end', 'dismissal-date': NOW_S + 20 });
    expect(toHex(await b.next())).toBe('0008000006');
    expect(await row(b.id, 1)).toMatchObject({ activity_token: null, no_start_run: RUN });

    // No second card in this run before the app registers the new one.
    b.send(live(1, [1], blob(3)));
    expect(await b.quiet(100)).toBe(true);
    expect(await sender.items()).toHaveLength(3);
  });

  it('the old card stays when APNs does not take the new one', async () => {
    const b = await board();
    await registered(b, { startToken: START_1, activityToken: CARD_1, activityStartedAt: NOW_S - RENEW_AFTER_S });
    const sender = await fakeSender(b.id, () => 'failed');
    b.send(live(1, [1], blob(1)));
    await eventually(async () => (await sender.items()).length === 1);
    expect(await b.quiet(100)).toBe(true);
    expect((await sender.items()).map((i) => i.token)).toEqual([START_1]);
    expect(await row(b.id, 1)).toMatchObject({ activity_token: CARD_1, no_start_run: null });
  });

  it('a phone without a start token keeps updating its card', async () => {
    const b = await board();
    await registered(b, { activityToken: CARD_1, activityStartedAt: NOW_S - RENEW_AFTER_S - 10 });
    const sender = await fakeSender(b.id);
    b.send(live(1, [1], blob(1)));
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
    b.send(live(1, [1], blob(9)));
    await eventually(async () => (await sender.items()).length === 1);
    await at(b, NOW + 1000);
    b.ws.close(1000);
    await b.closed;
    await eventually(async () => (await meta(b.id, 'last_seen')) === NOW_S + 1);
    return { b, sender };
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
    expect(u).toMatchObject({ token: CARD_1, priority: 10 });
    expect(aps(u)).toEqual({
      timestamp: (gone + 10 * MIN) / 1000,
      event: 'update',
      'content-state': { v: 2, record: b64(blob(9)), card: NOW_S - 100, relay: { lostAt: NOW_S + 1 } },
      'stale-date': (gone + 10 * MIN) / 1000,
    });
    expect(await alarmTime(b.id)).toBe(gone + 60 * MIN);
    await alarmAt(b.id, gone + 60 * MIN);
    const e = (await sender.items())[2];
    expect(aps(e)).toMatchObject({ event: 'end', 'dismissal-date': (gone + 60 * MIN) / 1000 + 900, 'content-state': { relay: { lostAt: NOW_S + 1 } } });
    expect(await row(b.id, 1)).toMatchObject({ activity_token: null, no_start_run: null });
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

describe('keepalive', () => {
  it('the relay answers the text "ping" with "pong", for a board and a phone, signed in or not', async () => {
    const b = await fakeBoard();
    const app = await fakeApp(b.id);
    for (const s of [b, app]) {
      const answer = new Promise((resolve) => s.ws.addEventListener('message', (e) => typeof e.data === 'string' && resolve(e.data)));
      s.send('ping');
      expect(await answer).toBe('pong');
      expect(s.ws.readyState).toBe(WebSocket.OPEN);
    }
  });

  it('a board that sends none for 120 s is taken as gone, last seen at its last one, in a run or not', async () => {
    const b = await board();
    await registered(b, { startToken: START_1, activityToken: CARD_1, activityStartedAt: NOW_S - 100 });
    const sender = await fakeSender(b.id);
    b.send(live(1, [1], blob(9)));
    await eventually(async () => (await sender.items()).length === 1);
    const app = await fakeApp(b.id, T1);
    expect(toHex(await b.next())).toBe('00040101');
    expect(SILENT_MS).toBe(2 * MIN);
    // Heard at NOW + 45 s: the watch moves with it.
    await alarmAt(b.id, NOW + 2 * MIN, NOW + 45_000);
    expect(await alarmTime(b.id)).toBe(NOW + 45_000 + 2 * MIN);
    expect(b.ws.readyState).toBe(WebSocket.OPEN);
    await alarmAt(b.id, NOW + 45_000 + 2 * MIN, NOW + 45_000);
    expect(await b.closed).toEqual({ code: 1001, reason: 'silent' });
    expect(await app.closed).toEqual({ code: 4004, reason: `offline ${NOW_S + 45}` });
    expect(await meta(b.id, 'last_seen')).toBe(NOW_S + 45);
    // Lost contact runs from the last keepalive.
    expect(await alarmTime(b.id)).toBe(NOW + 45_000 + 10 * MIN);
    await alarmAt(b.id, NOW + 45_000 + 10 * MIN);
    expect(aps((await sender.items())[1])['content-state']).toMatchObject({ record: b64(blob(9)), relay: { lostAt: NOW_S + 45 } });
  });

  it('a board socket with no sign-in time (from before a deploy) taken as silent is last seen now, not forgotten', async () => {
    const b = await board();
    await runInDurableObject(room(b.id), (o: BoardRoom, state) => {
      for (const ws of state.getWebSockets('board')) {
        const { authedAt: _, ...old } = ws.deserializeAttachment() as Record<string, unknown>;
        ws.serializeAttachment(old);
      }
      o.clock = () => NOW + 5000;
      o.pingAt = () => null;
    });
    await runDurableObjectAlarm(room(b.id));
    expect(await b.closed).toEqual({ code: 1001, reason: 'silent' });
    expect(await meta(b.id, 'last_seen')).toBe(NOW_S + 5);
    expect(await rows(b.id, 'roster')).toHaveLength(2);
  });
});
