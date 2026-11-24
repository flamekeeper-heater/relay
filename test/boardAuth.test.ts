import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { Close, Op } from '../src/wire';
import type { BoardRoom } from '../src/boardRoom';
import { attachments, eventually, fakeApp, fakeBoard, meta, newKeys, randomId, room, setClock, storedNothing } from './fakes';

const DAY_MS = 24 * 3600 * 1000;

describe('board sign-in', () => {
  it('a board that signs the challenge is kept', async () => {
    const b = await fakeBoard();
    const t = 1_800_000_000_123;
    await setClock(b.id, t);
    await b.signIn();
    const [a] = await attachments(b.id, 'board');
    expect(a.authedAt).toBe(t);
    expect(await meta(b.id, 'last_seen')).toBe(Math.floor(t / 1000));
    expect(await b.quiet()).toBe(true);
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
    expect(left.filter((a) => a.authedAt !== null)).toHaveLength(1);
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
    expect((await attachments(first.id, 'board')).filter((a) => a.authedAt !== null)).toHaveLength(1);
  });

  it('a text message from the board closes it 1003, a 2049-byte message 1009', async () => {
    const a = await fakeBoard();
    await a.signIn();
    a.send('hello');
    expect((await a.closed).code).toBe(1003);

    const b = await fakeBoard();
    await b.signIn();
    b.send(new Uint8Array(2049));
    expect((await b.closed).code).toBe(1009);

    const c = await fakeBoard();
    await c.next();
    c.send(new Uint8Array(4609));
    expect((await c.closed).code).toBe(1009);
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
    expect((await app.closed).code).toBe(1008);
    await eventually(() => storedNothing(id));
  });

  it('writes nothing for a board that fails to sign in', async () => {
    const b = await fakeBoard({ id: randomId() });
    const c = await b.next();
    b.send(await b.auth(c.subarray(2)));
    await b.closed;
    expect(await meta(b.id, 'last_seen')).toBeNull();
    // Its 10 s deadline alarm was the only thing stored, and it is gone with the socket.
    await eventually(() => storedNothing(b.id));
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
      await setLastSeen(b.id, Math.floor((now - days * DAY_MS) / 1000));
      await setClock(b.id, now);
      expect(await runDurableObjectAlarm(room(b.id))).toBe(true);
      expect((await meta(b.id, 'last_seen')) !== null, `${days} days`).toBe(kept);
      expect(await storedNothing(b.id), `${days} days`).toBe(!kept);
    }
  });
});

function setLastSeen(id: string, seconds: number): Promise<void> {
  return runInDurableObject(room(id), (_o: BoardRoom, state) => {
    state.storage.kv.put('last_seen', seconds);
  });
}
