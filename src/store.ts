// What a board's room keeps in its SQLite storage: the roster (slot → SHA-256 of that phone's relay
// token), one push registration per roster slot, a few numbers (when the board was last seen, the
// live cards' run) and the board's last live record. The tables are made on first use, so a room emptied by `wipe` (a board
// forgotten, or an id no board ever signed in to) holds nothing until it is used again. (A room
// stored by a relay from before the first release may also hold its old `push` and `meta` tables:
// they are not read, and go with the room.)

import type { RegistrationBody } from './push/registry';
import type { ApnsEnv, Registration, TokenKind } from './push/types';

/** The numbers a room keeps, all UTC seconds but `live_run` (the board's run id) and `lost_stage`. */
export type MetaKey =
  /** When the board was last connected; unset until a board first signs in. */
  | 'last_seen'
  /** The run the board's last LIVE was of; unset between runs. */
  | 'live_run'
  /** When the last run ended, and until when its final card stays. */
  | 'live_ended'
  | 'live_end_until'
  /** Lost contact in this absence: 1 the update went out, 2 the cards were ended. */
  | 'lost_stage';


const TOKEN_COLUMN: Record<TokenKind, string> = { device: 'device', start: 'start_token', activity: 'activity_token' };

export class Store {
  private made = false;

  constructor(private readonly storage: DurableObjectStorage) {}

  private get sql(): SqlStorage {
    if (!this.made) {
      this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS roster (slot INTEGER PRIMARY KEY, hash BLOB NOT NULL)`);
      this.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS registration (slot INTEGER PRIMARY KEY, env TEXT NOT NULL, device TEXT,
           offline_after INTEGER NOT NULL DEFAULT 0, offline_sent INTEGER NOT NULL DEFAULT 0,
           start_token TEXT, activity_token TEXT, activity_started INTEGER, ios TEXT,
           no_start_run INTEGER, start_env TEXT, activity_env TEXT)`,
      );
      // Columns added after the table first went live (2026-11-24); a room made before gets them here.
      for (const column of ['start_env TEXT', 'activity_env TEXT']) {
        try {
          this.storage.sql.exec(`ALTER TABLE registration ADD COLUMN ${column}`);
        } catch {
          // already there
        }
      }
      this.made = true;
    }
    return this.storage.sql;
  }

  /** Deletes everything the room stores, its alarm included. */
  async wipe(): Promise<void> {
    await this.storage.deleteAlarm();
    await this.storage.deleteAll();
    this.made = false;
  }

  meta(key: MetaKey): number | null {
    return this.storage.kv.get<number>(key) ?? null;
  }

  setMeta(key: MetaKey, value: number | null): void {
    if (value === null) this.storage.kv.delete(key);
    else this.storage.kv.put(key, value);
  }

  roster(): Map<number, Uint8Array> {
    const rows = this.sql.exec<{ slot: number; hash: ArrayBuffer }>(`SELECT slot, hash FROM roster`);
    return new Map(rows.toArray().map((r) => [r.slot, new Uint8Array(r.hash)]));
  }

  /** The roster slot whose hash this is, or null. */
  slotOf(hash: Uint8Array): number | null {
    for (const [slot, h] of this.roster()) if (sameHash(h, hash)) return slot;
    return null;
  }

  /**
   * Replaces the roster and drops the registrations of slots that left it or changed their hash (a
   * new phone in an old phone's slot). Answers those slots, and the ones that are new.
   */
  setRoster(roster: Map<number, Uint8Array>): Set<number> {
    const before = this.roster();
    const changed = new Set([...before.keys(), ...roster.keys()].filter((s) => !sameHash(before.get(s), roster.get(s))));
    this.storage.transactionSync(() => {
      this.sql.exec(`DELETE FROM roster`);
      for (const [slot, hash] of roster) this.sql.exec(`INSERT INTO roster (slot, hash) VALUES (?, ?)`, slot, hash);
      for (const slot of changed) this.sql.exec(`DELETE FROM registration WHERE slot = ?`, slot);
    });
    return changed;
  }

  registrations(): Registration[] {
    return this.sql.exec<Registration>(`SELECT * FROM registration ORDER BY slot`).toArray();
  }

  registration(slot: number): Registration | null {
    return this.sql.exec<Registration>(`SELECT * FROM registration WHERE slot = ?`, slot).toArray()[0] ?? null;
  }

  /**
   * Replaces what the phone registered; what the relay remembers of the slot stays (its run, and the
   * environment of a token sent again). A new card token is tried first where the last start went.
   */
  putRegistration(slot: number, r: RegistrationBody): void {
    this.sql.exec(
      `INSERT INTO registration (slot, env, device, offline_after, start_token, activity_token, activity_started, ios)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (slot) DO UPDATE SET env = excluded.env, device = excluded.device, offline_after = excluded.offline_after,
         start_token = excluded.start_token, activity_token = excluded.activity_token,
         activity_started = excluded.activity_started, ios = excluded.ios,
         start_env = CASE WHEN registration.start_token IS excluded.start_token THEN registration.start_env END,
         activity_env = CASE WHEN excluded.activity_token IS NULL THEN NULL
           WHEN registration.activity_token IS excluded.activity_token THEN registration.activity_env
           ELSE registration.start_env END`,
      slot,
      r.env,
      r.device,
      r.offlineAfter,
      r.startToken,
      r.activityToken,
      r.activityStartedAt,
      r.iosVersion,
    );
  }

  deleteRegistration(slot: number): void {
    this.sql.exec(`DELETE FROM registration WHERE slot = ?`, slot);
  }

  /** Forgets one token if it is still the registered one; a registration with no token left goes. */
  forgetToken(slot: number, kind: TokenKind, token: string): void {
    const column = TOKEN_COLUMN[kind];
    this.sql.exec(`UPDATE registration SET ${column} = NULL WHERE slot = ? AND ${column} = ?`, slot, token);
    this.sql.exec(`UPDATE registration SET activity_started = NULL, activity_env = NULL WHERE slot = ? AND activity_token IS NULL`, slot);
    this.sql.exec(`UPDATE registration SET start_env = NULL WHERE slot = ? AND start_token IS NULL`, slot);
    this.sql.exec(`DELETE FROM registration WHERE slot = ? AND device IS NULL AND start_token IS NULL AND activity_token IS NULL`, slot);
  }

  /** The environment that took this start or card token, when it is not the registration's. */
  setTokenEnv(slot: number, kind: 'start' | 'activity', token: string, env: ApnsEnv): void {
    const [column, envColumn] = kind === 'start' ? ['start_token', 'start_env'] : ['activity_token', 'activity_env'];
    this.sql.exec(`UPDATE registration SET ${envColumn} = ? WHERE slot = ? AND ${column} = ?`, env, slot, token);
  }

  /** No (further) push-to-start for this slot in `run`. */
  setNoStart(slot: number, run: number): void {
    this.sql.exec(`UPDATE registration SET no_start_run = ? WHERE slot = ?`, run, slot);
  }

  /** Slots that still have a card may be started again in this run (their cards are being ended). */
  allowStartOfCards(): void {
    this.sql.exec(`UPDATE registration SET no_start_run = NULL WHERE activity_token IS NOT NULL`);
  }

  /** The board's last live record, for lost contact and a late end. */
  record(): Uint8Array | null {
    return this.storage.kv.get<Uint8Array>('live_record') ?? null;
  }

  setRecord(record: Uint8Array): void {
    this.storage.kv.put('live_record', record);
  }

  setOfflineSent(slots: number[], sent: boolean): void {
    for (const slot of slots) this.sql.exec(`UPDATE registration SET offline_sent = ? WHERE slot = ?`, sent ? 1 : 0, slot);
  }
}

function sameHash(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  return a !== undefined && b !== undefined && a.length === b.length && crypto.subtle.timingSafeEqual(a, b);
}
