import { runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { Close } from '../src/wire';
import { hex, sha256, toHex } from './bytes';
import {
  type FakeBoardSocket,
  attachments,
  eventually,
  fakeApp,
  fakeBoard,
  meta,
  randomId,
  room,
  rows,
  setClock,
} from './fakes';

// The relay token of the Wi-Fi key secret 32 × 09, and its hash (PROTOCOL.md).
const T = hex('16c1df6a87aaeae336a68c3cb93442b2246922a2edaee096e2439ee205578c0a');
const H = hex('d91429cfba5c46b38cfeb129eb4f263b616323ad4d7c20aeb3430d641258e834');

function randomToken(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/** A signed-in board whose roster the relay has stored. */
async function boardWith(entries: Array<[number, Uint8Array]>, b?: FakeBoardSocket): Promise<FakeBoardSocket> {
  b ??= await fakeBoard();
  await b.signIn();
  await b.roster(entries);
  return b;
}

describe('app admission', () => {
  it('admits a phone whose token is in the roster', async () => {
    const b = await boardWith([[2, H]]);
    const app = await fakeApp(b.id, T);
    expect(toHex(await b.next())).toBe('00040102');
    expect(await app.quiet()).toBe(true);
    const [a] = await attachments(b.id, 'app');
    expect(a).toMatchObject({ role: 'app', slot: 2, channel: 1 });
  });

  it('refuses an unknown token with 4003 whether the board is online, offline or was never seen', async () => {
    const online = await boardWith([[2, H]]);
    const offline = await boardWith([[2, H]]);
    offline.ws.close(1000);
    await offline.closed;
    const never = randomId();
    const closes = [];
    for (const id of [online.id, offline.id, never]) closes.push(await (await fakeApp(id, randomToken())).closed);
    expect(closes).toEqual([
      { code: Close.notPaired, reason: '' },
      { code: Close.notPaired, reason: '' },
      { code: Close.notPaired, reason: '' },
    ]);
    expect(await online.quiet()).toBe(true);
  });

  it('tells a paired phone the heater is offline since its last-seen time', async () => {
    const b = await boardWith([[2, H]]);
    const t0 = 1_800_000_123_456;
    await setClock(b.id, t0);
    b.ws.close(1000);
    await b.closed;
    await eventually(async () => (await meta(b.id, 'last_seen')) === 1_800_000_123);
    expect(await (await fakeApp(b.id, T)).closed).toEqual({ code: Close.offline, reason: 'offline 1800000123' });
  });

  it('a phone of a board that is connected but not yet authed gets 4004', async () => {
    const first = await boardWith([[2, H]]);
    await setClock(first.id, 1_800_000_000_000);
    first.ws.close(1000);
    await first.closed;
    await eventually(async () => (await meta(first.id, 'last_seen')) === 1_800_000_000);
    const b = await fakeBoard({ keyOf: first.keys });
    await b.next(); // the challenge, left unanswered
    expect(await (await fakeApp(b.id, T)).closed).toEqual({ code: Close.offline, reason: 'offline 1800000000' });
  });

  it('closes 1008 on a 31-byte first message or 10 s with no token, 1003 on a text message', async () => {
    const b = await boardWith([[2, H]]);
    expect((await (await fakeApp(b.id, T.subarray(0, 31))).closed).code).toBe(Close.policy);
    const text = await fakeApp(b.id);
    text.send('x'.repeat(32));
    expect((await text.closed).code).toBe(Close.unsupported);

    const idle = await fakeApp(b.id);
    await eventually(async () => (await attachments(b.id, 'app')).length > 0);
    const [a] = (await attachments(b.id, 'app')).filter((x) => x.slot === null);
    await setClock(b.id, (a.since as number) + 9_999);
    await runDurableObjectAlarm(room(b.id));
    expect(await idle.quiet()).toBe(true);
    await setClock(b.id, (a.since as number) + 10_000);
    await runDurableObjectAlarm(room(b.id));
    expect((await idle.closed).code).toBe(Close.policy);
    expect(await b.quiet()).toBe(true);
  });

  it('never refuses a token in the roster, however many bad tokens came first', async () => {
    const b = await boardWith([[2, H]]);
    for (let i = 0; i < 30; i++) expect((await (await fakeApp(b.id, randomToken())).closed).code).toBe(Close.notPaired);
    const app = await fakeApp(b.id, T);
    expect(toHex(await b.next())).toBe('00040102');
    expect(await app.quiet()).toBe(true);
  });

  it('a new roster closes the phones whose slot left it or changed hash', async () => {
    const tokens = [randomToken(), randomToken(), randomToken()];
    const hashes = await Promise.all(tokens.map(sha256));
    const b = await boardWith([
      [0, hashes[0]],
      [1, hashes[1]],
      [2, hashes[2]],
    ]);
    const apps = [];
    for (const [i, t] of tokens.entries()) {
      apps.push(await fakeApp(b.id, t));
      expect(toHex(await b.next())).toBe(`0004${toHex(new Uint8Array([i + 1, i]))}`);
    }
    const changed = randomToken();
    const next: Array<[number, Uint8Array]> = [
      [0, hashes[0]],
      [2, await sha256(changed)],
      [5, H],
    ];
    await b.roster(next);
    expect((await apps[1].closed).code).toBe(Close.notPaired);
    expect((await apps[2].closed).code).toBe(Close.notPaired);
    const told = [toHex(await b.next()), toHex(await b.next())].sort();
    expect(told).toEqual(['000502a30f', '000503a30f']);
    expect(await apps[0].quiet()).toBe(true);
    const stored = await rows(b.id, 'roster');
    expect(stored.map((r) => [r.slot, toHex(new Uint8Array(r.hash as ArrayBuffer))])).toEqual(
      next.map(([s, h]) => [s, toHex(h)]),
    );
  });

  it('takes a ROSTER sent right behind AUTH', async () => {
    const b = await fakeBoard();
    const c = await b.next();
    b.send(await b.auth(c.subarray(2)));
    await b.roster([[2, H]]);
    await fakeApp(b.id, T);
    expect(toHex(await b.next())).toBe('00040102');
  });

  it('closes a board whose roster is malformed with 1008', async () => {
    const b = await fakeBoard();
    await b.signIn();
    b.send(new Uint8Array([0, 3, 2]));
    expect((await b.closed).code).toBe(Close.policy);
  });
});
