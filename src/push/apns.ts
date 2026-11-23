// Apple's push service (APNs) over its HTTP/2 API, authenticated with a provider token: an ES256
// JWT signed with the APNs key (.p8), reused for 40 minutes (Apple refuses tokens older than an
// hour and new ones more often than every 20 minutes).

import type { ApnsEnv } from './registry';

export type PushType = 'alert' | 'liveactivity';

/** A provider token is replaced after 40 minutes. */
export const TOKEN_REUSE_S = 2400;
/** ... and never sooner than 20 minutes, even when APNs calls it expired. */
export const TOKEN_MIN_S = 1200;
/** A token is used for at most 55 minutes (APNs refuses it after an hour). */
export const TOKEN_VALID_S = 3300;
/** After APNs refuses a new token as too soon, the previous one is used this long before trying again. */
export const FALLBACK_HOLD_S = 300;

const HOSTS: Record<ApnsEnv, string> = {
  sandbox: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com',
};

/** The APNs signing key from the .p8 file's contents (PKCS#8 PEM). */
export async function importApnsKey(p8: string): Promise<CryptoKey> {
  const b64 = p8.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/** The provider token: header `{alg: ES256, kid}`, claims `{iss: team id, iat}`, signature r ‖ s. */
export async function apnsJwt(key: CryptoKey, keyId: string, teamId: string, nowS: number): Promise<string> {
  const head = `${b64urlText(JSON.stringify({ alg: 'ES256', kid: keyId }))}.${b64urlText(JSON.stringify({ iss: teamId, iat: nowS }))}`;
  // WebCrypto's ECDSA signature is already r ‖ s (64 bytes), the form JWS wants.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(head));
  return `${head}.${b64url(new Uint8Array(sig))}`;
}

/**
 * One provider token, renewed after `reuseS`; concurrent callers share one signing. The token it
 * replaced is kept while valid: APNs refuses a key's new tokens more often than every 20 minutes,
 * and another relay holding the same key (test and production) may just have made one.
 */
export class ProviderToken {
  private jwt: Promise<string> | null = null;
  private iat = 0;
  private prev: { jwt: Promise<string>; iat: number } | null = null;
  private holdUntil = 0;

  constructor(
    private readonly key: CryptoKey | Promise<CryptoKey>,
    private readonly keyId: string,
    private readonly teamId: string,
    private readonly reuseS = TOKEN_REUSE_S,
  ) {}

  get(nowS: number): Promise<string> {
    if (!this.jwt || (nowS - this.iat >= this.reuseS && nowS >= this.holdUntil)) {
      this.prev = this.jwt && nowS - this.iat < TOKEN_VALID_S ? { jwt: this.jwt, iat: this.iat } : null;
      this.iat = nowS;
      const jwt = Promise.resolve(this.key).then((k) => apnsJwt(k, this.keyId, this.teamId, nowS));
      // A failed signing is not kept: the next call tries again.
      jwt.catch(() => {
        if (this.jwt === jwt) this.jwt = null;
      });
      this.jwt = jwt;
    }
    return this.jwt;
  }

  /** Starts from a token made earlier (kept by the sender across restarts). */
  seed(jwt: string, iat: number, holdUntil = 0): void {
    this.jwt = Promise.resolve(jwt);
    this.iat = iat;
    this.holdUntil = holdUntil;
  }

  /** Until when the token is kept past its renewal, after a fallback (UTC seconds; 0: no hold). */
  get heldUntil(): number {
    return this.holdUntil;
  }

  /** When the current token was made (UTC seconds; 0: none yet). */
  get issuedAt(): number {
    return this.jwt ? this.iat : 0;
  }

  /** APNs called the token expired: the next `get` makes a new one, unless this one is under 20 minutes old. */
  expire(nowS: number): void {
    if (nowS - this.iat >= TOKEN_MIN_S) {
      this.jwt = null;
      this.prev = null;
      this.holdUntil = 0;
    }
  }

  /**
   * APNs refused the current token as too soon after the last (`TooManyProviderTokenUpdates`):
   * back to the one before while it is valid, for `FALLBACK_HOLD_S`, then a new one is tried again.
   * False when there is none to go back to.
   */
  fallBack(nowS: number): boolean {
    const p = this.prev;
    if (!p || nowS - p.iat >= TOKEN_VALID_S) return false;
    this.jwt = p.jwt;
    this.iat = p.iat;
    this.prev = null;
    this.holdUntil = Math.min(nowS + FALLBACK_HOLD_S, p.iat + TOKEN_VALID_S);
    return true;
  }
}

export interface ApnsRequest {
  env: ApnsEnv;
  /** Lowercase hex. */
  deviceToken: string;
  bundleId: string;
  pushType: PushType;
  priority: 5 | 10;
  /** `apns-expiration`, UTC seconds. */
  expiration: number;
  payload: unknown;
  jwt: string;
}

/** The HTTP request for one push. The topic is the bundle id, with `.push-type.liveactivity` for a Live Activity. */
export function apnsRequest(o: ApnsRequest): Request {
  return new Request(`${HOSTS[o.env]}/3/device/${o.deviceToken}`, {
    method: 'POST',
    headers: {
      authorization: `bearer ${o.jwt}`,
      'apns-push-type': o.pushType,
      'apns-priority': String(o.priority),
      'apns-topic': o.pushType === 'liveactivity' ? `${o.bundleId}.push-type.liveactivity` : o.bundleId,
      'apns-expiration': String(o.expiration),
      'content-type': 'application/json',
    },
    body: JSON.stringify(o.payload),
  });
}

function b64url(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlText(s: string): string {
  return b64url(new TextEncoder().encode(s));
}
