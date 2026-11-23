import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { freshMemory, type BoardRoom } from '../src/boardRoom';
import { type Env, handle } from '../src/index';
import { OFFLINE_CHOICES, parseBearer, parseRegistration } from '../src/push/registry';
import { parsePath } from '../src/wire';
import { hex, sha256, toHex } from './bytes';
import {
  type FakeBoardSocket,
  HOST,
  base64url,
  eventually,
  fakeBoard,
  freshIp,
  randomId,
  register,
  room,
  rows,
  storedNothing,
  tables,
} from './fakes';

// The relay token of the Wi-Fi key secret 32 × 09, and its hash (PROTOCOL.md).
const T = hex('16c1df6a87aaeae336a68c3cb93442b2246922a2edaee096e2439ee205578c0a');
const H = hex('d91429cfba5c46b38cfeb129eb4f263b616323ad4d7c20aeb3430d641258e834');
const DEVICE = 'aa'.repeat(32);
const FIRST = { kind: 'apns', env: 'sandbox', device: DEVICE, offlineAfter: 0 };

function randomToken(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/** A signed-in board whose roster the relay has stored. */
async function boardWith(entries: Array<[number, Uint8Array]>, b?: FakeBoardSocket, want = '0008000000'): Promise<FakeBoardSocket> {
  b ??= await fakeBoard();
  await b.signIn();
  b.roster(entries);
  expect(toHex(await b.next())).toBe(want); // WANT, after the roster is stored
  return b;
}

/** A board that signed in with a roster and left again. */
async function boardGone(entries: Array<[number, Uint8Array]>): Promise<string> {
  const b = await boardWith(entries);
  b.ws.close(1000);
  await b.closed;
  await eventually(async () => (await rows(b.id, 'meta')).length === 1);
  return b.id;
}

function call(url: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<Response> {
  return exports.default.fetch(url, { ...init, headers: { 'CF-Connecting-IP': freshIp(), ...init.headers } });
}

describe('registration parsing', () => {
  it('reads the registration path as role push', () => {
    const id = 'ngf6uy64isruizr76fbjv2qqqq';
    expect(parsePath(`/v1/app/${id}/push`)).toEqual({ role: 'push', id, activity: false });
    expect(parsePath(`/v1/app/${id}/push/activity`)).toEqual({ role: 'push', id, activity: true });
    expect(parsePath(`/v1/board/${id}/push/activity`)).toBeNull();
    expect(parsePath(`/v1/app/${id}/push/activity/`)).toBeNull();
    expect(parsePath(`/v1/board/${id}/push`)).toBeNull();
    expect(parsePath(`/v1/app/${id}/push/`)).toBeNull();
    expect(parsePath(`/v1/app/${id}/pushx`)).toBeNull();
  });

  it('takes only the known fields with their allowed values', () => {
    expect(parseRegistration(JSON.stringify(FIRST))).toEqual(FIRST);
    expect(parseRegistration('{}')).toEqual({});
    expect(parseRegistration('{"device":null}')).toEqual({ device: null });
    expect(parseRegistration(JSON.stringify({ env: 'production', device: 'f'.repeat(200) }))).toEqual({
      env: 'production',
      device: 'f'.repeat(200),
    });
    for (const n of OFFLINE_CHOICES) expect(parseRegistration(`{"offlineAfter":${n}}`)).toEqual({ offlineAfter: n });
    for (const bad of [
      '',
      'null',
      '[]',
      '"x"',
      '{',
      '{"kind":"fcm"}',
      '{"env":"dev"}',
      '{"device":"XYZ"}',
      `{"device":"${'A'.repeat(64)}"}`,
      `{"device":"${'a'.repeat(63)}"}`,
      `{"device":"${'a'.repeat(65)}"}`, // whole bytes only
      `{"device":"${'a'.repeat(199)}"}`,
      `{"device":"${'a'.repeat(201)}"}`,
      '{"device":5}',
      '{"offlineAfter":45}',
      '{"offlineAfter":"30"}',
      '{"offlineAfter":30.5}',
      '{"startToken":"aa"}',
    ]) {
      expect(parseRegistration(bad), bad).toBeNull();
    }
  });

  it('reads a Bearer token of 43 base64url characters', () => {
    expect(toHex(parseBearer(`Bearer ${base64url(T)}`)!)).toBe(toHex(T));
    for (const bad of [
      null,
      '',
      base64url(T),
      `bearer ${base64url(T)}`,
      `Bearer ${base64url(T)}=`,
      `Bearer ${base64url(T).slice(1)}`,
      `Bearer ${base64url(T)}A`,
      `Bearer ${base64url(T).slice(0, 42)}+`,
      `Bearer ${base64url(T).slice(0, 42)}B`, // spare bits set: not the canonical form
    ]) {
      expect(parseBearer(bad), String(bad)).toBeNull();
    }
  });
});

describe('push registrations', () => {
  it('stores a registration for the slot its token matches', async () => {
    const b = await boardWith([[2, H]]);
    expect((await register(b.id, T, FIRST)).status).toBe(204);
    expect(await rows(b.id, 'push')).toEqual([
      {
        slot: 2,
        kind: 'apns',
        env: 'sandbox',
        device: DEVICE,
        offline_after: 0,
        offline_sent: 0,
        updated: expect.any(Number),
        start_token: null,
        activity_token: null,
        activity_started: null,
        ios: null,
        dismissed_run: null,
        started_run: null,
        lost_run: null,
        live_blob: null,
        live_event: null,
      },
    ]);
  });

  it('tells a signed-in board at once', async () => {
    const b = await boardWith([[2, H]]);
    expect((await register(b.id, T, FIRST)).status).toBe(204);
    expect(toHex(await b.next())).toBe('0008040000');
    expect(await b.quiet()).toBe(true);
  });

  it('merges fields', async () => {
    const b = await boardWith([[2, H]]);
    expect((await register(b.id, T, { env: 'sandbox', device: DEVICE })).status).toBe(204);
    expect(toHex(await b.next())).toBe('0008040000');
    expect((await register(b.id, T, { offlineAfter: 60 })).status).toBe(204);
    expect(await rows(b.id, 'push')).toMatchObject([{ slot: 2, kind: 'apns', env: 'sandbox', device: DEVICE, offline_after: 60 }]);
    expect((await register(b.id, T, { env: 'production', device: 'bb'.repeat(32) })).status).toBe(204);
    expect(await rows(b.id, 'push')).toMatchObject([{ env: 'production', device: 'bb'.repeat(32), offline_after: 60 }]);
    expect(await b.quiet()).toBe(true); // the push mask did not change
  });

  it('a first PUT without env or device is 400, and so is a bad field', async () => {
    const b = await boardWith([[2, H]]);
    for (const body of [
      { device: DEVICE },
      { env: 'sandbox' },
      { env: 'sandbox', device: null },
      { ...FIRST, offlineAfter: 45 },
      { ...FIRST, extra: 1 },
      { ...FIRST, device: 'XYZ' },
    ]) {
      expect((await register(b.id, T, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await rows(b.id, 'push')).toEqual([]);
    expect(await b.quiet()).toBe(true);
  });

  it('a body over 1024 bytes is 413, another method 405', async () => {
    const b = await boardWith([[2, H]]);
    const big = { device: 'a'.repeat(1012) };
    expect(JSON.stringify(big).length).toBe(1025);
    expect((await register(b.id, T, big)).status).toBe(413);
    const url = `https://${HOST}/v1/app/${b.id}/push`;
    const auth = { Authorization: `Bearer ${base64url(T)}` };
    for (const method of ['POST', 'GET', 'PATCH']) {
      const body = method === 'GET' ? undefined : JSON.stringify(FIRST);
      expect((await call(url, { method, headers: auth, body })).status, method).toBe(405);
    }
    expect(await rows(b.id, 'push')).toEqual([]);
  });

  it('refuses an unknown token with 401 and writes nothing', async () => {
    const b = await boardWith([[2, H]]);
    expect((await register(b.id, randomToken(), FIRST)).status).toBe(401);
    expect((await register(b.id, randomToken(), null, 'DELETE')).status).toBe(401);
    const url = `https://${HOST}/v1/app/${b.id}/push`;
    for (const headers of [{} as Record<string, string>, { Authorization: `Basic ${base64url(T)}` }, { Authorization: `Bearer ${base64url(T.subarray(1))}` }]) {
      expect((await call(url, { method: 'PUT', headers, body: JSON.stringify(FIRST) })).status).toBe(401);
    }
    expect(await rows(b.id, 'push')).toEqual([]);
    expect(await b.quiet()).toBe(true);
  });

  it('refuses any token for an id no board signed in as, and stores nothing', async () => {
    const id = randomId();
    expect((await register(id, T, FIRST)).status).toBe(401);
    expect((await register(id, T, null, 'DELETE')).status).toBe(401);
    expect(await storedNothing(id)).toBe(true);
  });

  it('DELETE removes it and the next WANT is 00 08 00 00', async () => {
    const b = await boardWith([[2, H]]);
    expect((await register(b.id, T, FIRST)).status).toBe(204);
    expect(toHex(await b.next())).toBe('0008040000');
    expect((await register(b.id, T, null, 'DELETE')).status).toBe(204);
    expect(toHex(await b.next())).toBe('0008000000');
    expect(await rows(b.id, 'push')).toEqual([]);
    expect((await register(b.id, T, null, 'DELETE')).status).toBe(204); // already gone: still fine
    expect(await b.quiet()).toBe(true);
  });

  it('a device of null keeps the row but leaves the push mask', async () => {
    const b = await boardWith([[2, H]]);
    expect((await register(b.id, T, { ...FIRST, offlineAfter: 30 })).status).toBe(204);
    expect(toHex(await b.next())).toBe('0008040000');
    expect((await register(b.id, T, { device: null })).status).toBe(204);
    expect(toHex(await b.next())).toBe('0008000000');
    expect(await rows(b.id, 'push')).toMatchObject([{ slot: 2, device: null, offline_after: 30 }]);
  });

  it('a new roster without the slot deletes its registration', async () => {
    const other = randomToken();
    const b = await boardWith([
      [1, await sha256(other)],
      [2, H],
    ]);
    expect((await register(b.id, T, FIRST)).status).toBe(204);
    expect((await register(b.id, other, FIRST)).status).toBe(204);
    expect(toHex(await b.next())).toBe('0008040000');
    expect(toHex(await b.next())).toBe('0008060000');
    b.roster([[1, await sha256(other)]]);
    expect(toHex(await b.next())).toBe('0008020000');
    expect((await rows(b.id, 'push')).map((r) => r.slot)).toEqual([1]);
  });

  it('a new hash in the slot deletes it (a new phone in an old phone’s slot)', async () => {
    const b = await boardWith([[2, H]]);
    expect((await register(b.id, T, FIRST)).status).toBe(204);
    expect(toHex(await b.next())).toBe('0008040000');
    const newPhone = randomToken();
    b.roster([[2, await sha256(newPhone)]]);
    expect(toHex(await b.next())).toBe('0008000000');
    expect(await rows(b.id, 'push')).toEqual([]);
    expect((await register(b.id, T, FIRST)).status).toBe(401); // the old phone is out
    b.roster([[2, await sha256(newPhone)]]); // the same roster again keeps nothing to delete
    expect(toHex(await b.next())).toBe('0008000000');
  });

  it('WANT after AUTH lists the registered slots of the stored roster', async () => {
    const b = await boardWith([[2, H]]);
    expect((await register(b.id, T, FIRST)).status).toBe(204);
    expect(toHex(await b.next())).toBe('0008040000');
    b.ws.close(1000);
    await b.closed;
    const again = await fakeBoard({ keyOf: b.keys });
    await again.signIn('0008040000');
    again.roster([[2, H]]);
    expect(toHex(await again.next())).toBe('0008040000');
  });

  it('answers 503 push not available when the APNs secrets are missing', async () => {
    const b = await boardWith([[2, H]]);
    const without: Env = { BOARD: env.BOARD, PUSH: env.PUSH, BOARD_CONNECTS: env.BOARD_CONNECTS, APP_CONNECTS: env.APP_CONNECTS, BUNDLE_ID: env.BUNDLE_ID };
    const r = await handle(
      new Request(`https://${HOST}/v1/app/${b.id}/push`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${base64url(T)}`, 'CF-Connecting-IP': freshIp() },
        body: JSON.stringify(FIRST),
      }),
      without,
    );
    expect(r.status).toBe(503);
    expect(await r.text()).toBe('push not available');
    expect(await rows(b.id, 'push')).toEqual([]);
  });

  it('a plain http PUT to a non-local host is 403; localhost may', async () => {
    const b = await boardWith([[2, H]]);
    const init = { method: 'PUT', headers: { Authorization: `Bearer ${base64url(T)}` }, body: JSON.stringify(FIRST) };
    expect((await call(`http://${HOST}/v1/app/${b.id}/push`, init)).status).toBe(403);
    expect(await rows(b.id, 'push')).toEqual([]);
    expect((await call(`http://localhost:8787/v1/app/${b.id}/push`, init)).status).toBe(204);
  });

  it('a registration survives the board being offline', async () => {
    const id = await boardGone([[2, H]]);
    expect((await register(id, T, FIRST)).status).toBe(204);
    expect(await rows(id, 'push')).toMatchObject([{ slot: 2, device: DEVICE }]);
  });

  it('a room stored before pushes gets its push table on first use', async () => {
    const b = await boardWith([[2, H]]);
    b.ws.close(1000);
    await b.closed;
    await eventually(async () => (await rows(b.id, 'meta')).length === 1);
    const asBefore = () =>
      runInDurableObject(room(b.id), (o: BoardRoom, state) => {
        state.storage.sql.exec(`DROP TABLE IF EXISTS push`);
        o.mem = freshMemory();
      });
    await asBefore();
    expect((await register(b.id, T, FIRST)).status).toBe(204);
    expect(await rows(b.id, 'push')).toMatchObject([{ slot: 2 }]);

    await asBefore();
    const again = await fakeBoard({ keyOf: b.keys });
    await again.signIn();
    expect(await tables(b.id)).toContain('push');
  });
});
