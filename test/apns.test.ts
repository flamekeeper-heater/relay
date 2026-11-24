import { describe, expect, it } from 'vitest';
import { apnsJwt, importApnsKey } from '../src/push/apns';
import { testKey } from './fakes';

const NOW = 1_900_000_000;

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
  });
});
