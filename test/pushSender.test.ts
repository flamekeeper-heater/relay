import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env as RelayEnv } from '../src/index';
import { TOKEN_MIN_S, TOKEN_REUSE_S } from '../src/push/apns';
import { type PushSender, outcomeOf } from '../src/push/pushSender';
import type { ApnsItem } from '../src/push/types';
import { hex } from './bytes';
import { eventually, fakeBoard, logged, register, rows, testKey } from './fakes';

const T = hex('16c1df6a87aaeae336a68c3cb93442b2246922a2edaee096e2439ee205578c0a');
const H = hex('d91429cfba5c46b38cfeb129eb4f263b616323ad4d7c20aeb3430d641258e834');
const NOW = 1_900_000_000_000;

const sender = () => (env as unknown as RelayEnv).PUSH.getByName('apns');

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Sets up the one APNs sender afresh with a real test key, a clock and a fake APNs that answers
 * `answer(n)` to the n-th request (0-based): a status and a reason.
 */
async function fakeApns(answer: (n: number) => [number, string?] = () => [200]) {
  const { pem } = await testKey();
  const seen: Seen[] = [];
  const clock = { ms: NOW };
  const sleeps: number[] = [];
  await runInDurableObject(sender(), async (o: PushSender, state) => {
    await state.storage.deleteAll();
    o.token = null;
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
      return new Response(reason ? JSON.stringify({ reason }) : null, { status });
    };
  });
  return { seen, clock, sleeps };
}

/** The sender loses its memory, as after an eviction or a deploy. */
function restart(): Promise<void> {
  return runInDurableObject(sender(), (o: PushSender) => {
    o.token = null;
  });
}

function send(items: ApnsItem[]) {
  return sender().send(items);
}

const ITEM: ApnsItem = {
  env: 'sandbox',
  token: 'aa'.repeat(32),
  pushType: 'alert',
  priority: 10,
  expiration: NOW / 1000 + 86400,
  payload: { aps: { alert: { title: 'Flamekeeper', body: 'x' } } },
};

afterEach(() => vi.restoreAllMocks());

describe('APNs outcomes', () => {
  it('200 is sent, a dead token gone, 429, 5xx and no answer a retry, anything else failed', () => {
    for (const [status, reason, outcome] of [
      [200, null, 'sent'],
      [410, 'Unregistered', 'gone'],
      [400, 'BadDeviceToken', 'gone'],
      [400, 'DeviceTokenNotForTopic', 'gone'],
      [400, 'BadPriority', 'failed'],
      [403, 'InvalidProviderToken', 'failed'],
      [429, 'TooManyRequests', 'retry'],
      [503, 'ServiceUnavailable', 'retry'],
      [0, null, 'retry'],
    ] as const) {
      expect(outcomeOf(status, reason), `${status} ${reason}`).toBe(outcome);
    }
  });
});

describe('APNs sender', () => {
  it('sends each item to its environment host with its headers and the provider token', async () => {
    const { seen } = await fakeApns();
    const live: ApnsItem = { ...ITEM, env: 'production', token: 'bb'.repeat(32), pushType: 'liveactivity', priority: 5, payload: { aps: { event: 'update' } } };
    expect(await send([{ ...ITEM, collapseId: 'x-offline' }, live])).toEqual(['sent', 'sent']);
    const byUrl = new Map(seen.map((s) => [s.url, s]));
    const a = byUrl.get(`https://api.sandbox.push.apple.com/3/device/${'aa'.repeat(32)}`)!;
    expect(a.headers['apns-topic']).toBe(env.BUNDLE_ID);
    expect(a.headers['apns-push-type']).toBe('alert');
    expect(a.headers['apns-priority']).toBe('10');
    expect(a.headers['apns-expiration']).toBe(String(ITEM.expiration));
    expect(a.headers['apns-collapse-id']).toBe('x-offline');
    expect(a.headers.authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(a.body).toEqual(ITEM.payload);
    const b = byUrl.get(`https://api.push.apple.com/3/device/${'bb'.repeat(32)}`)!;
    expect(b.headers['apns-topic']).toBe(`${env.BUNDLE_ID}.push-type.liveactivity`);
    expect(b.headers['apns-push-type']).toBe('liveactivity');
    expect(b.headers['apns-priority']).toBe('5');
    expect(b.headers['apns-collapse-id']).toBeUndefined();
    expect(b.headers.authorization).toBe(a.headers.authorization);
  });

  it('uses one provider token for 50 minutes, across a restart of the sender too', async () => {
    const { seen, clock } = await fakeApns();
    await send([ITEM, ITEM]);
    await restart();
    clock.ms = NOW + (TOKEN_REUSE_S - 1) * 1000;
    await send([ITEM]);
    clock.ms = NOW + TOKEN_REUSE_S * 1000;
    await send([ITEM, ITEM]);
    const tokens = seen.map((s) => s.headers.authorization);
    expect(new Set(tokens.slice(0, 3)).size).toBe(1);
    expect(tokens[3]).not.toBe(tokens[0]);
    expect(tokens[4]).toBe(tokens[3]);
  });

  it('a token APNs calls expired is replaced and the push goes again at once, but never under 20 minutes', async () => {
    const { seen, clock, sleeps } = await fakeApns((n) => (n === 1 || n === 3 || n === 4 ? [403, 'ExpiredProviderToken'] : [200]));
    await send([ITEM]);
    clock.ms = NOW + TOKEN_MIN_S * 1000;
    expect(await send([ITEM])).toEqual(['sent']);
    expect(seen).toHaveLength(3);
    expect(seen[2].headers.authorization).not.toBe(seen[1].headers.authorization);
    clock.ms += (TOKEN_MIN_S - 1) * 1000;
    expect(await send([ITEM])).toEqual(['failed']);
    expect(seen[4].headers.authorization).toBe(seen[2].headers.authorization);
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

  it('logs counts per answer, never a token or a payload', async () => {
    const log = vi.spyOn(console, 'log');
    await fakeApns((n) => (n === 0 ? [200] : [400, 'BadDeviceToken']));
    await send([ITEM, { ...ITEM, token: 'cc'.repeat(32) }]);
    const lines = logged(log);
    expect(lines).toContain(JSON.stringify({ event: 'apns', answers: { '200': 1, '400 BadDeviceToken': 1 } }));
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
    await b.roster([[2, H]]);
    expect((await register(b.id, T, { env: 'sandbox', device: 'aa'.repeat(32) })).status).toBe(204);
    b.send(new Uint8Array([0, 6, 1, 1, 2, 40, ...new Uint8Array(40).fill(7)]));
    await eventually(async () => (await rows(b.id, 'registration')).length === 0);
  });
});
