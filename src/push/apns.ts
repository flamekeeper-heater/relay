// Apple's push service (APNs) over its HTTP/2 API, authenticated with a provider token: an ES256
// JWT signed with the APNs key (.p8). Apple refuses tokens older than an hour and a key's new
// tokens more often than every 20 minutes.

import { base64url, fromBase64 } from '../bytes';
import type { ApnsItem, ApnsEnv } from './types';

/** A provider token is replaced after 50 minutes. */
export const TOKEN_REUSE_S = 3000;
/** ... and never sooner than 20 minutes, even when APNs calls it expired. */
export const TOKEN_MIN_S = 1200;

const HOSTS: Record<ApnsEnv, string> = {
  sandbox: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com',
};

/** The APNs signing key from the .p8 file's contents (PKCS#8 PEM). */
export async function importApnsKey(p8: string): Promise<CryptoKey> {
  const der = fromBase64(p8.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, ''));
  return crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/** The provider token: header `{alg: ES256, kid}`, claims `{iss: team id, iat}`, signature r ‖ s. */
export async function apnsJwt(key: CryptoKey, keyId: string, teamId: string, nowS: number): Promise<string> {
  const text = (o: object) => base64url(new TextEncoder().encode(JSON.stringify(o)));
  const head = `${text({ alg: 'ES256', kid: keyId })}.${text({ iss: teamId, iat: nowS })}`;
  // WebCrypto's ECDSA signature is already r ‖ s (64 bytes), the form JWS wants.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(head));
  return `${head}.${base64url(new Uint8Array(sig))}`;
}

/** The HTTP request for one push. The topic is the bundle id, with `.push-type.liveactivity` for a Live Activity. */
export function apnsRequest(item: ApnsItem, bundleId: string, jwt: string): Request {
  return new Request(`${HOSTS[item.env]}/3/device/${item.token}`, {
    method: 'POST',
    headers: {
      authorization: `bearer ${jwt}`,
      'apns-push-type': item.pushType,
      'apns-priority': String(item.priority),
      'apns-topic': item.pushType === 'liveactivity' ? `${bundleId}.push-type.liveactivity` : bundleId,
      'apns-expiration': String(item.expiration),
      ...(item.collapseId ? { 'apns-collapse-id': item.collapseId } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify(item.payload),
  });
}
