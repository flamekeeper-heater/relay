// One Durable Object per board id: the board's socket, its phones' sockets, and what the board's
// pushes need (`Store`).
//
// Sockets use the Hibernation API, so the object may lose its memory between any two messages:
// what routing needs lives in each socket's attachment and in storage, never in fields.

import { DurableObject } from 'cloudflare:workers';
import { verifyBoardAuth } from './auth';
import { fromHex, sha256, toHex } from './bytes';
import { type Env, pushAvailable } from './index';
import { type AlertMessage, apnsForBlob, apnsForOffline } from './push/apnsMessage';
import { LOST_END_S, LOST_UPDATE_S, lateEndRequest, liveRequests, lostContactRequests } from './push/live';
import { REGISTRATION_MAX, parseBearer, parseCardEnd, parseRegistration } from './push/registry';
import type { ApnsItem, ApnsOutcome, PushSend, Registration, Send } from './push/types';
import { type Masks, Store } from './store';
import {
  CHALLENGE_BYTES,
  Close,
  LIVE_EVENT_NAMES,
  LiveEvent,
  MAX_MESSAGE,
  Op,
  PING,
  PONG,
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

interface BoardSocket {
  role: 'board';
  /** The board id and the host as the board dialled them (for AUTH). */
  id: string;
  host: string;
  /** This connection's challenge, hex. */
  challenge: string;
  /** When the socket was accepted (ms, by `clock`). */
  since: number;
  /** When its AUTH verified (ms); null before, and again once the relay lets it go. */
  authedAt: number | null;
}

interface AppSocket {
  role: 'app';
  since: number;
  /** The roster slot its token matched; null until it sent one. */
  slot: number | null;
  /** Its channel to the board (1-3); null until admitted, and again once the relay lets it go. */
  channel: number | null;
}

type Attachment = BoardSocket | AppSocket;

/** How long a socket has to authenticate (a board's AUTH, a phone's token). */
const SIGN_IN_MS = 10_000;
/** A board sends the keepalive every 45 s: none for this long and it is taken as gone. */
export const SILENT_MS = 120_000;
/** A board unseen this long is forgotten with everything stored for it. */
const FORGET_MS = 90 * 24 * 3600 * 1000;
const CHANNELS = [1, 2, 3];
/** A phone's longest message, so that the board gets at most MAX_MESSAGE with the channel byte. */
const APP_MESSAGE_MAX = MAX_MESSAGE - 1;
/** The class of a PUSH that is never limited (a CO alarm). */
const ALARM_CLASS = 3;
/** How long APNs keeps a push for a phone that is off: a phone off overnight still gets it. */
const PUSH_EXPIRY_S = 86_400;

export class BoardRoom extends DurableObject<Env> {
  /** Milliseconds since the epoch; tests replace it. */
  clock: () => number = () => Date.now();
  /** When the relay last answered this socket's keepalive (ms), or null; tests replace it. */
  pingAt: (ws: WebSocket) => number | null = (ws) => this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? null;
  /** Hands APNs items to Apple, through the one APNs sender object; tests replace it. */
  pushSender: PushSend = async (items) => {
    if (!pushAvailable(this.env)) return items.map((): ApnsOutcome => 'failed');
    return this.env.PUSH.getByName('apns').send(items);
  };
  private readonly store: Store;
  private readonly id: string;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new Store(ctx.storage);
    this.id = ctx.id.name ?? '';
    // The keepalive is answered without waking the object; `pingAt` says when.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = parsePath(url.pathname);
    if (!path) return new Response('Not found', { status: 404 });
    if (path.role === 'push' || path.role === 'cardEnd') return this.registrationCall(request, path.role);
    const pair = new WebSocketPair();
    const ws = pair[1];
    this.ctx.acceptWebSocket(ws, [path.role]);
    const since = this.clock();
    if (path.role === 'board') {
      const challenge = crypto.getRandomValues(new Uint8Array(CHALLENGE_BYTES));
      attach(ws, { role: 'board', id: path.id, host: url.host, challenge: toHex(challenge), since, authedAt: null });
      send(ws, encodeChallenge(challenge));
    } else {
      attach(ws, { role: 'app', since, slot: null, channel: null });
    }
    await this.scheduleAlarm();
    return new Response(null, { status: 101, webSocket: pair[0], headers: { 'Sec-WebSocket-Protocol': SUBPROTOCOL } });
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    if (ws.readyState !== WebSocket.OPEN) return; // the relay is already closing it
    const a = attachment(ws);
    const tooBig = typeof message !== 'string' && message.byteLength > (a.role === 'app' ? APP_MESSAGE_MAX : MAX_MESSAGE);
    if (typeof message === 'string' || tooBig) {
      const code = tooBig ? Close.tooBig : Close.unsupported;
      if (a.role === 'app') this.closePhone(ws, a, code);
      else closeSocket(ws, code);
      return;
    }
    const m = new Uint8Array(message);
    if (a.role === 'board') await this.boardMessage(ws, a, m);
    else if (a.slot === null) await this.admit(ws, a, m);
    else if (a.channel !== null) this.forward(a.channel, m);
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    await this.socketGone(ws);
    // Answer the peer's close so its side completes.
    closeSocket(ws, code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.socketGone(ws);
  }

  async alarm(): Promise<void> {
    const now = this.clock();
    for (const ws of this.ctx.getWebSockets()) {
      const a = attachment(ws);
      if (now < a.since + SIGN_IN_MS) continue;
      if (a.role === 'board' && a.authedAt === null) closeSocket(ws, Close.authFailed, 'sign-in failed');
      if (a.role === 'app' && a.slot === null) closeSocket(ws, Close.policy, 'no token');
    }
    const board = this.board();
    if (board && now >= this.heard(board) + SILENT_MS) this.boardSilent(board);
    const seen = this.store.meta('last_seen');
    if (seen !== null && !this.board()) {
      if (now >= seen * 1000 + FORGET_MS) {
        await this.store.wipe();
        this.log('forgotten');
        return;
      }
      await this.offlinePushes(now, seen);
      // The board may have signed in while the offline pushes went out.
      if (!this.board()) await this.lostContact(now, seen);
    }
    await this.scheduleAlarm();
  }

  // The board.

  private async boardMessage(ws: WebSocket, a: BoardSocket, m: Uint8Array): Promise<void> {
    if (a.authedAt === null) {
      await this.signIn(ws, a, m);
      return;
    }
    if (m[0] !== 0) {
      // An app frame for channel m[0]; dropped when no phone holds that channel.
      const app = this.channels().get(m[0]);
      if (app) send(app, m.subarray(1));
      return;
    }
    switch (m[1]) {
      case Op.roster: {
        const roster = decodeRoster(m);
        if (!roster) closeSocket(ws, Close.policy, 'bad roster');
        else this.setRoster(ws, roster);
        break;
      }
      case Op.close: {
        const c = decodeClose(m);
        const app = c && this.channels().get(c.channel);
        if (!c) closeSocket(ws, Close.policy, 'bad close');
        else if (app) this.closePhone(app, attachment(app) as AppSocket, passOn(c.code), '', false);
        break;
      }
      case Op.push:
        await this.boardPush(m);
        break;
      case Op.live:
        await this.boardLive(m);
        break;
      // Any other op is ignored.
    }
  }

  private async signIn(ws: WebSocket, a: BoardSocket, m: Uint8Array): Promise<void> {
    const auth = decodeAuth(m);
    // No other message is handled until the check is done: the board sends ROSTER right behind AUTH.
    const ok = auth !== null && (await this.ctx.blockConcurrencyWhile(() => verifyBoardAuth(auth, fromHex(a.challenge), a.host, a.id)));
    if (!ok) {
      this.log('board refused', { code: Close.authFailed });
      closeSocket(ws, Close.authFailed, 'sign-in failed');
      return;
    }
    const old = this.board();
    if (old) {
      // The new socket knows nothing of the old one's sessions: its phones connect again.
      attach(old, { ...(attachment(old) as BoardSocket), authedAt: null });
      closeSocket(old, Close.replaced, 'replaced');
      this.closePhones(Close.restarted, 'restarted');
    }
    const now = this.clock();
    attach(ws, { ...a, authedAt: now });
    this.store.setMeta('last_seen', Math.floor(now / 1000));
    // A new absence starts clean: the next one says "offline" and "lost contact" again.
    this.store.setMeta('lost_stage', null);
    this.store.setOfflineSent(this.store.registrations().map((r) => r.slot), false);
    this.sendWant(ws);
    await this.scheduleAlarm();
    this.log('board in');
  }

  /** The signed-in board socket, if any. */
  private board(): WebSocket | null {
    return this.ctx.getWebSockets('board').find((ws) => ws.readyState === WebSocket.OPEN && (attachment(ws) as BoardSocket).authedAt !== null) ?? null;
  }

  /** When the board was last heard: its sign-in, or its last keepalive (ms). */
  private heard(board: WebSocket): number {
    return Math.max((attachment(board) as BoardSocket).authedAt ?? 0, this.pingAt(board) ?? 0);
  }

  /**
   * WANT: which slots have a device token, a live card and a push-to-start token. Sent after AUTH,
   * after every ROSTER and when registrations change; the board replaces its masks with each one.
   */
  private sendWant(board: WebSocket): void {
    const m = this.store.masks();
    send(board, encodeWant(m.push, m.live, m.start));
  }

  /** WANT to the signed-in board if the masks differ from `before`. */
  private wantIfChanged(before: Masks): void {
    const now = this.store.masks();
    const board = this.board();
    if (board && (now.push !== before.push || now.live !== before.live || now.start !== before.start)) this.sendWant(board);
  }

  /** Stores a new roster, lets go of the phones whose slot left it or changed hash, then WANT. */
  private setRoster(board: WebSocket, roster: Map<number, Uint8Array>): void {
    const changed = this.store.setRoster(roster);
    for (const ws of this.ctx.getWebSockets('app')) {
      const a = attachment(ws) as AppSocket;
      if (a.slot !== null && changed.has(a.slot)) this.closePhone(ws, a, Close.notPaired);
    }
    this.sendWant(board);
  }

  /** The board sent no keepalive for `SILENT_MS`: its connection died without a close. */
  private boardSilent(board: WebSocket): void {
    this.boardGone(board, this.heard(board));
    this.log('board silent');
    closeSocket(board, Close.silent, 'silent');
  }

  /** The board left: it was last seen at `seenMs`, and its phones learn that. */
  private boardGone(board: WebSocket, seenMs: number): void {
    attach(board, { ...(attachment(board) as BoardSocket), authedAt: null });
    // A socket from before a deploy may carry no sign-in time: last seen is then now, never 0 (which would forget the board).
    const seen = Math.floor((seenMs > 0 ? seenMs : this.clock()) / 1000);
    this.store.setMeta('last_seen', seen);
    this.closePhones(Close.offline, `offline ${seen}`);
  }

  private async socketGone(ws: WebSocket): Promise<void> {
    const a = attachment(ws);
    if (a.role === 'board' && a.authedAt !== null) {
      this.boardGone(ws, this.clock());
      this.log('board gone');
    } else if (a.role === 'app' && a.channel !== null) {
      this.closePhone(ws, a, 1000);
    }
    await this.scheduleAlarm();
  }

  // Phones.

  /** A phone's first message is its relay token: token, board online, then a channel. */
  private async admit(ws: WebSocket, a: AppSocket, m: Uint8Array): Promise<void> {
    if (m.length !== TOKEN_BYTES) {
      closeSocket(ws, Close.policy, 'bad token');
      return;
    }
    // No other message is handled until the phone is placed: its first frame may follow at once.
    const hash = await this.ctx.blockConcurrencyWhile(() => sha256(m));
    const slot = this.store.slotOf(hash);
    const board = this.board();
    if (slot === null) {
      this.log('app refused', { code: Close.notPaired });
      closeSocket(ws, Close.notPaired);
    } else if (!board) {
      closeSocket(ws, Close.offline, `offline ${this.store.meta('last_seen') ?? 0}`);
    } else {
      // A phone that reconnects (Wi-Fi to cellular, say) while its old socket is still open takes
      // its channel over; the board ends the old session and starts a fresh one.
      const channels = this.channels();
      const mine = [...channels].find(([, other]) => (attachment(other) as AppSocket).slot === slot);
      if (mine) this.closePhone(mine[1], attachment(mine[1]) as AppSocket, Close.replaced, 'replaced');
      const channel = mine?.[0] ?? CHANNELS.find((c) => !channels.has(c));
      if (channel === undefined) {
        this.log('app refused', { code: Close.full });
        closeSocket(ws, Close.full, 'full');
      } else {
        attach(ws, { ...a, slot, channel });
        send(board, encodeOpen(channel, slot));
      }
    }
    await this.scheduleAlarm();
  }

  /** A frame from an admitted phone: to the board with the phone's channel byte in front. */
  private forward(channel: number, m: Uint8Array): void {
    const board = this.board();
    if (!board) return;
    const out = new Uint8Array(1 + m.length);
    out[0] = channel;
    out.set(m, 1);
    send(board, out);
  }

  /** Channel → the phone socket that holds it. */
  private channels(): Map<number, WebSocket> {
    const channels = new Map<number, WebSocket>();
    for (const ws of this.ctx.getWebSockets('app')) {
      const a = attachment(ws) as AppSocket;
      if (a.channel !== null && ws.readyState === WebSocket.OPEN) channels.set(a.channel, ws);
    }
    return channels;
  }

  /** Frees a phone's channel and closes it; the board is told its channel ended unless it asked. */
  private closePhone(ws: WebSocket, a: AppSocket, code: number, reason = '', tellBoard = true): void {
    const board = this.board();
    if (a.channel !== null) {
      if (tellBoard && board) send(board, encodeClose(a.channel, code));
      attach(ws, { ...a, channel: null });
    }
    closeSocket(ws, code, reason);
  }

  /** Closes every admitted phone, without telling the board (it is gone, or new). */
  private closePhones(code: number, reason: string): void {
    for (const app of this.channels().values()) this.closePhone(app, attachment(app) as AppSocket, code, reason, false);
  }

  // Push registrations.

  /**
   * A phone's `PUT` (replace) or `DELETE` of its push registration, or its "card ended" `POST`,
   * authenticated by its relay token: the slot is the one whose roster hash the token matches, so
   * only a phone the board paired can register, and only for itself.
   */
  private async registrationCall(request: Request, role: 'push' | 'cardEnd'): Promise<Response> {
    const allow = role === 'push' ? ['PUT', 'DELETE'] : ['POST'];
    if (!allow.includes(request.method)) return reply(405, 'Method not allowed', { Allow: allow.join(', ') });
    if (Number(request.headers.get('Content-Length') ?? 0) > REGISTRATION_MAX) return reply(413, 'Too large');
    const body = await request.text();
    if (new TextEncoder().encode(body).length > REGISTRATION_MAX) return reply(413, 'Too large');
    const token = parseBearer(request.headers.get('Authorization'));
    const hash = token && (await sha256(token));

    // From here on nothing awaits until the writes are done, so the roster cannot change between
    // the check and the write.
    const slot = hash && this.store.slotOf(hash);
    if (slot === null) {
      this.log('registration refused', { code: 401 });
      await this.scheduleAlarm(); // a room no board signed in to keeps nothing
      return reply(401, 'Unauthorized');
    }
    const before = this.store.masks();
    const old = this.store.registration(slot);
    let late: Send | null = null;
    if (role === 'cardEnd') {
      const end = parseCardEnd(body);
      if (!end) return reply(400, 'Bad request');
      // Only the card that ended (when the phone names it): a newer one may be registered already.
      const card = old?.activity_token;
      if (card && (end.token === null || end.token === card)) {
        this.store.forgetToken(slot, 'activity', card);
        // A card swiped away gets no push-to-start again in this run.
        const run = this.store.meta('live_run');
        if (end.dismissed && run !== null) this.store.setNoStart(slot, run);
      }
      this.log('card ended', { slot, dismissed: end.dismissed });
    } else if (request.method === 'DELETE') {
      this.store.deleteRegistration(slot);
      this.log('registration removed', { slot });
    } else {
      const r = parseRegistration(body);
      if (!r) return reply(400, 'Bad registration');
      this.store.putRegistration(slot, r);
      this.log('registration set', { slot });
      if (r.activityToken && r.activityToken !== old?.activity_token) late = this.lateEnd(slot);
    }
    this.wantIfChanged(before);
    if (late) await this.deliver('late end', [late]);
    // While the board is away, a new offline delay or a new card moves the room's deadlines.
    if (!this.board()) await this.scheduleAlarm();
    return new Response(null, { status: 204 });
  }

  // Pushes.

  /**
   * A PUSH from the board: one APNs item per blob whose slot registered a device token. A
   * malformed one is ignored (the board stays); one over the rate is dropped, unless it is an alarm.
   */
  private async boardPush(m: Uint8Array): Promise<void> {
    const p = decodePush(m);
    if (!p) {
      this.log('push malformed');
      return;
    }
    if (p.cls !== ALARM_CLASS && !(await this.env.PUSH_RATE.limit({ key: this.id })).success) {
      this.log('push over the rate');
      return;
    }
    const critical = this.env.CRITICAL_ALERTS === '1';
    const sends = this.store
      .registrations()
      .filter((r) => r.device && p.blobs.has(r.slot))
      .map((r) => this.alert(r, apnsForBlob(p.cls, this.id, p.blobs.get(r.slot)!, critical)));
    await this.deliver('push', sends);
  }

  /** The alert for one phone's device token, kept by APNs for 24 h. */
  private alert(r: Registration, message: AlertMessage, collapseId?: string): Send {
    const expiration = Math.floor(this.clock() / 1000) + PUSH_EXPIRY_S;
    const item = { env: r.env, token: r.device!, pushType: 'alert' as const, expiration, collapseId, ...message };
    return { slot: r.slot, kind: 'device', event: 'alert', item };
  }

  /**
   * A LIVE from the board: per phone it is for, an update to its card, a push-to-start or the card's
   * end (`liveRequests`). The record is kept for lost contact and a late end.
   */
  private async boardLive(m: Uint8Array): Promise<void> {
    const l = decodeLive(m);
    if (!l) {
      this.log('live malformed');
      return;
    }
    const nowS = Math.floor(this.clock() / 1000);
    const ended = l.event === LiveEvent.end;
    // A card whose token comes only after its run ended is ended then (`lateEnd`).
    this.store.setMeta('live_run', ended ? null : l.run);
    this.store.setMeta('live_ended', ended ? nowS : null);
    this.store.setMeta('live_end_until', ended ? nowS + l.dismissalS : null);
    this.store.setRecord(l.record);
    const sends = liveRequests(l, this.store.registrations(), this.id, nowS);
    const what = `live ${LIVE_EVENT_NAMES[l.event]}`;
    const outcomes = await this.deliver(what, sends, { slots: [0, 1, 2, 3, 4, 5, 6, 7].filter((s) => l.slots & (1 << s)) });
    const next = sends.flatMap((s, i) => (s.next && outcomes[i] === 'sent' ? [s.next] : []));
    if (next.length > 0) await this.deliver(`${what}, old cards`, next);
  }

  /**
   * A card token registered after its run ended (a push-to-start the phone acted on late, or a run
   * that ended within seconds): the end goes to it at once, with the run's last record.
   */
  private lateEnd(slot: number): Send | null {
    const ended = this.store.meta('live_ended');
    const r = this.store.registration(slot);
    const record = this.store.record();
    if (ended === null || !r || !record || r.activity_started === null || r.activity_started >= ended) return null;
    return lateEndRequest(r, record, Math.floor(this.clock() / 1000), this.store.meta('live_end_until') ?? ended);
  }

  /**
   * The board is still away and phones have its live cards: at 10 minutes an update saying since
   * when (`relay.lostAt` = last seen), at 60 minutes the cards' end. Once each per absence.
   */
  private async lostContact(now: number, seen: number): Promise<void> {
    const stage = this.store.meta('lost_stage') ?? 0;
    const rows = this.store.registrations();
    const record = this.store.record();
    if (!record || !rows.some((r) => r.activity_token)) return;
    const nowS = Math.floor(now / 1000);
    if (stage < 2 && nowS >= seen + LOST_END_S) {
      this.store.setMeta('lost_stage', 2);
      // A board back later in the same run may start these phones' cards again.
      this.store.allowStartOfCards();
      await this.deliver('lost contact end', lostContactRequests(rows, record, seen, nowS, true));
    } else if (stage < 1 && nowS >= seen + LOST_UPDATE_S) {
      this.store.setMeta('lost_stage', 1);
      await this.deliver('lost contact', lostContactRequests(rows, record, seen, nowS, false));
    }
  }

  /**
   * The board is still away: the offline push to every phone whose delay has passed since the
   * board was last seen (`t` = last seen), once per absence.
   */
  private async offlinePushes(now: number, seen: number): Promise<void> {
    const due = this.offlineWaiting().filter((r) => now >= offlineDue(r, seen));
    if (due.length === 0) return;
    // Marked before the send, so the alarm never comes back for them in this absence.
    this.store.setOfflineSent(due.map((r) => r.slot), true);
    await this.deliver('offline push', due.map((r) => this.alert(r, apnsForOffline(this.id, seen), `${this.id}-offline`)));
  }

  /** The registrations still waiting for an offline push in this absence. */
  private offlineWaiting(): Registration[] {
    return this.store.registrations().filter((r) => r.device && r.offline_after > 0 && !r.offline_sent);
  }

  /**
   * Hands the items to the APNs sender, then records what APNs said: a token it calls gone is
   * forgotten, a card that ended too, a push-to-start that went out is noted; WANT if the masks
   * changed. The log names each send's event, token kind, environment and outcome, nothing more.
   */
  private async deliver(what: string, sends: Send[], more: Record<string, unknown> = {}): Promise<ApnsOutcome[]> {
    const outcomes = await this.send(sends.map((s) => s.item));
    // A start or card token refused in one environment is tried once in the other, and remembered
    // there if it is taken: iOS may hand a development build a production install's Live Activity tokens.
    const refused = sends.flatMap((s, i) => (outcomes[i] === 'gone' && s.kind !== 'device' ? [i] : []));
    const flipped = refused.map((i) => ({ ...sends[i].item, env: sends[i].item.env === 'sandbox' ? ('production' as const) : ('sandbox' as const) }));
    const again = await this.send(flipped);
    refused.forEach((i, k) => {
      if (again[k] === 'gone') return;
      sends[i] = { ...sends[i], item: flipped[k] };
      outcomes[i] = again[k];
      if (again[k] === 'sent') this.store.setTokenEnv(sends[i].slot, sends[i].kind as 'start' | 'activity', flipped[k].token, flipped[k].env);
    });
    const before = this.store.masks();
    sends.forEach((s, i) => {
      const o = outcomes[i] ?? 'failed';
      // Only the token APNs refused or the card that ended: the phone may have registered a new one meanwhile.
      if (o === 'gone' || (o === 'sent' && s.after === 'forgetCard')) this.store.forgetToken(s.slot, s.kind, s.item.token);
      if (o === 'sent' && s.after === 'started' && s.run !== undefined) this.store.setNoStart(s.slot, s.run);
    });
    this.log(what, { ...more, sends: sends.map((s, i) => ({ push: s.event, to: s.kind, env: s.item.env, outcome: outcomes[i] ?? 'failed' })) });
    this.wantIfChanged(before);
    return outcomes;
  }

  /** Hands the items to the APNs sender; all failed if it cannot be reached. */
  private async send(items: ApnsItem[]): Promise<ApnsOutcome[]> {
    if (items.length === 0) return [];
    try {
      return await this.pushSender(items);
    } catch (e) {
      this.log('sender failed', { error: e instanceof Error ? e.name : 'unknown' });
      return items.map(() => 'failed');
    }
  }

  /**
   * Sets the alarm to the earliest pending deadline: a sign-in or token timeout; the board's
   * keepalive; and while no board is signed in, a phone's offline delay, the live cards' lost
   * contact and forgetting the board. A room with none, that no board ever signed in to, keeps nothing.
   */
  private async scheduleAlarm(): Promise<void> {
    let next = Infinity;
    for (const ws of this.ctx.getWebSockets()) {
      const a = attachment(ws);
      const pending = a.role === 'board' ? a.authedAt === null : a.slot === null;
      if (pending && ws.readyState === WebSocket.OPEN) next = Math.min(next, a.since + SIGN_IN_MS);
    }
    const board = this.board();
    const seen = this.store.meta('last_seen');
    if (board) {
      next = Math.min(next, this.heard(board) + SILENT_MS);
    } else if (seen !== null) {
      next = Math.min(next, seen * 1000 + FORGET_MS, ...this.offlineWaiting().map((r) => offlineDue(r, seen)));
      const stage = this.store.meta('lost_stage') ?? 0;
      if (stage < 2 && this.store.masks().live !== 0) next = Math.min(next, (seen + (stage < 1 ? LOST_UPDATE_S : LOST_END_S)) * 1000);
    }
    if (next === Infinity) await this.store.wipe();
    else if ((await this.ctx.storage.getAlarm()) !== next) await this.ctx.storage.setAlarm(next);
  }

  /** Logs carry the board id, events, close codes, slots and counts; never frames, tokens or addresses. */
  private log(event: string, more: Record<string, unknown> = {}): void {
    console.log({ board: this.id, event, ...more });
  }
}

/** When a registration's offline push is due (ms), for a board last seen at `seen` (UTC seconds). */
function offlineDue(r: Registration, seen: number): number {
  return seen * 1000 + r.offline_after * 60_000;
}

/** A plain-text HTTP answer. */
function reply(status: number, text: string, headers: Record<string, string> = {}): Response {
  return new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers } });
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

/** Closes a socket unless it is already closed. */
function closeSocket(ws: WebSocket, code: number, reason = ''): void {
  try {
    ws.close(code, reason);
  } catch {
    // closed meanwhile
  }
}
