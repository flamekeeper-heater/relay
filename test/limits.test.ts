import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { type Env, handle, limitKey } from '../src/index';
import { SUBPROTOCOL } from '../src/wire';
import { randomId } from './fakes';

/** A limiter that counts calls per key and never forgets (one minute, as far as a test knows). */
class CountingLimiter {
  counts = new Map<string, number>();
  constructor(private max: number) {}
  async limit({ key }: { key: string }): Promise<{ success: boolean }> {
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    return { success: n <= this.max };
  }
}

function testEnv(): Env & { boards: CountingLimiter; apps: CountingLimiter } {
  const boards = new CountingLimiter(20);
  const apps = new CountingLimiter(60);
  return {
    BOARD: env.BOARD,
    PUSH: env.PUSH as Env['PUSH'],
    BOARD_CONNECTS: boards as unknown as RateLimit,
    APP_CONNECTS: apps as unknown as RateLimit,
    PUSH_RATE: env.PUSH_RATE,
    BUNDLE_ID: env.BUNDLE_ID,
    boards,
    apps,
  };
}

function request(path: string, ip: string): Request {
  return new Request(`https://relay.flamekeeper.app${path}`, {
    headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': SUBPROTOCOL, 'CF-Connecting-IP': ip },
  });
}

/** Opens `n` connects and returns their statuses, closing any socket that opened. */
async function connects(n: number, path: () => string, ip: string, e: Env): Promise<number[]> {
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = await handle(request(path(), ip), e);
    if (r.webSocket) {
      r.webSocket.accept();
      r.webSocket.close(1000);
    }
    out.push(r.status);
  }
  return out;
}

describe('per-IP limits', () => {
  it('the 21st board connect from one IP in a minute gets 429', async () => {
    const e = testEnv();
    const statuses = await connects(21, () => `/v1/board/${randomId()}`, '203.0.113.1', e);
    expect(statuses.slice(0, 20)).toEqual(Array(20).fill(101));
    expect(statuses[20]).toBe(429);
  });

  it('push registration calls count with the app connects', async () => {
    const e = testEnv(); // no APNs secrets: each call is answered 501 after it is counted
    const id = randomId();
    const statuses = [];
    for (let i = 0; i < 61; i++) {
      const r = await handle(
        new Request(`https://relay.flamekeeper.app/v1/app/${id}/push`, { method: 'PUT', headers: { 'CF-Connecting-IP': '203.0.113.6' } }),
        e,
      );
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 60)).toEqual(Array(60).fill(501));
    expect(statuses[60]).toBe(429);
    expect(e.boards.counts.size).toBe(0);
  });

  it('counts an IPv6 address by its /64', async () => {
    expect(limitKey('203.0.113.9')).toBe('203.0.113.9');
    expect(limitKey('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(limitKey('2001:0DB8:0001:0002::9')).toBe('2001:db8:1:2::/64');
    expect(limitKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(limitKey('::1')).toBe('0:0:0:0::/64');
    expect(limitKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(limitKey('')).toBe('');

    const e = testEnv();
    const path = () => `/v1/board/${randomId()}`;
    for (let i = 0; i < 20; i++) expect(await connects(1, path, `2001:db8:1:2::${(i + 1).toString(16)}`, e)).toEqual([101]);
    expect(await connects(1, path, '2001:db8:1:2:ffff:ffff:ffff:ffff', e)).toEqual([429]);
    expect(await connects(1, path, '2001:db8:1:3::1', e)).toEqual([101]);
  });

  it('a 404 path is not counted', async () => {
    const e = testEnv();
    expect(await connects(30, () => '/v2/board/x', '203.0.113.4', e)).toEqual(Array(30).fill(404));
    expect(e.boards.counts.size + e.apps.counts.size).toBe(0);
    expect(await connects(1, () => `/v1/board/${randomId()}`, '203.0.113.4', e)).toEqual([101]);
  });

  it("uses the Worker's rate-limit bindings", async () => {
    // 41 connects from one address: however the limiter's minute splits them, one minute holds 21.
    const statuses = [];
    for (let i = 0; i < 41; i++) {
      const r = await exports.default.fetch(request(`/v1/board/${randomId()}`, '203.0.113.5'));
      r.webSocket?.accept();
      r.webSocket?.close(1000);
      statuses.push(r.status);
    }
    expect(statuses).toContain(429);
  });
});
