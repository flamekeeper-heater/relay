import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env as RelayEnv } from '../src/index';
import { TOKEN_REUSE_S } from '../src/push/apns';
import { PushSender, outcomeOf, resetProviderToken } from '../src/push/pushSender';
import type { ApnsItem } from '../src/push/types';
import { testKey } from './apns.test';
import { hex, sha256, toHex } from './bytes';
import { eventually, fakeBoard, register, rows } from './fakes';

const T = hex('16c1df6a87aaeae336a68c3cb93442b2246922a2edaee096e2439ee205578c0a');
const H = hex('d91429cfba5c46b38cfeb129eb4f263b616323ad4d7c20aeb3430d641258e834');
const NOW = 1_900_000_000_000;

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Sets up the one APNs sender with a real test key, a clock and a fake APNs that answers
 * `answer(n)` to the n-th request (0-based): a status and a reason.
 */
async function fakeApns(answer: (n: number) => [number, string?] = () => [200]) {
  const { pem } = await testKey();
  const seen: Seen[] = [];
  const clock = { ms: NOW };
  const sleeps: number[] = [];
  await runInDurableObject(env.PUSH.getByName('apns'), (o: PushSender) => {
    (o as unknown as { env: RelayEnv }).env = { ...(env as unknown as RelayEnv), APNS_KEY_P8: pem };
    o.clock = () => clock.ms;
    o.sleep = async (ms) => {
      sleeps.push(ms);
    };
    o.fetchApns = async (r) => {
      const n = seen.length;
      const s: Seen = { url: r.url, headers: Object.fromEntries(r.headers), body: null };
      seen.push(s);
      s.body = await r.json();
      const [status, reason] = answer(n);
      return new Response(reason ? JSON.stringify({ reason }) : null, { status, headers: reason ? { 'apns-id': 'x' } : {} });
    };
  });
  return { seen, clock, sleeps };
}

function send(items: ApnsItem[]) {
  return env.PUSH.getByName('apns').send(items);
}

const ITEM: ApnsItem = {
  env: 'sandbox',
  device: 'aa'.repeat(32),
  pushType: 'alert',
  priority: 10,
  expiration: NOW / 1000 + 86400,
  payload: { aps: { alert: { title: 'Flamekeeper', body: 'x' } } },
};

beforeEach(() => resetProviderToken());
afterEach(() => vi.restoreAllMocks());

describe('APNs outcomes', () => {
  it.each([
    [200, null, 'sent'],
    [410, 'Unregistered', 'gone'],
    [400, 'BadDeviceToken', 'gone'],
    [400, 'DeviceTokenNotForTopic', 'gone'],
    [400, 'BadPriority', 'failed'],
    [403, 'InvalidProviderToken', 'failed'],
    [403, 'ExpiredProviderToken', 'failed'],
    [413, 'PayloadTooLarge', 'failed'],
    [429, 'TooManyRequests', 'retry'],
    [500, 'InternalServerError', 'retry'],
    [503, 'ServiceUnavailable', 'retry'],
  ] as const)('%i %s is %s', (status, reason, outcome) => {
    expect(outcomeOf(status, reason)).toBe(outcome);
  });
});

describe('APNs sender', () => {
  it('sends each item to its environment host with its headers and the provider token', async () => {
    const { seen } = await fakeApns();
    const live: ApnsItem = { ...ITEM, env: 'production', device: 'bb'.repeat(32), pushType: 'liveactivity', priority: 5, payload: { aps: { event: 'update' } } };
    expect(await send([ITEM, live])).toEqual(['sent', 'sent']);
    const byUrl = new Map(seen.map((s) => [s.url, s]));
    const a = byUrl.get(`https://api.sandbox.push.apple.com/3/device/${'aa'.repeat(32)}`)!;
    expect(a.headers['apns-topic']).toBe(env.BUNDLE_ID);
    expect(a.headers['apns-push-type']).toBe('alert');
    expect(a.headers['apns-priority']).toBe('10');
    expect(a.headers['apns-expiration']).toBe(String(ITEM.expiration));
    expect(a.headers.authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(a.body).toEqual(ITEM.payload);
    const b = byUrl.get(`https://api.push.apple.com/3/device/${'bb'.repeat(32)}`)!;
    expect(b.headers['apns-topic']).toBe(`${env.BUNDLE_ID}.push-type.liveactivity`);
    expect(b.headers['apns-push-type']).toBe('liveactivity');
    expect(b.headers['apns-priority']).toBe('5');
    expect(b.headers.authorization).toBe(a.headers.authorization);
  });

  it('reuses the provider token for 40 minutes', async () => {
    const { seen, clock } = await fakeApns();
    await send([ITEM]);
    clock.ms = NOW + (TOKEN_REUSE_S - 1) * 1000;
    await send([ITEM]);
    clock.ms = NOW + TOKEN_REUSE_S * 1000;
    await send([ITEM]);
    const tokens = seen.map((s) => s.headers.authorization);
    expect(tokens[1]).toBe(tokens[0]);
    expect(tokens[2]).not.toBe(tokens[0]);
  });

  it('keeps the provider token across a restart of the sender', async () => {
    const { seen } = await fakeApns();
    await send([ITEM]);
    resetProviderToken();
    await send([ITEM]);
    expect(seen[1].headers.authorization).toBe(seen[0].headers.authorization);
  });

  it('an expired token is renewed and the push tried again at once', async () => {
    const { seen, clock, sleeps } = await fakeApns((n) => (n === 1 ? [403, 'ExpiredProviderToken'] : [200]));
    await send([ITEM]);
    clock.ms = NOW + 1300 * 1000;
    expect(await send([ITEM])).toEqual(['sent']);
    expect(seen).toHaveLength(3);
    expect(seen[2].headers.authorization).not.toBe(seen[1].headers.authorization);
    expect(sleeps).toEqual([]);
  });

  it('tries a 503 once more after 2 s, then gives up', async () => {
    const once = await fakeApns((n) => (n === 0 ? [503, 'ServiceUnavailable'] : [200]));
    expect(await send([ITEM])).toEqual(['sent']);
    expect(once.seen).toHaveLength(2);
    expect(once.sleeps).toEqual([2000]);

    const always = await fakeApns(() => [429, 'TooManyRequests']);
    expect(await send([ITEM])).toEqual(['failed']);
    expect(always.seen).toHaveLength(2);
  });

  it('calls a 410 gone and a bad request failed, without retrying', async () => {
    const { seen } = await fakeApns((n) => (n === 0 ? [410, 'Unregistered'] : [400, 'BadPriority']));
    expect(await send([ITEM])).toEqual(['gone']);
    expect(await send([ITEM])).toEqual(['failed']);
    expect(seen).toHaveLength(2);
  });

  it('logs counts per status, never a token or a payload', async () => {
    const log = vi.spyOn(console, 'log');
    await fakeApns((n) => (n === 0 ? [200] : [400, 'BadDeviceToken']));
    await send([ITEM, { ...ITEM, device: 'cc'.repeat(32) }]);
    const lines = log.mock.calls.map((c) => c.join(' ')).filter((l) => l.startsWith('apns'));
    expect(lines.some((l) => l.includes('200×1') && l.includes('400 BadDeviceToken×1'))).toBe(true);
    for (const l of lines) {
      expect(l).not.toContain('aa'.repeat(32));
      expect(l).not.toContain('cc'.repeat(32));
      expect(l).not.toContain('Flamekeeper');
    }
  });

  it('a PUSH whose phone APNs calls gone loses its registration, end to end', async () => {
    await fakeApns(() => [410, 'Unregistered']);
    const b = await fakeBoard();
    await b.signIn();
    b.roster([[2, H]]);
    expect(toHex(await b.next())).toBe('0008000000');
    expect((await register(b.id, T, { env: 'sandbox', device: 'aa'.repeat(32) })).status).toBe(204);
    expect(toHex(await b.next())).toBe('0008040000');
    b.send(new Uint8Array([0, 6, 1, 1, 2, 40, ...new Uint8Array(40).fill(7)]));
    expect(toHex(await b.next())).toBe('0008000000');
    await eventually(async () => (await rows(b.id, 'push')).length === 0);
    expect(await sha256(T)).toEqual(H);
  });
});
