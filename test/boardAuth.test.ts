import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { Close, Op } from '../src/wire';
import type { BoardRoom } from '../src/boardRoom';
import { toHex } from './bytes';
import { attachments, eventually, fakeApp, fakeBoard, newKeys, randomId, room, rows, setClock, storedNothing, tables } from './fakes';

const DAY_MS = 24 * 3600 * 1000;

describe('board sign-in', () => {
  it('a board that signs the challenge is kept', async () => {
    const b = await fakeBoard();
    const t = 1_800_000_000_123;
    await setClock(b.id, t);
    await b.signIn();
    const [a] = await attachments(b.id, 'board');
    expect(a.authed).toBe(true);
    expect(await rows(b.id, 'meta')).toEqual([{ key: 'last_seen', value: Math.floor(t / 1000) }]);
    expect(await b.quiet()).toBe(true);
  });

  it('tells a board that signs in which slots want pushes and live cards: none yet', async () => {
    const b = await fakeBoard();
    const c = await b.next();
    b.send(await b.auth(c.subarray(2)));
    expect(toHex(await b.next())).toBe('00080000');
    expect(await b.quiet()).toBe(true);
  });

  it('sends a fresh 32-byte challenge on every connection', async () => {
    const keys = await newKeys();
    const one = await (await fakeBoard({ keyOf: keys })).next();
    const two = await (await fakeBoard({ keyOf: keys })).next();
    expect(one.length).toBe(34);
    expect([one[0], one[1]]).toEqual([0, Op.challenge]);
    expect(one).not.toEqual(two);
  });

  it('refuses a key whose hash is not the id', async () => {
    const other = await fakeBoard();
    const b = await fakeBoard({ id: other.id });
    const c = await b.next();
    b.send(await b.auth(c.subarray(2)));
    expect((await b.closed).code).toBe(Close.authFailed);
  });

  it('refuses a signature over another host', async () => {
    const b = await fakeBoard();
    const c = await b.next();
    b.send(await b.auth(c.subarray(2), 'relay.example.com'));
    expect((await b.closed).code).toBe(Close.authFailed);
  });

  it('checks the host as the board dialled it, port included', async () => {
    const b = await fakeBoard({ host: 'relay.example.com:8443' });
    await b.signIn();
    const c = await fakeBoard({ host: 'relay.example.com:8443', keyOf: b.keys });
    const challenge = await c.next();
    c.send(await c.auth(challenge.subarray(2), 'relay.example.com'));
    expect((await c.closed).code).toBe(Close.authFailed);
  });

  it('refuses an AUTH replayed from an earlier connection', async () => {
    const keys = await newKeys();
    const first = await fakeBoard({ keyOf: keys });
    const old = await first.auth((await first.next()).subarray(2));
    first.ws.close(1000);
    const b = await fakeBoard({ keyOf: keys });
    await b.next();
    b.send(old);
    expect((await b.closed).code).toBe(Close.authFailed);
  });

  it('refuses a malformed AUTH or another message before it', async () => {
    const b = await fakeBoard();
    await b.next();
    b.send(new Uint8Array([0, Op.roster, 1]));
    expect((await b.closed).code).toBe(Close.authFailed);
  });

  it('closes a board that does not authenticate within 10 s', async () => {
    const b = await fakeBoard();
    await b.next();
    const [a] = await attachments(b.id, 'board');
    await setClock(b.id, (a.since as number) + 9_999);
    expect(await runDurableObjectAlarm(room(b.id))).toBe(true);
    expect(await b.quiet()).toBe(true);
    await setClock(b.id, (a.since as number) + 10_000);
    await runDurableObjectAlarm(room(b.id));
    expect((await b.closed).code).toBe(Close.authFailed);
  });

  it('a second board socket replaces the first', async () => {
    const first = await fakeBoard();
    await first.signIn();
    const second = await fakeBoard({ keyOf: first.keys });
    await second.signIn();
    expect((await first.closed).code).toBe(Close.replaced);
    const left = await attachments(first.id, 'board');
    expect(left.filter((a) => a.authed)).toHaveLength(1);
    expect(await second.quiet()).toBe(true);
  });

  it('a failed sign-in does not replace the board that is in', async () => {
    const first = await fakeBoard();
    await first.signIn();
    const second = await fakeBoard({ keyOf: first.keys });
    const c = await second.next();
    second.send(await second.auth(c.subarray(2), 'relay.example.com'));
    expect((await second.closed).code).toBe(Close.authFailed);
    expect(await first.quiet()).toBe(true);
    expect((await attachments(first.id, 'board')).filter((a) => a.authed)).toHaveLength(1);
  });

  it('a text message or a 2049-byte message from the board closes it 4008', async () => {
    const a = await fakeBoard();
    await a.signIn();
    a.send('hello');
    expect((await a.closed).code).toBe(Close.policy);

    const b = await fakeBoard();
    await b.signIn();
    b.send(new Uint8Array(2049));
    expect((await b.closed).code).toBe(Close.policy);

    const c = await fakeBoard();
    await c.next();
    c.send(new Uint8Array(4609));
    expect((await c.closed).code).toBe(Close.policy);
  });

  it('a room no board signed in to keeps nothing after its sign-in and token deadlines', async () => {
    const id = randomId();
    const board = await fakeBoard({ id });
    await board.next();
    const app = await fakeApp(id);
    await eventually(async () => (await attachments(id, 'app')).length === 1);
    const since = Math.max(...[...(await attachments(id, 'board')), ...(await attachments(id, 'app'))].map((a) => a.since as number));
    await setClock(id, since + 10_000);
    expect(await runDurableObjectAlarm(room(id))).toBe(true);
    expect((await board.closed).code).toBe(Close.authFailed);
    expect((await app.closed).code).toBe(Close.policy);
    await eventually(() => storedNothing(id));
  });

  it('writes nothing for a board that fails to sign in', async () => {
    const b = await fakeBoard({ id: randomId() });
    const c = await b.next();
    b.send(await b.auth(c.subarray(2)));
    await b.closed;
    expect(await rows(b.id, 'meta')).toEqual([]);
    expect(await rows(b.id, 'roster')).toEqual([]);
    expect(await tables(b.id)).toEqual([]);
    // Its 10 s deadline alarm was the only thing stored, and it is gone with the socket.
    await eventually(() => storedNothing(b.id));
  });

  it('records the last-seen time when the board goes away', async () => {
    const b = await fakeBoard();
    await b.signIn();
    await setClock(b.id, 1_900_000_000_999);
    b.ws.close(1000);
    await b.closed;
    await eventually(async () => (await rows(b.id, 'meta'))[0]?.value === 1_900_000_000);
  });

  it('forgets a board unseen for 90 days', async () => {
    for (const [days, kept] of [
      [91, false],
      [89, true],
    ] as const) {
      const b = await fakeBoard();
      await b.signIn();
      b.ws.close(1000);
      await b.closed;
      const now = 1_800_000_000_000;
      await eventually(async () => (await rows(b.id, 'meta')).length === 1);
      await setLastSeen(b.id, Math.floor((now - days * DAY_MS) / 1000));
      await setClock(b.id, now);
      expect(await runDurableObjectAlarm(room(b.id))).toBe(true);
      expect((await tables(b.id)).length > 0, `${days} days`).toBe(kept);
    }
  });
});

function setLastSeen(id: string, seconds: number): Promise<void> {
  return runInDurableObject(room(id), (_o: BoardRoom, state) => {
    state.storage.sql.exec(`UPDATE meta SET value = ? WHERE key = 'last_seen'`, seconds);
  });
}
