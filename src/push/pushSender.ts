// The one object that talks to APNs (named "apns"): every board's room hands it its items over RPC,
// so all of them share one provider token, kept in its storage across restarts and deploys. A relay
// that shares its APNs key with another deployment must share this object too (wrangler.jsonc,
// `script_name`): Apple refuses a key's new tokens more often than every 20 minutes. It answers one
// outcome per item and logs counts per APNs status, never a board id, a token or a payload.

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../index';
import { TOKEN_MIN_S, TOKEN_REUSE_S, apnsJwt, apnsRequest, importApnsKey } from './apns';
import type { ApnsItem, ApnsOutcome } from './types';

/** A 429 or 5xx (or no answer at all) is tried once more after this. */
const RETRY_MS = 2000;

/** What one APNs answer means for the push: `retry` once for 429, 5xx and no answer. */
export function outcomeOf(status: number, reason: string | null): ApnsOutcome | 'retry' {
  if (status === 200) return 'sent';
  if (status === 410) return 'gone';
  if (status === 400 && (reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic')) return 'gone';
  if (status === 0 || status === 429 || status >= 500) return 'retry';
  return 'failed';
}

/** A provider token, the key id it was signed with and when (UTC seconds). */
interface ProviderToken {
  kid: string;
  jwt: string;
  iat: number;
}

export class PushSender extends DurableObject<Env> {
  /** Milliseconds since the epoch; tests replace it. */
  clock: () => number = () => Date.now();
  /** Sends one request to APNs; tests replace it. */
  fetchApns: (r: Request) => Promise<Response> = (r) => fetch(r);
  /** Waits before a retry; tests replace it. */
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));
  /** The token in use (or being read or signed); null until first needed, and in tests after a restart. */
  token: Promise<ProviderToken> | null = null;

  async send(items: ApnsItem[]): Promise<ApnsOutcome[]> {
    const counts: Record<string, number> = {};
    let outcomes: ApnsOutcome[];
    try {
      outcomes = await Promise.all(items.map((item) => this.one(item, counts)));
    } catch (e) {
      // The key would not import or sign: nothing can be sent.
      console.log({ event: 'apns failed', error: e instanceof Error ? e.name : 'unknown' });
      return items.map(() => 'failed');
    }
    console.log({ event: 'apns', answers: counts });
    return outcomes;
  }

  /**
   * The provider token: the stored one while it is this key's and under 50 minutes old, else a new
   * one (signed once, whoever asks meanwhile). `refused`: the token APNs just called expired, which
   * is replaced too unless it is under 20 minutes old.
   */
  private async providerToken(nowS: number, refused?: string): Promise<ProviderToken> {
    for (;;) {
      const current = (this.token ??= this.stored(nowS));
      const t = await current;
      const old = nowS - t.iat >= TOKEN_REUSE_S || (t.jwt === refused && nowS - t.iat >= TOKEN_MIN_S);
      if (!old) return t;
      if (this.token === current) this.token = this.signed(nowS);
    }
  }

  private async stored(nowS: number): Promise<ProviderToken> {
    const t = await this.ctx.storage.get<ProviderToken>('token');
    return t && t.kid === this.env.APNS_KEY_ID ? t : this.signed(nowS);
  }

  private async signed(nowS: number): Promise<ProviderToken> {
    const kid = this.env.APNS_KEY_ID ?? '';
    try {
      const key = await importApnsKey(this.env.APNS_KEY_P8 ?? '');
      const t = { kid, jwt: await apnsJwt(key, kid, this.env.APNS_TEAM_ID ?? '', nowS), iat: nowS };
      await this.ctx.storage.put('token', t);
      return t;
    } catch (e) {
      this.token = null; // not kept: the next send tries again
      throw e;
    }
  }

  private async one(item: ApnsItem, counts: Record<string, number>): Promise<ApnsOutcome> {
    let refused: string | undefined;
    for (let attempt = 0; ; attempt++) {
      const nowS = Math.floor(this.clock() / 1000);
      const { jwt } = await this.providerToken(nowS, refused);
      let status = 0; // no answer
      let reason: string | null = null;
      try {
        const r = await this.fetchApns(apnsRequest(item, this.env.BUNDLE_ID, jwt));
        status = r.status;
        if (status !== 200) reason = await reasonOf(r);
        else await r.body?.cancel();
      } catch {
        // counted as no answer
      }
      const answer = reason ? `${status} ${reason}` : String(status);
      counts[answer] = (counts[answer] ?? 0) + 1;
      // An expired token is replaced and the push goes again at once; anything else waits 2 s.
      const expired = status === 403 && reason === 'ExpiredProviderToken';
      const o = expired ? 'retry' : outcomeOf(status, reason);
      if (o !== 'retry') return o;
      if (attempt > 0) return 'failed';
      if (expired) refused = jwt;
      else await this.sleep(RETRY_MS);
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
