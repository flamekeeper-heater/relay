// One Durable Object per board id: the board's socket, its phones' sockets, the board's roster and
// its phones' push registrations.
//
// Sockets use the Hibernation API, so the object may lose its memory between any two messages:
// what routing needs lives in each socket's attachment and in SQLite, and `mem` holds only what is
// safe to lose. Nothing is written to storage before a board's AUTH verifies.

import { DurableObject } from 'cloudflare:workers';
import { verifyBoardAuth } from './auth';
import { type Env, pushAvailable } from './index';
import { apnsForBlob, apnsForPresence } from './push/apnsMessage';
import {
  LIVE_INTERVAL_MS,
  LOST_END_S,
  LOST_UPDATE_S,
  type LiveRow,
  type LiveSend,
  lateEndRequest,
  liveRequests,
  lostContactRequests,
} from './push/live';
import { type ApnsEnv, REGISTRATION_MAX, parseActivityEnd, parseBearer, parseRegistration } from './push/registry';
import type { ApnsItem, ApnsOutcome, ApnsPayload, PushSend } from './push/types';
import {
  CHALLENGE_BYTES,
  Close,
  MAX_MESSAGE,
  Op,
  SUBPROTOCOL,
  TOKEN_BYTES,
  decodeAuth,
  decodeClose,
  decodeLive,
  decodePush,
  decodeRoster,
  encodeChallenge,
  encodeClose,
  encodeOpen,
  encodeWant,
  parsePath,
} from './wire';

export interface BoardSocket {
  role: 'board';
  authed: boolean;
  /** This connection's challenge, hex. */
  challenge: string;
  /** When the socket was accepted (ms, by `clock`). */
  since: number;
  /** The board id and the host as the board dialled them (for AUTH). */
  id: string;
  host: string;
}

export interface AppSocket {
  role: 'app';
  /** The roster slot its token matched; null until it sent one. */
  slot: number | null;
  /** Its channel to the board (1-3); null until admitted, and again once the relay lets it go. */
  channel: number | null;
  since: number;
}

type Attachment = BoardSocket | AppSocket;

/** A registration that can be pushed (see `phones()`). */
type PushRow = {
  slot: number;
  env: ApnsEnv;
  device: string;
  offline_after: number;
};

/**
 * One APNs item, the slot it is for and which of the slot's tokens it uses (to forget that token if
 * APNs calls it gone), and for a live card what to record once it is sent.
 */
type PushSendItem = { slot: number; item: ApnsItem; token?: 'device' | 'start' | 'activity'; after?: LiveSend['after']; run?: number };

/** The slots with a device token, with a live card and with a push-to-start token, a bit each. */
type Masks = { push: number; live: number; start: number };

/** The push table's live card columns, added to rooms stored before live cards. */
const LIVE_COLUMNS: Array<[name: string, type: string]> = [
  ['start_token', 'TEXT'],
  ['activity_token', 'TEXT'],
  ['activity_started', 'INTEGER'],
  ['ios', 'TEXT'],
  ['dismissed_run', 'INTEGER'],
  ['started_run', 'INTEGER'],
  ['lost_run', 'INTEGER'],
  ['live_blob', 'BLOB'],
  ['live_event', 'INTEGER'],
];
const LIVE_SELECT = `slot, env, start_token, activity_token, activity_started, ios, dismissed_run, started_run, lost_run, live_blob, live_event`;

const SIGN_IN_MS = 10_000;
/** The board's frames move its last seen at most this often. */
const SEEN_WRITE_MS = 60_000;
const FORGET_MS = 90 * 24 * 3600 * 1000;
const CHANNELS = [1, 2, 3];
/** Bad tokens in a minute that make a log line (they are only counted: a token is 256 bits). */
const BAD_TOKENS_LOGGED = 10;
const BAD_TOKEN_WINDOW_MS = 60_000;
/**
 * App → board messages per channel: 400 a second on average, bursts of 128. High enough that the
 * board's flow control (16 KB in flight, a report every 4096 bytes) sets a firmware update's pace,
 * not this cap: it only stops a phone that floods.
 */
export const RATE_PER_S = 400;
export const BURST = 128;
/** A phone's longest message, so that the board gets at most MAX_MESSAGE with the channel byte. */
const APP_MESSAGE_MAX = MAX_MESSAGE - 1;
/** PUSH from the board: at most 20 an hour; a class 3 (CO alarm) is neither limited nor counted. */
export const PUSHES_PER_HOUR = 20;
const HOUR_MS = 3600_000;
const MINUTE_MS = 60_000;
const ALARM_CLASS = 3;
/** How long APNs keeps a push for a phone that is off: a phone off overnight still gets it. */
const PUSH_EXPIRY_S = 86_400;

/** What the object keeps in memory: safe to lose at any time, and never written to storage. */
export interface Memory {
  /** Whether this object's tables exist (null: not checked yet). */
  schema: boolean | null;
  /** Whether the push table exists (null: not checked yet); rooms stored before pushes lack it. */
  push: boolean | null;
  /** Bad app tokens in the current minute (for the log only). */
  badTokens: { windowStart: number; count: number };
  /** Channel → phone socket; null until rebuilt from the sockets' attachments. */
  channels: Map<number, WebSocket> | null;
  /** The token bucket of each channel's app → board messages. */
  buckets: Map<number, { tokens: number; at: number }>;
  /** When the board's last frame was written down as last seen (ms; 0: not in this life). */
  seenWritten: number;
}

export function freshMemory(): Memory {
  return {
    schema: null,
    push: null,
    badTokens: { windowStart: 0, count: 0 },
    channels: null,
    buckets: new Map(),
    seenWritten: 0,
  };
}

export class BoardRoom extends DurableObject<Env> {
  /** Milliseconds since the epoch; tests replace it. */
  clock: () => number = () => Date.now();
  mem: Memory = freshMemory();
  /** Hands APNs items to Apple, through the one APNs sender object; tests replace it. */
  pushSender: PushSend = async (items) => {
    if (!pushAvailable(this.env)) {
      log(this.ctx.id.name, 'push not available');
      return items.map((): ApnsOutcome => 'failed');
    }
    return this.env.PUSH.getByName('apns').send(items);
  };

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = parsePath(url.pathname);
    if (!path) return new Response('Not found', { status: 404 });
    if (path.role === 'push') return this.registration(request, path.activity === true);
    const pair = new WebSocketPair();
    const ws = pair[1];
    this.ctx.acceptWebSocket(ws, [path.role]);
    const now = this.clock();
    if (path.role === 'board') {
      const challenge = crypto.getRandomValues(new Uint8Array(CHALLENGE_BYTES));
      attach(ws, { role: 'board', authed: false, challenge: toHex(challenge), since: now, id: path.id, host: url.host });
      send(ws, encodeChallenge(challenge));
    } else {
      attach(ws, { role: 'app', slot: null, channel: null, since: now });
    }
    await this.scheduleAlarm();
    return new Response(null, { status: 101, webSocket: pair[0], headers: { 'Sec-WebSocket-Protocol': SUBPROTOCOL } });
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    if (ws.readyState !== WebSocket.OPEN) return; // already being closed by the relay
    const a = attachment(ws);
    if (typeof message === 'string' || message.byteLength > (a.role === 'app' ? APP_MESSAGE_MAX : MAX_MESSAGE)) {
      if (a.role === 'app') this.release(ws, a, Close.policy, 'policy');
      else closeSocket(ws, Close.policy, 'policy');
      return;
    }
    const m = new Uint8Array(message);
    if (a.role === 'board') await this.boardMessage(ws, a, m);
    else if (a.slot === null) await this.admit(ws, a, m);
    else if (a.channel !== null) this.appFrame(ws, a, a.channel, m);
  }

  async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
    await this.socketGone(ws);
    // Answer the peer's close so its side completes.
    try {
      ws.close(code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000, '');
    } catch {
      // already closed
    }
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    await this.socketGone(ws);
  }

  async alarm(): Promise<void> {
    const now = this.clock();
    for (const ws of this.ctx.getWebSockets()) {
      const a = attachment(ws);
      if (now < a.since + SIGN_IN_MS) continue;
      if (a.role === 'board' && !a.authed) closeSocket(ws, Close.authFailed, 'sign-in failed');
      if (a.role === 'app' && a.slot === null) closeSocket(ws, Close.policy, 'policy');
    }
    const seen = this.lastSeen();
    if (seen !== null && !this.board()) {
      if (now >= seen * 1000 + FORGET_MS) {
        await this.ctx.storage.deleteAll();
        this.mem.schema = false;
        this.mem.push = false;
        log(this.ctx.id.name, 'forgotten');
      } else {
        await this.offlinePushes(now, seen);
        // The board may have signed in while the offline pushes went out.
        if (!this.board()) await this.lostContact(now, seen);
      }
    }
    await this.scheduleAlarm();
  }

  // The board.

  private async boardMessage(ws: WebSocket, a: BoardSocket, m: Uint8Array): Promise<void> {
    if (!a.authed) {
      await this.signIn(ws, a, m);
      return;
    }
    this.boardHeard();
    if (m[0] !== 0) {
      // An app frame for channel m[0]; dropped when no phone holds that channel.
      const app = this.channels().get(m[0]);
      if (app) send(app, m.subarray(1));
      return;
    }
    switch (m[1]) {
      case Op.roster: {
        const roster = decodeRoster(m);
        if (!roster) closeSocket(ws, Close.policy, 'policy');
        else this.setRoster(ws, roster);
        break;
      }
      case Op.close: {
        const c = decodeClose(m);
        if (!c) {
          closeSocket(ws, Close.policy, 'policy');
          break;
        }
        const app = this.channels().get(c.channel);
        if (app) this.letGo(app, attachment(app) as AppSocket, passOn(c.code));
        break;
      }
      case Op.push:
        await this.boardPush(m);
        break;
      case Op.live:
        await this.boardLive(m);
        break;
      default:
      // Anything else is ignored.
    }
  }

  private async signIn(ws: WebSocket, a: BoardSocket, m: Uint8Array): Promise<void> {
    const auth = decodeAuth(m);
    // No other message is handled until the check is done: the board sends ROSTER right behind AUTH.
    const ok = auth !== null && (await this.ctx.blockConcurrencyWhile(() => verifyBoardAuth(auth, fromHex(a.challenge), a.host, a.id)));
    if (!ok) {
      log(a.id, 'board refused', Close.authFailed);
      closeSocket(ws, Close.authFailed, 'sign-in failed');
      return;
    }
    for (const old of this.ctx.getWebSockets('board')) {
      if (old === ws) continue;
      const o = attachment(old) as BoardSocket;
      attach(old, { ...o, authed: false });
      closeSocket(old, Close.replaced, 'replaced');
      if (o.authed) this.boardGone(); // the new board knows nothing of the old one's sessions
    }
    attach(ws, { ...a, authed: true });
    this.setLastSeen();
    this.setMeta('lost_stage', null);
    this.sendWant(ws, this.roster().keys());
    await this.scheduleAlarm();
    log(a.id, 'board in');
    await this.onlinePushes();
  }

  /** The signed-in board socket, if any. */
  private board(): WebSocket | null {
    for (const ws of this.ctx.getWebSockets('board')) {
      if (ws.readyState === WebSocket.OPEN && (attachment(ws) as BoardSocket).authed) return ws;
    }
    return null;
  }

  /**
   * WANT: which of these slots have a device token, a live card and a push-to-start token. Sent
   * after AUTH, after every ROSTER and when registrations change; the board replaces its masks with
   * each one, so a board that reconnects learns of phones registered earlier.
   */
  private sendWant(board: WebSocket, slots: Iterable<number>): void {
    let inRoster = 0;
    for (const s of slots) inRoster |= 1 << s;
    const r = this.registrations();
    send(board, encodeWant(r.push & inRoster, r.live & inRoster, r.start & inRoster));
  }

  /** Slots with a device token, with a live card and with a push-to-start token, a bit each. */
  private registrations(): Masks {
    const m: Masks = { push: 0, live: 0, start: 0 };
    if (this.hasPushTable()) {
      for (const r of this.ctx.storage.sql.exec<{ slot: number; d: number; a: number; s: number }>(
        `SELECT slot, device IS NOT NULL AS d, activity_token IS NOT NULL AS a, start_token IS NOT NULL AS s FROM push`,
      )) {
        if (r.d) m.push |= 1 << r.slot;
        if (r.a) m.live |= 1 << r.slot;
        if (r.s) m.start |= 1 << r.slot;
      }
    }
    return m;
  }

  /** WANT to the signed-in board if the masks differ from `before`. */
  private wantIfChanged(before: Masks): void {
    const now = this.registrations();
    if (now.push === before.push && now.live === before.live && now.start === before.start) return;
    const board = this.board();
    if (board) this.sendWant(board, this.roster().keys());
  }

  /**
   * Stores a new roster and drops the push registrations of slots that left it or changed their
   * hash (a new phone in an old phone's slot), lets go of those slots' phones, then WANT.
   */
  private setRoster(board: WebSocket, roster: Map<number, Uint8Array>): void {
    const before = this.roster();
    this.ensureSchema();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`DELETE FROM roster`);
      for (const [slot, hash] of roster) this.ctx.storage.sql.exec(`INSERT INTO roster (slot, hash) VALUES (?, ?)`, slot, hash);
      for (const { slot } of this.ctx.storage.sql.exec<{ slot: number }>(`SELECT slot FROM push`).toArray()) {
        const now = roster.get(slot);
        if (!now || !equal(now, before.get(slot))) this.ctx.storage.sql.exec(`DELETE FROM push WHERE slot = ?`, slot);
      }
    });
    for (const ws of this.ctx.getWebSockets('app')) {
      const a = attachment(ws) as AppSocket;
      if (a.slot === null) continue;
      const now = roster.get(a.slot);
      if (!now || !equal(now, before.get(a.slot))) this.release(ws, a, Close.notPaired);
    }
    this.sendWant(board, roster.keys());
  }

  // Push registrations.

  /**
   * A phone's `PUT` (merge these fields into its slot's row) or `DELETE` of its push registration,
   * or its `DELETE …/push/activity` (its card ended or was swiped away), authenticated by its relay
   * token: the slot is the one whose roster hash the token matches, so only a phone the board
   * paired can register, and only for itself. Nothing is written for a token the roster does not
   * hold (nor for a room no board signed in to).
   */
  private async registration(request: Request, activity: boolean): Promise<Response> {
    const id = this.ctx.id.name;
    const method = request.method;
    if (activity ? method !== 'DELETE' : method !== 'PUT' && method !== 'DELETE') {
      return reply(405, 'Method not allowed', { Allow: activity ? 'DELETE' : 'PUT, DELETE' });
    }
    const token = parseBearer(request.headers.get('Authorization'));
    const body = await readCapped(request, REGISTRATION_MAX);
    if (!body) return reply(413, 'Too large');
    if (!token) return reply(401, 'Unauthorized');
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', token));

    // From here on nothing awaits until the writes are done, so the roster cannot change between
    // the check and the write.
    const slot = this.slotOf(hash);
    if (slot === null) {
      this.badToken();
      log(id, 'push registration refused', 401);
      return reply(401, 'Unauthorized');
    }
    const text = decodeUtf8(body) ?? '';
    this.ensureSchema();
    const before = this.registrations();
    const sql = this.ctx.storage.sql;
    let lateEnd: PushSendItem | null = null;
    if (activity) {
      const end = parseActivityEnd(text);
      if (!end) return reply(400, 'Bad registration');
      // Only the card that ended (when the phone names it): a newer one may be registered already.
      const current = sql.exec<{ t: string | null }>(`SELECT activity_token AS t FROM push WHERE slot = ?`, slot).toArray()[0]?.t ?? null;
      if (current !== null && (end.token === null || end.token === current)) {
        // A card swiped away gets no push-to-start again in this run.
        sql.exec(
          `UPDATE push SET activity_token = NULL, activity_started = NULL, dismissed_run = CASE WHEN ? THEN ? ELSE dismissed_run END WHERE slot = ?`,
          end.reason === 'dismissed' ? 1 : 0,
          end.reason === 'dismissed' ? this.meta('live_run') : null,
          slot,
        );
      }
      log(id, `push slot ${slot} card ${end.reason}`);
    } else if (method === 'DELETE') {
      sql.exec(`DELETE FROM push WHERE slot = ?`, slot);
      log(id, `push slot ${slot} removed`);
    } else {
      const patch = parseRegistration(text);
      if (!patch) return reply(400, 'Bad registration');
      const row = sql
        .exec<{ kind: string; env: string; device: string | null; offline_after: number; start_token: string | null; activity_token: string | null; activity_started: number | null; ios: string | null; dismissed_run: number | null; lost_run: number | null }>(
          `SELECT kind, env, device, offline_after, start_token, activity_token, activity_started, ios, dismissed_run, lost_run FROM push WHERE slot = ?`,
          slot,
        )
        .toArray()[0];
      const anyToken = [patch.device, patch.startToken, patch.activityToken].some((t) => typeof t === 'string');
      if (!row && (patch.env === undefined || !anyToken)) return reply(400, 'Bad registration');
      // Tokens belong to one APNs environment: a phone that changes it (a Debug build over a
      // TestFlight one) keeps only the tokens it sends again.
      const envChanged = row !== undefined && patch.env !== undefined && patch.env !== row.env;
      const kept = envChanged ? undefined : row;
      const pick = <T>(v: T | undefined, old: T): T => (v !== undefined ? v : old);
      const activityToken = pick(patch.activityToken, kept?.activity_token ?? null);
      // A card dropped this way is lost: the phone may be push-started even if it started the run.
      const cardLost = envChanged && row.activity_token !== null && activityToken === null;
      sql.exec(
        `INSERT INTO push (slot, kind, env, device, offline_after, updated, start_token, activity_token, activity_started, ios, dismissed_run, lost_run)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (slot) DO UPDATE SET kind = excluded.kind, env = excluded.env, device = excluded.device,
           offline_after = excluded.offline_after, updated = excluded.updated, start_token = excluded.start_token,
           activity_token = excluded.activity_token, activity_started = excluded.activity_started, ios = excluded.ios,
           dismissed_run = excluded.dismissed_run, lost_run = excluded.lost_run`,
        slot,
        patch.kind ?? row?.kind ?? 'apns',
        patch.env ?? row!.env,
        pick(patch.device, kept?.device ?? null),
        patch.offlineAfter ?? row?.offline_after ?? 0,
        Math.floor(this.clock() / 1000),
        pick(patch.startToken, kept?.start_token ?? null),
        activityToken,
        // A card's start belongs to its token: a new token without one has none.
        activityToken === null
          ? null
          : pick(patch.activityStartedAt, activityToken === kept?.activity_token ? (kept?.activity_started ?? null) : null),
        patch.iosVersion ?? row?.ios ?? null,
        // A new card is the phone wanting one again.
        typeof patch.activityToken === 'string' ? null : (row?.dismissed_run ?? null),
        cardLost ? this.meta('live_run') : (row?.lost_run ?? null),
      );
      log(id, `push slot ${slot} set`);
      if (typeof patch.activityToken === 'string') lateEnd = this.lateEnd(slot);
    }
    this.wantIfChanged(before);
    if (lateEnd) await this.deliver('late end', [lateEnd]);
    // While the board is away, a new or shorter offline delay, or a device token back, moves the
    // offline deadline (a deadline already past fires at once, with t = last seen).
    if (!this.board()) await this.scheduleAlarm();
    return new Response(null, { status: 204 });
  }

  // Pushes.

  /**
   * A PUSH from the signed-in board: one APNs item per blob whose slot has a registration with a
   * device token in the current roster. A malformed one is logged and ignored (the board stays).
   * Log lines carry counts only, never the class.
   */
  private async boardPush(m: Uint8Array): Promise<void> {
    const id = this.boardId();
    if (!id) {
      log(undefined, 'push skipped: no board id');
      return;
    }
    const p = decodePush(m);
    if (!p) {
      log(id, 'push malformed');
      return;
    }
    if (p.cls !== ALARM_CLASS && !this.pushAllowed()) {
      log(id, 'push over the limit');
      return;
    }
    const phones = new Map(this.phones().map((r) => [r.slot, r]));
    const critical = this.env.CRITICAL_ALERTS === '1';
    const sends: PushSendItem[] = [];
    for (const { slot, blob } of p.blobs) {
      const phone = phones.get(slot);
      if (phone) sends.push(this.itemFor(phone, apnsForBlob(p.cls, id, blob, critical)));
    }
    await this.deliver('push', sends);
  }

  /**
   * A LIVE from the signed-in board: per phone it sealed a record for, an update to its card, a
   * push-to-start, or the card's end (`liveRequests`). At most one per 5 s (the board keeps its own 20 s for small changes); an end always passes.
   * Each phone's last blob is kept for the lost-contact update and the 8-hour renewal.
   */
  private async boardLive(m: Uint8Array): Promise<void> {
    const id = this.boardId();
    if (!id) {
      log(undefined, 'live skipped: no board id');
      return;
    }
    const l = decodeLive(m);
    if (!l) {
      log(id, 'live malformed');
      return;
    }
    const now = this.clock();
    const nowS = Math.floor(now / 1000);
    const last = this.meta('live_at');
    // Only updates are limited: a start or an end always passes.
    if (l.event === 1 && last !== null && now >= last && now - last < LIVE_INTERVAL_MS) {
      log(id, 'live over the limit');
      return;
    }
    this.setMeta('live_at', now);
    if (l.event === 0) {
      this.setMeta('live_run', now);
      this.setMeta('live_ended', null);
    }
    const run = this.run();
    if (l.event === 2) {
      // The run is over: the next LIVE starts a new one. A card push-started in this run whose token
      // comes only later is ended then (`lateEnd`).
      this.setMeta('live_run', null);
      this.setMeta('live_ended', nowS);
      this.setMeta('live_end_until', nowS + l.dismissalS);
    }
    if (this.hasPushTable()) {
      for (const [slot, blob] of l.blobs) this.ctx.storage.sql.exec(`UPDATE push SET live_blob = ?, live_event = ? WHERE slot = ?`, blob, l.event, slot);
    }
    const sends = liveRequests(l, this.liveRows(), { relayId: id, nowS, run });
    await this.deliver(
      `live ${LIVE_EVENTS[l.event] ?? l.event} (records for ${l.blobs.size === 0 ? 'no slot' : `slot ${[...l.blobs.keys()].join(' ')}`}${l.starter === null ? '' : `, started by slot ${l.starter}`})`,
      sends.map((x) => ({ ...x, run })),
    );
  }

  /**
   * A card token registered after its run ended (a push-to-start the phone acted on late, or a run
   * that ended within seconds): the end goes to it at once, with the run's last record.
   */
  private lateEnd(slot: number): PushSendItem | null {
    const ended = this.meta('live_ended');
    if (ended === null || this.meta('live_run') !== null) return null;
    const r = this.liveRows().find((x) => x.slot === slot);
    if (!r || r.activity_started === null || r.activity_started >= ended) return null;
    const until = this.meta('live_end_until') ?? ended;
    return lateEndRequest(r, Math.floor(this.clock() / 1000), until);
  }

  /**
   * The board is still away and phones have its live cards: at 10 minutes an update saying since
   * when (`relay.lostAt` = last seen), at 60 minutes the cards' end. Once each per absence.
   */
  private async lostContact(now: number, seen: number): Promise<void> {
    if (this.board()) return;
    const stage = this.meta('lost_stage') ?? 0;
    if (stage >= 2) return;
    const rows = this.liveRows().filter((r) => r.activity_token !== null);
    if (rows.length === 0) return;
    const nowS = Math.floor(now / 1000);
    if (now >= (seen + LOST_END_S) * 1000) {
      this.setMeta('lost_stage', 2);
      // A board back later in the same run may start these phones' cards again.
      this.ctx.storage.sql.exec(`UPDATE push SET started_run = NULL`);
      await this.deliver('lost contact end', lostContactRequests(rows, seen, nowS, true));
    } else if (stage < 1 && now >= (seen + LOST_UPDATE_S) * 1000) {
      this.setMeta('lost_stage', 1);
      await this.deliver('lost contact', lostContactRequests(rows, seen, nowS, false));
    }
  }

  /** The live card fields of the registrations in the roster. */
  private liveRows(): LiveRow[] {
    if (!this.hasPushTable()) return [];
    return this.ctx.storage.sql.exec<LiveRow>(`SELECT ${LIVE_SELECT} FROM push WHERE slot IN (SELECT slot FROM roster)`).toArray();
  }

  /** The current run's id: when the board's last start came (ms); a first LIVE without one starts one. */
  private run(): number {
    let run = this.meta('live_run');
    if (run === null) {
      run = this.clock();
      this.setMeta('live_run', run);
    }
    return run;
  }

  /**
   * The board is still away: the offline push to every phone whose delay has passed since the
   * board was last seen (`t` = last seen), once per absence. Not counted toward the PUSH limit.
   */
  private async offlinePushes(now: number, seen: number): Promise<void> {
    const due = this.offlineRows().filter((r) => now >= seen * 1000 + r.offline_after * MINUTE_MS);
    if (due.length === 0) return;
    // Marked before the send, so a board that signs in meanwhile says "back online" to these
    // phones, and so the alarm never comes back for them in this absence.
    for (const r of due) this.ctx.storage.sql.exec(`UPDATE push SET offline_sent = 1 WHERE slot = ?`, r.slot);
    const id = this.boardId();
    if (!id) {
      log(undefined, 'offline push skipped: no board id');
      return;
    }
    await this.deliver(
      'offline push',
      due.map((r) => this.itemFor(r, apnsForPresence('offline', id, seen))),
    );
  }

  /** After a good AUTH: "back online" to the phones that were told the board was offline. */
  private async onlinePushes(): Promise<void> {
    const told = this.phones('offline_sent = 1');
    if (this.hasPushTable()) this.ctx.storage.sql.exec(`UPDATE push SET offline_sent = 0 WHERE offline_sent = 1`);
    if (told.length === 0) return;
    const id = this.boardId();
    if (!id) {
      log(undefined, 'online push skipped: no board id');
      return;
    }
    const now = Math.floor(this.clock() / 1000);
    await this.deliver(
      'online push',
      told.map((r) => this.itemFor(r, apnsForPresence('online', id, now))),
    );
  }

  /**
   * The rows still waiting for an offline push in this absence: with a delay, not sent yet.
   * (Every due row is marked sent, so the alarm never loops on one.)
   */
  private offlineRows(): PushRow[] {
    return this.phones('offline_after > 0 AND offline_sent = 0');
  }

  /**
   * The registrations that can be pushed: a device token, a slot in the roster, and `where` if
   * given (a fixed condition, never input). The one read behind every APNs item.
   */
  private phones(where?: string): PushRow[] {
    if (!this.hasPushTable()) return [];
    return this.ctx.storage.sql
      .exec<PushRow>(
        `SELECT slot, env, device, offline_after FROM push
         WHERE device IS NOT NULL AND slot IN (SELECT slot FROM roster)${where ? ` AND ${where}` : ''}`,
      )
      .toArray();
  }

  /** The APNs item for one phone: its token and environment, the message, expiring in 24 h. */
  private itemFor(row: PushRow, message: { priority: 5 | 10; payload: ApnsPayload }): PushSendItem {
    return {
      slot: row.slot,
      token: 'device',
      item: {
        env: row.env,
        device: row.device,
        pushType: 'alert',
        priority: message.priority,
        expiration: Math.floor(this.clock() / 1000) + PUSH_EXPIRY_S,
        payload: message.payload,
      },
    };
  }

  /** This room's board id; null for a room not made by board id (the Worker never makes one). */
  private boardId(): string | null {
    return this.ctx.id.name || null;
  }

  /**
   * Counts a PUSH toward the hourly limit; false when the limit is reached (it is then not
   * counted). The window starts at the first counted PUSH and lasts an hour; it is kept in
   * storage (one write per counted PUSH), since the room forgets its memory whenever it
   * hibernates, which an idle room does between any two messages.
   */
  private pushAllowed(): boolean {
    const now = this.clock();
    const sql = this.ctx.storage.sql;
    const kept = new Map(
      sql
        .exec<{ key: string; value: number }>(`SELECT key, value FROM meta WHERE key IN ('push_window', 'push_count')`)
        .toArray()
        .map((r) => [r.key, r.value]),
    );
    let start = kept.get('push_window');
    let count = kept.get('push_count') ?? 0;
    if (start === undefined || now - start >= HOUR_MS) {
      start = now;
      count = 0;
    }
    if (count >= PUSHES_PER_HOUR) return false;
    sql.exec(
      `INSERT INTO meta (key, value) VALUES ('push_window', ?), ('push_count', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      start,
      count + 1,
    );
    return true;
  }

  /**
   * Hands the items to the APNs sender, forgets the tokens APNs calls gone (a row with no token
   * left goes), records what live card items did, then WANT if the masks changed. Logs the counts:
   * never a blob, a token or the class.
   */
  private async deliver(what: string, sends: PushSendItem[]): Promise<ApnsOutcome[]> {
    const id = this.ctx.id.name;
    if (sends.length === 0) {
      log(id, `${what}: no phone`);
      return [];
    }
    let outcomes: ApnsOutcome[];
    try {
      outcomes = await this.pushSender(sends.map((s) => s.item));
    } catch {
      outcomes = sends.map(() => 'failed');
    }
    const before = this.registrations();
    const sql = this.ctx.storage.sql;
    const n = { sent: 0, gone: 0, failed: 0 };
    // What each send was (its Live Activity event, or alert) to which kind of token and host.
    const kinds = new Map<string, number>();
    sends.forEach(({ slot, item, token = 'device', after, run }, i) => {
      const o = outcomes[i] ?? 'failed';
      n[o]++;
      const k = `${pushEvent(item.payload)} to ${TOKEN_NAMES[token]} ${item.env} ${o}`;
      kinds.set(k, (kinds.get(k) ?? 0) + 1);
      // Only the token APNs refused or the card that ended (if APNs took the end): the phone may
      // have registered a new one meanwhile.
      if (o === 'gone' || (after === 'forgetCard' && o === 'sent')) {
        if (token === 'activity') {
          // A card APNs refused is lost (the app reinstalled, or another environment): the phone may
          // be push-started again in this run, even if it started the run.
          sql.exec(
            `UPDATE push SET activity_token = NULL, activity_started = NULL, lost_run = CASE WHEN ? THEN ? ELSE lost_run END WHERE slot = ? AND activity_token = ?`,
            o === 'gone' ? 1 : 0,
            o === 'gone' ? this.meta('live_run') : null,
            slot,
            item.device,
          );
        } else if (token === 'start') {
          if (o === 'gone') sql.exec(`UPDATE push SET start_token = NULL WHERE slot = ? AND start_token = ?`, slot, item.device);
        } else {
          sql.exec(`UPDATE push SET device = NULL WHERE slot = ? AND device = ?`, slot, item.device);
        }
        sql.exec(`DELETE FROM push WHERE slot = ? AND device IS NULL AND start_token IS NULL AND activity_token IS NULL`, slot);
      }
      if (after === 'started' && o === 'sent' && run !== undefined) sql.exec(`UPDATE push SET started_run = ? WHERE slot = ?`, run, slot);
    });
    log(id, `${what}: ${n.sent} sent, ${n.gone} gone, ${n.failed} failed (${[...kinds].map(([k, c]) => `${k}×${c}`).join(', ')})`);
    this.wantIfChanged(before);
    return outcomes;
  }

  /** The roster slot whose hash this is, or null. */
  private slotOf(hash: Uint8Array): number | null {
    let slot: number | null = null;
    for (const [s, h] of this.roster()) if (equal(h, hash)) slot = s;
    return slot;
  }

  // Phones.

  /** A phone's first message is its relay token: token, board online, then a channel. */
  private async admit(ws: WebSocket, a: AppSocket, m: Uint8Array): Promise<void> {
    const id = this.ctx.id.name;
    if (m.length !== TOKEN_BYTES) {
      closeSocket(ws, Close.policy, 'policy');
      return;
    }
    // No other message is handled until the phone is placed: its first frame may follow at once.
    const hash = await this.ctx.blockConcurrencyWhile(async () => new Uint8Array(await crypto.subtle.digest('SHA-256', m)));
    const slot = this.slotOf(hash);
    if (slot === null) {
      this.badToken();
      log(id, 'app refused', Close.notPaired);
      closeSocket(ws, Close.notPaired, '');
      return;
    }
    const board = this.board();
    if (!board) {
      closeSocket(ws, Close.offline, `offline ${this.lastSeen() ?? 0}`);
      return;
    }
    // A phone that reconnects (Wi-Fi to cellular, say) while its old socket is still open takes
    // its channel over; the board ends the old session and starts a fresh one.
    const channels = this.channels();
    let channel: number | undefined;
    for (const [c, other] of channels) {
      const o = attachment(other) as AppSocket;
      if (o.slot === slot) {
        channel = c;
        this.release(other, o, Close.replaced, 'replaced');
      }
    }
    channel ??= CHANNELS.find((c) => !channels.has(c));
    if (channel === undefined) {
      log(id, 'app refused', Close.full);
      closeSocket(ws, Close.full, 'full');
      return;
    }
    attach(ws, { ...a, slot, channel });
    this.mem.channels = null;
    this.mem.buckets.set(channel, { tokens: BURST, at: this.clock() });
    send(board, encodeOpen(channel, slot));
    await this.scheduleAlarm();
  }

  /** A frame from an admitted phone: to the board with the phone's channel byte, within the rate. */
  private appFrame(ws: WebSocket, a: AppSocket, channel: number, m: Uint8Array): void {
    if (!this.withinRate(channel)) {
      this.release(ws, a, Close.policy, 'policy');
      return;
    }
    const out = new Uint8Array(1 + m.length);
    out[0] = channel;
    out.set(m, 1);
    const board = this.board();
    if (board) send(board, out);
  }

  private withinRate(channel: number): boolean {
    const now = this.clock();
    let b = this.mem.buckets.get(channel);
    if (!b) {
      b = { tokens: BURST, at: now };
      this.mem.buckets.set(channel, b);
    }
    b.tokens = Math.min(BURST, b.tokens + (Math.max(0, now - b.at) * RATE_PER_S) / 1000);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** Channel → phone socket, rebuilt from the attachments when memory was lost. */
  private channels(): Map<number, WebSocket> {
    if (!this.mem.channels) {
      this.mem.channels = new Map();
      for (const ws of this.ctx.getWebSockets('app')) {
        const a = attachment(ws) as AppSocket;
        if (a.channel !== null && ws.readyState === WebSocket.OPEN) this.mem.channels.set(a.channel, ws);
      }
    }
    return this.mem.channels;
  }

  private badToken(): void {
    const now = this.clock();
    const b = this.mem.badTokens;
    if (now - b.windowStart >= BAD_TOKEN_WINDOW_MS) {
      b.windowStart = now;
      b.count = 0;
    }
    b.count++;
    if (b.count === BAD_TOKENS_LOGGED) log(this.ctx.id.name, `${b.count} bad tokens in a minute`);
  }

  /** Closes a phone the relay lets go of, and tells the board its channel ended. */
  private release(ws: WebSocket, a: AppSocket, code: number, reason = ''): void {
    const board = this.board();
    if (a.channel !== null && board) send(board, encodeClose(a.channel, code));
    this.letGo(ws, a, code, reason);
  }

  /** Frees a phone's channel and closes it, without telling the board. */
  private letGo(ws: WebSocket, a: AppSocket, code: number, reason = ''): void {
    if (a.channel !== null) {
      attach(ws, { ...a, channel: null });
      this.mem.channels = null;
      this.mem.buckets.delete(a.channel);
    }
    closeSocket(ws, code, reason);
  }

  /** The board left: its phones learn when it was last seen. */
  private boardGone(): void {
    this.setLastSeen();
    const reason = `offline ${this.lastSeen() ?? 0}`;
    for (const app of this.channels().values()) this.letGo(app, attachment(app) as AppSocket, Close.offline, reason);
  }

  private async socketGone(ws: WebSocket): Promise<void> {
    const a = attachment(ws);
    if (a.role === 'board' && a.authed) {
      attach(ws, { ...a, authed: false });
      this.boardGone();
      log(a.id, 'board gone');
    } else if (a.role === 'app' && a.channel !== null) {
      this.release(ws, a, 1000);
    }
    await this.scheduleAlarm();
  }

  // Storage.

  private hasSchema(): boolean {
    this.mem.schema ??=
      this.ctx.storage.sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'`).toArray().length > 0;
    return this.mem.schema;
  }

  /** Whether the database holds any table at all, the runtime's own (alarm metadata) included. */
  private storesAnything(): boolean {
    return this.ctx.storage.sql.exec(`SELECT 1 FROM sqlite_master LIMIT 1`).toArray().length > 0;
  }

  /** Whether the push table exists; one stored before live cards gets their columns here. */
  private hasPushTable(): boolean {
    if (this.mem.push === null) {
      const exists = this.ctx.storage.sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'push'`).toArray().length > 0;
      if (exists) {
        const have = new Set(this.ctx.storage.sql.exec<{ name: string }>(`SELECT name FROM pragma_table_info('push')`).toArray().map((r) => r.name));
        for (const [name, type] of LIVE_COLUMNS) if (!have.has(name)) this.ctx.storage.sql.exec(`ALTER TABLE push ADD COLUMN ${name} ${type}`);
      }
      this.mem.push = exists;
    }
    return this.mem.push;
  }

  /**
   * Creates the tables; only after a board's AUTH verifies (or for a phone its stored roster
   * knows). The push table is also made in a room stored before pushes existed.
   */
  private ensureSchema(): void {
    if (!this.hasSchema()) {
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER)`);
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS roster (slot INTEGER PRIMARY KEY, hash BLOB NOT NULL)`);
      this.mem.schema = true;
    }
    if (!this.hasPushTable()) {
      // Per roster slot: the phone's APNs device token and environment, its "heater offline"
      // delay (minutes, 0 off), whether that push went out for the current absence, when the
      // phone last changed the row (UTC seconds), and its live card fields (`LiveRow`).
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS push (slot INTEGER PRIMARY KEY, kind TEXT NOT NULL, env TEXT NOT NULL, device TEXT,
           offline_after INTEGER NOT NULL DEFAULT 0, offline_sent INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL,
           ${LIVE_COLUMNS.map(([n, t]) => `${n} ${t}`).join(', ')})`,
      );
      this.mem.push = true;
    }
  }

  private meta(key: string): number | null {
    if (!this.hasSchema()) return null;
    const row = this.ctx.storage.sql.exec<{ value: number }>(`SELECT value FROM meta WHERE key = ?`, key).toArray()[0];
    return row ? row.value : null;
  }

  /** Sets (or with null deletes) a meta value; only in a room whose tables exist. */
  private setMeta(key: string, value: number | null): void {
    if (!this.hasSchema()) return;
    if (value === null) this.ctx.storage.sql.exec(`DELETE FROM meta WHERE key = ?`, key);
    else this.ctx.storage.sql.exec(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, key, value);
  }

  /**
   * A frame from the signed-in board: it is last seen now, written at most once a minute. A socket
   * that dies without a close still leaves a last seen close to its last frame.
   */
  private boardHeard(): void {
    const now = this.clock();
    if (now >= this.mem.seenWritten && now - this.mem.seenWritten < SEEN_WRITE_MS) return;
    this.setLastSeen();
    this.mem.seenWritten = now;
  }

  private setLastSeen(): void {
    this.ensureSchema();
    this.ctx.storage.sql.exec(
      `INSERT INTO meta (key, value) VALUES ('last_seen', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      Math.floor(this.clock() / 1000),
    );
  }

  /** UTC seconds the board was last connected, or null if no board ever signed in here. */
  private lastSeen(): number | null {
    if (!this.hasSchema()) return null;
    const row = this.ctx.storage.sql.exec<{ value: number }>(`SELECT value FROM meta WHERE key = 'last_seen'`).toArray()[0];
    return row ? row.value : null;
  }

  /** The stored roster: slot → SHA-256(T). Empty when no board ever signed in here. */
  private roster(): Map<number, Uint8Array> {
    const roster = new Map<number, Uint8Array>();
    if (!this.hasSchema()) return roster;
    for (const r of this.ctx.storage.sql.exec<{ slot: number; hash: ArrayBuffer }>(`SELECT slot, hash FROM roster`)) {
      roster.set(r.slot, new Uint8Array(r.hash));
    }
    return roster;
  }

  /**
   * Sets the alarm to the earliest pending deadline: a sign-in or token timeout, and while no board
   * is signed in, a phone's offline delay, the live cards' lost contact or forgetting the board.
   */
  private async scheduleAlarm(): Promise<void> {
    let next = Infinity;
    for (const ws of this.ctx.getWebSockets()) {
      const a = attachment(ws);
      const pending = a.role === 'board' ? !a.authed : a.slot === null;
      if (pending && ws.readyState === WebSocket.OPEN) next = Math.min(next, a.since + SIGN_IN_MS);
    }
    const seen = this.lastSeen();
    if (seen !== null && !this.board()) {
      next = Math.min(next, seen * 1000 + FORGET_MS);
      for (const r of this.offlineRows()) next = Math.min(next, seen * 1000 + r.offline_after * MINUTE_MS);
      const stage = this.meta('lost_stage') ?? 0;
      if (stage < 2 && this.liveRows().some((r) => r.activity_token !== null)) {
        next = Math.min(next, (seen + (stage < 1 ? LOST_UPDATE_S : LOST_END_S)) * 1000);
      }
    }
    const have = await this.ctx.storage.getAlarm();
    if (next === Infinity) {
      // In a room no board ever signed in to, alarms are the only thing ever stored: drop it all,
      // whatever getAlarm() says (inside alarm() it no longer shows the alarm that is running).
      if (!this.hasSchema()) {
        if (have !== null || this.storesAnything()) await this.ctx.storage.deleteAll();
      } else if (have !== null) await this.ctx.storage.deleteAlarm();
    } else if (have === null || next < have) {
      await this.ctx.storage.setAlarm(next);
    }
  }
}

/** A plain-text HTTP answer. */
function reply(status: number, text: string, headers: Record<string, string> = {}): Response {
  return new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers } });
}

/** A request body of at most `max` bytes, or null when it is longer (reading stops there). */
async function readCapped(request: Request, max: number): Promise<Uint8Array | null> {
  if (Number(request.headers.get('Content-Length') ?? 0) > max) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function decodeUtf8(b: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(b);
  } catch {
    return null;
  }
}

/** The code a phone sees for the board's CLOSE: 1000, 1008 and 4000-4999 pass, anything else is 1000. */
function passOn(code: number): number {
  return code === 1000 || code === 1008 || (code >= 4000 && code <= 4999) ? code : 1000;
}

function attachment(ws: WebSocket): Attachment {
  return ws.deserializeAttachment() as Attachment;
}

function attach(ws: WebSocket, a: Attachment): void {
  ws.serializeAttachment(a);
}

/** Sends unless the socket went away meanwhile (a send to a closed socket throws). */
function send(ws: WebSocket, m: Uint8Array): void {
  try {
    ws.send(m);
  } catch {
    // its close event follows
  }
}

/** Closes a socket unless it is already closing. */
function closeSocket(ws: WebSocket, code: number, reason: string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.close(code, reason);
  } catch {
    // closed meanwhile
  }
}

function equal(a: Uint8Array, b: Uint8Array | undefined): boolean {
  if (!b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function fromHex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const LIVE_EVENTS = ['start', 'update', 'end'];
const TOKEN_NAMES = { device: 'device', start: 'start token', activity: 'card' } as const;

/** A push payload's Live Activity event (start, update, end), or `alert`. */
function pushEvent(payload: unknown): string {
  const e = (payload as { aps?: { event?: unknown } } | null)?.aps?.event;
  return typeof e === 'string' && /^[a-z]{1,10}$/.test(e) ? e : 'alert';
}

/** Logs carry board ids, events and close codes; never frames, tokens or addresses. */
function log(id: string | undefined, event: string, code?: number): void {
  console.log(`${id ?? '?'} ${event}${code === undefined ? '' : ` ${code}`}`);
}
