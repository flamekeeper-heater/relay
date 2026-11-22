import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { SUBPROTOCOL } from '../src/wire';

const ID = 'ngf6uy64isruizr76fbjv2qqqq';
const upgrade = { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': SUBPROTOCOL };

function get(path: string, headers: Record<string, string> = upgrade, origin = 'https://relay.flamekeeper.app'): Promise<Response> {
  return exports.default.fetch(`${origin}${path}`, { headers });
}

describe('routing', () => {
  it('answers 404 for anything but /v1/board/<id> and /v1/app/<id>', async () => {
    for (const path of [
      '/',
      '/v1/board/NGF6UY64ISRUIZR76FBJV2QQQQ',
      '/v1/board/ngf6uy64isruizr76fbjv2qqqr',
      '/v1/board/short',
      `/v2/board/${ID}`,
      `/v1/phone/${ID}`,
      `/v1/board/${ID}/x`,
      `/v1/app/${ID}/`,
    ]) {
      const r = await get(path);
      expect(r.status, path).toBe(404);
    }
  });

  it('answers 426 without an Upgrade: websocket', async () => {
    expect((await get(`/v1/board/${ID}`, { 'Sec-WebSocket-Protocol': SUBPROTOCOL })).status).toBe(426);
    expect((await get(`/v1/app/${ID}`, {})).status).toBe(426);
  });

  it('answers 400 without the subprotocol', async () => {
    expect((await get(`/v1/board/${ID}`, { Upgrade: 'websocket' })).status).toBe(400);
    expect((await get(`/v1/app/${ID}`, { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'other' })).status).toBe(400);
  });

  it('upgrades a proper request and names the subprotocol', async () => {
    for (const role of ['board', 'app']) {
      const r = await get(`/v1/${role}/${ID}`, { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `x, ${SUBPROTOCOL}` });
      expect(r.status).toBe(101);
      expect(r.headers.get('Sec-WebSocket-Protocol')).toBe(SUBPROTOCOL);
      expect(r.webSocket).toBeTruthy();
      r.webSocket!.accept();
      r.webSocket!.close(1000);
    }
  });

  it('refuses a plain ws:// connect except on localhost', async () => {
    expect((await get(`/v1/board/${ID}`, upgrade, 'http://relay.flamekeeper.app')).status).toBe(403);
    expect((await get(`/v1/app/${ID}`, upgrade, 'http://relay.example.com:8080')).status).toBe(403);
    for (const origin of ['http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787']) {
      const r = await get(`/v1/app/${ID}`, upgrade, origin);
      expect(r.status, origin).toBe(101);
      r.webSocket!.accept();
      r.webSocket!.close(1000);
    }
  });
});
