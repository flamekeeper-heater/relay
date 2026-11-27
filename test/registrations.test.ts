import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { type Env, handle } from '../src/index';
import { parseBearer, parseCardEnd, parseRegistration } from '../src/push/registry';
import { parsePath } from '../src/wire';
import { hex, sha256, toHex } from './bytes';
import { type FakeBoardSocket, HOST, base64url, cardEnd, fakeBoard, freshIp, randomId, register, rows, storedNothing } from './fakes';

// The relay token of the Wi-Fi key secret 32 × 09, and its hash (PROTOCOL.md).
const T = hex('16c1df6a87aaeae336a68c3cb93442b2246922a2edaee096e2439ee205578c0a');
const H = hex('d91429cfba5c46b38cfeb129eb4f263b616323ad4d7c20aeb3430d641258e834');
const DEVICE = 'aa'.repeat(32);
const START = '51'.repeat(40);
const CARD = 'c1'.repeat(40);
const FIRST = { env: 'sandbox', device: DEVICE };

function randomToken(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/** A signed-in board whose roster the relay has stored. */
async function boardWith(entries: Array<[number, Uint8Array]>): Promise<FakeBoardSocket> {
  const b = await fakeBoard();
  await b.signIn();
  await b.roster(entries);
  return b;
}

describe('registration parsing', () => {
  it('reads the registration paths', () => {
    const id = 'ngf6uy64isruizr76fbjv2qqqq';
    expect(parsePath(`/v1/app/${id}/push`)).toEqual({ role: 'push', id });
    expect(parsePath(`/v1/app/${id}/push/activity/end`)).toEqual({ role: 'cardEnd', id });
  });

  it('takes the whole registration: env, at least one token, only known keys with allowed values', () => {
    expect(parseRegistration(JSON.stringify(FIRST))).toEqual({
      env: 'sandbox',
      device: DEVICE,
      offlineAfter: 0,
      startToken: null,
      activityToken: null,
      activityStartedAt: null,
      iosVersion: null,
    });
    const full = { env: 'production', device: 'f'.repeat(200), offlineAfter: 1440, startToken: START, activityToken: CARD, activityStartedAt: 1_900_000_000, iosVersion: '18.1' };
    expect(parseRegistration(JSON.stringify(full))).toEqual(full);
    // A card's start goes with its token.
    expect(parseRegistration(JSON.stringify({ env: 'sandbox', startToken: START, activityStartedAt: 5 }))!.activityStartedAt).toBeNull();
    for (const bad of [
      '',
      'null',
      '[]',
      '{',
      { device: DEVICE },
      { env: 'sandbox' },
      { env: 'sandbox', device: null },
      { env: 'dev', device: DEVICE },
      { ...FIRST, extra: 1 },
      { ...FIRST, device: 'XYZ' },
      { ...FIRST, device: 'A'.repeat(64) },
      { ...FIRST, device: 'a'.repeat(62) },
      { ...FIRST, device: 'a'.repeat(65) }, // whole bytes only
      { ...FIRST, device: 'a'.repeat(202) },
      { ...FIRST, device: 5 },
      { ...FIRST, offlineAfter: 45 },
      { ...FIRST, offlineAfter: '30' },
      { ...FIRST, startToken: 'aa' },
      { ...FIRST, activityToken: CARD, activityStartedAt: -1 },
      { ...FIRST, activityToken: CARD, activityStartedAt: 1.5 },
      { ...FIRST, iosVersion: '18' },
    ]) {
      const body = typeof bad === 'string' ? bad : JSON.stringify(bad);
      expect(parseRegistration(body), body).toBeNull();
    }
  });

  it('reads "my card ended": which card, and whether it was swiped away', () => {
    expect(parseCardEnd('')).toEqual({ token: null, dismissed: false });
    expect(parseCardEnd(JSON.stringify({ activityToken: CARD, dismissed: true }))).toEqual({ token: CARD, dismissed: true });
    for (const bad of ['[]', '{"dismissed":1}', '{"activityToken":"XY"}', '{"reason":"ended"}']) expect(parseCardEnd(bad), bad).toBeNull();
  });

  it('reads a Bearer token of 43 base64url characters', () => {
    expect(toHex(parseBearer(`Bearer ${base64url(T)}`)!)).toBe(toHex(T));
    for (const bad of [null, '', base64url(T), `bearer ${base64url(T)}`, `Bearer ${base64url(T)}=`, `Bearer ${base64url(T).slice(1)}`, `Bearer ${base64url(T)}A`, `Bearer ${base64url(T).slice(0, 42)}+`]) {
      expect(parseBearer(bad), String(bad)).toBeNull();
    }
  });
});

describe('push registrations', () => {
  it('stores a registration for the slot its token matches', async () => {
    const b = await boardWith([[2, H]]);
    expect((await register(b.id, T, { ...FIRST, startToken: START, activityToken: CARD, activityStartedAt: 7, iosVersion: '17.2' })).status).toBe(204);
    expect(await rows(b.id, 'registration')).toEqual([
      {
        slot: 2,
        env: 'sandbox',
        device: DEVICE,
        offline_after: 0,
        offline_sent: 0,
        start_token: START,
        activity_token: CARD,
        activity_started: 7,
        ios: '17.2',
        no_start_run: null,
        start_env: null,
        activity_env: null,
      },
    ]);
  });

  it('a PUT replaces the registration: what it leaves out is gone', async () => {
    const b = await boardWith([[2, H]]);
    expect((await register(b.id, T, { ...FIRST, startToken: START, offlineAfter: 60 })).status).toBe(204);
    expect((await register(b.id, T, { env: 'production', device: 'bb'.repeat(32) })).status).toBe(204);
    expect(await rows(b.id, 'registration')).toMatchObject([{ env: 'production', device: 'bb'.repeat(32), start_token: null, offline_after: 0 }]);
  });

  it('a bad body is 400, one over 1024 bytes 413, another method 405; nothing is stored', async () => {
    const b = await boardWith([[2, H]]);
    expect((await register(b.id, T, { env: 'sandbox' })).status).toBe(400);
    const big = { env: 'sandbox', device: 'a'.repeat(996) };
    expect(JSON.stringify(big).length).toBe(1025);
    expect((await register(b.id, T, big)).status).toBe(413);
    for (const method of ['POST', 'PATCH']) expect((await register(b.id, T, FIRST, method)).status, method).toBe(405);
    expect((await register(b.id, T, null, 'DELETE', '/activity/end')).status).toBe(405);
    expect((await cardEnd(b.id, T, { reason: 'ended' })).status).toBe(400);
    expect(await rows(b.id, 'registration')).toEqual([]);
    expect(await b.quiet()).toBe(true);
  });

  it('refuses an unknown or missing token with 401 and writes nothing', async () => {
    const b = await boardWith([[2, H]]);
    expect((await register(b.id, randomToken(), FIRST)).status).toBe(401);
    expect((await register(b.id, randomToken(), null, 'DELETE')).status).toBe(401);
    expect((await cardEnd(b.id, randomToken(), null)).status).toBe(401);
    const r = await handle(new Request(`https://${HOST}/v1/app/${b.id}/push`, { method: 'PUT', headers: { 'CF-Connecting-IP': freshIp() }, body: JSON.stringify(FIRST) }), env as unknown as Env);
    expect(r.status).toBe(401);
    expect(await rows(b.id, 'registration')).toEqual([]);
    expect(await b.quiet()).toBe(true);
  });

  it('refuses any token for an id no board signed in as, and stores nothing', async () => {
    const id = randomId();
    expect((await register(id, T, FIRST)).status).toBe(401);
    expect(await storedNothing(id)).toBe(true);
  });

  it('DELETE removes it', async () => {
    const b = await boardWith([[2, H]]);
    expect((await register(b.id, T, FIRST)).status).toBe(204);
    expect((await register(b.id, T, null, 'DELETE')).status).toBe(204);
    expect(await rows(b.id, 'registration')).toEqual([]);
    expect((await register(b.id, T, null, 'DELETE')).status).toBe(204); // already gone: still fine
    expect(await b.quiet()).toBe(true);
  });

  it('a new roster without the slot deletes its registration', async () => {
    const other = randomToken();
    const b = await boardWith([
      [1, await sha256(other)],
      [2, H],
    ]);
    expect((await register(b.id, T, FIRST)).status).toBe(204);
    expect((await register(b.id, other, FIRST)).status).toBe(204);
    await b.roster([[1, await sha256(other)]]);
    expect((await rows(b.id, 'registration')).map((r) => r.slot)).toEqual([1]);
  });

  it('a new hash in the slot deletes it (a new phone in an old phone’s slot)', async () => {
    const b = await boardWith([[2, H]]);
    expect((await register(b.id, T, FIRST)).status).toBe(204);
    await b.roster([[2, await sha256(randomToken())]]);
    expect(await rows(b.id, 'registration')).toEqual([]);
    expect((await register(b.id, T, FIRST)).status).toBe(401); // the old phone is out
  });

  it('answers 501 push not available when the APNs secrets are missing', async () => {
    const b = await boardWith([[2, H]]);
    const without = { ...(env as unknown as Env), APNS_KEY_P8: undefined };
    const r = await handle(
      new Request(`https://${HOST}/v1/app/${b.id}/push`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${base64url(T)}`, 'CF-Connecting-IP': freshIp() },
        body: JSON.stringify(FIRST),
      }),
      without,
    );
    expect(r.status).toBe(501);
    expect(await r.text()).toBe('push not available');
    expect(await rows(b.id, 'registration')).toEqual([]);
  });
});
