import { describe, expect, it } from 'vitest';
import { ProviderToken, TOKEN_MIN_S, TOKEN_REUSE_S, apnsJwt, apnsRequest, importApnsKey } from '../src/push/apns';

const NOW = 1_900_000_000;

/** A fresh P-256 key, its private half as a .p8 file's contents (PKCS#8 PEM). */
export async function testKey(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
  const b64 = btoa(String.fromCharCode(...der));
  const lines = b64.match(/.{1,64}/g)!.join('\n');
  return { pem: `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`, publicKey: pair.publicKey };
}

function part(jwt: string, i: number): Uint8Array {
  const s = jwt.split('.')[i].replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

function json(jwt: string, i: number): unknown {
  return JSON.parse(new TextDecoder().decode(part(jwt, i)));
}

describe('provider token', () => {
  it('is an ES256 JWT with the key id, the team id and the time, signed by the key', async () => {
    const { pem, publicKey } = await testKey();
    const jwt = await apnsJwt(await importApnsKey(pem), 'KEYID12345', 'TEAMID1234', NOW);
    const parts = jwt.split('.');
    expect(parts).toHaveLength(3);
    expect(json(jwt, 0)).toEqual({ alg: 'ES256', kid: 'KEYID12345' });
    expect(json(jwt, 1)).toEqual({ iss: 'TEAMID1234', iat: NOW });
    const sig = part(jwt, 2);
    expect(sig.length).toBe(64);
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, sig, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    expect(ok).toBe(true);
    expect(jwt).not.toMatch(/[=+/]/);
  });

  it('reads a key without line breaks too', async () => {
    const { pem } = await testKey();
    await expect(importApnsKey(pem.replace(/\n/g, ''))).resolves.toBeDefined();
    await expect(importApnsKey('test-key')).rejects.toBeDefined();
  });

  it('is the same token until 40 minutes, then a new one', async () => {
    const t = new ProviderToken(importApnsKey((await testKey()).pem), 'K', 'T');
    const a = await t.get(NOW);
    expect(await t.get(NOW + TOKEN_REUSE_S - 1)).toBe(a);
    const b = await t.get(NOW + TOKEN_REUSE_S);
    expect(b).not.toBe(a);
    expect(json(b, 1)).toEqual({ iss: 'T', iat: NOW + TOKEN_REUSE_S });
  });

  it('is renewed when APNs calls it expired, but never sooner than 20 minutes', async () => {
    const t = new ProviderToken(importApnsKey((await testKey()).pem), 'K', 'T');
    const a = await t.get(NOW);
    t.expire(NOW + TOKEN_MIN_S - 1);
    expect(await t.get(NOW + TOKEN_MIN_S - 1)).toBe(a);
    t.expire(NOW + TOKEN_MIN_S);
    expect(await t.get(NOW + TOKEN_MIN_S)).not.toBe(a);
  });
});

describe('APNs request', () => {
  const base = { deviceToken: 'ab'.repeat(32), bundleId: 'app.example.Heater', priority: 10 as const, expiration: NOW + 60, payload: { aps: {} }, jwt: 'h.c.s' };

  it('goes to the sandbox host for sandbox and the production host for production', () => {
    expect(apnsRequest({ ...base, env: 'sandbox', pushType: 'alert' }).url).toBe(`https://api.sandbox.push.apple.com/3/device/${'ab'.repeat(32)}`);
    expect(apnsRequest({ ...base, env: 'production', pushType: 'alert' }).url).toBe(`https://api.push.apple.com/3/device/${'ab'.repeat(32)}`);
  });

  it('carries the token, push type, priority, expiration and topic', async () => {
    const r = apnsRequest({ ...base, env: 'sandbox', pushType: 'alert', priority: 5 });
    expect(r.method).toBe('POST');
    expect(r.headers.get('authorization')).toBe('bearer h.c.s');
    expect(r.headers.get('apns-push-type')).toBe('alert');
    expect(r.headers.get('apns-priority')).toBe('5');
    expect(r.headers.get('apns-expiration')).toBe(String(NOW + 60));
    expect(r.headers.get('apns-topic')).toBe('app.example.Heater');
    expect(await r.json()).toEqual({ aps: {} });
    const live = apnsRequest({ ...base, env: 'sandbox', pushType: 'liveactivity' });
    expect(live.headers.get('apns-push-type')).toBe('liveactivity');
    expect(live.headers.get('apns-topic')).toBe('app.example.Heater.push-type.liveactivity');
  });
});
