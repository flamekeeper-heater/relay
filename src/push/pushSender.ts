// The one object that talks to APNs (named "apns"): every board's room hands it its items over RPC,
// so all of them share one provider token per isolate. It answers one outcome per item and logs
// counts per APNs status, never a board id, a token or a payload.

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../index';
import { ProviderToken, apnsRequest, importApnsKey } from './apns';
import type { ApnsItem, ApnsOutcome } from './types';

/** A 429 or 5xx (or no answer at all) is tried once more after this. */
export const RETRY_MS = 2000;

/** What one APNs answer means for the token: `retry` once for 429, 5xx and no answer. */
export function outcomeOf(status: number, reason: string | null): ApnsOutcome | 'retry' {
  if (status === 200) return 'sent';
  if (status === 410) return 'gone';
  if (status === 400 && (reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic')) return 'gone';
  if (status === 429 || status >= 500) return 'retry';
  return 'failed';
}

/**
 * One provider token per isolate, for the key it was made from. It is also kept in the sender's
 * storage, so a sender evicted between pushes (or a new deploy) reuses it instead of signing a new
 * one: Apple refuses token updates more often than every 20 minutes.
 */
let shared: { id: string; token: ProviderToken } | null = null;

interface KeptToken {
  id: string;
  jwt: string;
  iat: number;
}

/** Forgets the isolate's token (tests; the stored one stays). */
export function resetProviderToken(): void {
  shared = null;
}

export class PushSender extends DurableObject<Env> {
  /** Milliseconds since the epoch; tests replace it. */
  clock: () => number = () => Date.now();
  /** Sends one request to APNs; tests replace it. */
  fetchApns: (r: Request) => Promise<Response> = (r) => fetch(r);
  /** Waits before a retry; tests replace it. */
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));

  async send(items: ApnsItem[]): Promise<ApnsOutcome[]> {
    if (items.length === 0) return [];
    const token = await this.providerToken();
    const counts = new Map<string, number>();
    const count = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);
    let outcomes: ApnsOutcome[];
    try {
      outcomes = await Promise.all(items.map((item) => this.one(item, token, count)));
    } catch {
      // The key would not import or sign: nothing can be sent.
      console.log('apns key unusable');
      return items.map(() => 'failed');
    }
    console.log(`apns ${[...counts].map(([k, n]) => `${k}×${n}`).join(', ')}`);
    await this.keep(token);
    return outcomes;
  }

  /** Which key a token was made with: a hash of the key id, team id and key, never the key itself. */
  private async keyId(): Promise<string> {
    const e = this.env;
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${e.APNS_KEY_ID}\n${e.APNS_TEAM_ID}\n${e.APNS_KEY_P8}`));
    return Array.from(new Uint8Array(d).subarray(0, 12), (x) => x.toString(16).padStart(2, '0')).join('');
  }

  private async providerToken(): Promise<ProviderToken> {
    const id = await this.keyId();
    if (shared?.id === id) return shared.token;
    const token = new ProviderToken(importApnsKey(this.env.APNS_KEY_P8 ?? ''), this.env.APNS_KEY_ID ?? '', this.env.APNS_TEAM_ID ?? '');
    const kept = await this.ctx.storage.get<KeptToken>('token');
    if (kept?.id === id) token.seed(kept.jwt, kept.iat);
    shared = { id, token };
    return token;
  }

  /** Stores the token when it is a new one. */
  private async keep(token: ProviderToken): Promise<void> {
    const iat = token.issuedAt;
    if (iat === 0 || !shared) return;
    const kept = await this.ctx.storage.get<KeptToken>('token');
    if (kept?.iat === iat && kept.id === shared.id) return;
    await this.ctx.storage.put('token', { id: shared.id, jwt: await token.get(iat), iat } satisfies KeptToken);
  }

  private async one(item: ApnsItem, token: ProviderToken, count: (k: string) => void): Promise<ApnsOutcome> {
    for (let attempt = 0; ; attempt++) {
      const nowS = Math.floor(this.clock() / 1000);
      const jwt = await token.get(nowS);
      let status = 0;
      let reason: string | null = null;
      try {
        const r = await this.fetchApns(
          apnsRequest({
            env: item.env,
            deviceToken: item.device,
            bundleId: this.env.BUNDLE_ID,
            pushType: item.pushType,
            priority: item.priority,
            expiration: item.expiration,
            payload: item.payload,
            jwt,
          }),
        );
        status = r.status;
        if (status !== 200) reason = await reasonOf(r);
        else await r.body?.cancel();
      } catch {
        status = 0; // no answer
      }
      count(reason ? `${status} ${reason}` : String(status));
      // An expired token is renewed (unless under 20 minutes old) and the push tried once more.
      const expired = status === 403 && reason === 'ExpiredProviderToken';
      if (expired) token.expire(nowS);
      const o = status === 0 || expired ? 'retry' : outcomeOf(status, reason);
      if (o !== 'retry') return o;
      if (attempt > 0) return 'failed';
      if (!expired) await this.sleep(RETRY_MS);
    }
  }
}

/** APNs' `reason` from an error answer's JSON body; only Apple's word characters are kept for the log. */
async function reasonOf(r: Response): Promise<string | null> {
  try {
    const j = (await r.json()) as { reason?: unknown };
    return typeof j.reason === 'string' && /^[A-Za-z]{1,40}$/.test(j.reason) ? j.reason : null;
  } catch {
    return null;
  }
}
