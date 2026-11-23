// A fake board and a fake phone that talk to the relay through the Worker, as real ones would.

import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { base32, boardIdOf } from '../src/boardId';
import type { BoardRoom } from '../src/boardRoom';
import type { ApnsItem, ApnsOutcome } from '../src/push/types';
import { Op, SUBPROTOCOL, authSignedBytes } from '../src/wire';
import { concat, toHex } from './bytes';

export const HOST = 'relay.flamekeeper.app';
const WAIT_MS = 2000;

export interface Closed {
  code: number;
  reason: string;
}

export interface FakeSocket {
  ws: WebSocket;
  /** The next binary message; rejects after 2 s, or when a text message comes. */
  next(): Promise<Uint8Array>;
  /** True when no message is waiting after `ms` (a short pause to let the relay act). */
  quiet(ms?: number): Promise<boolean>;
  send(m: Uint8Array | string): void;
  closed: Promise<Closed>;
}

export interface FakeBoardSocket extends FakeSocket {
  id: string;
  publicKey: Uint8Array;
  keys: CryptoKeyPair;
  /** Answers the relay's CHALLENGE and resolves at the relay's WANT (hex), which follows a good AUTH. */
  signIn(want?: string): Promise<void>;
  /** The AUTH message for a challenge, signed over `host`. */
  auth(challenge: Uint8Array, host?: string): Promise<Uint8Array>;
  roster(entries: Array<[slot: number, hash: Uint8Array]>): void;
}

export type FakeAppSocket = FakeSocket;

let nextIp = 1;
/** A fresh client address per socket, so the per-IP limits never get in a test's way. */
export function freshIp(): string {
  const n = nextIp++;
  return `198.51.${(n >> 8) & 255}.${n & 255}`;
}

/** A well-formed board id that no key behind these tests has. */
export function randomId(): string {
  return base32(crypto.getRandomValues(new Uint8Array(16)));
}

export function room(id: string): DurableObjectStub<BoardRoom> {
  return env.BOARD.getByName(id);
}

/** Connects through the Worker, or straight to a room (`via`, e.g. one not made by board id). */
export async function connect(path: string, host = HOST, via?: DurableObjectStub<BoardRoom>): Promise<FakeSocket> {
  const r = await (via ?? exports.default).fetch(`https://${host}${path}`, {
    headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': SUBPROTOCOL, 'CF-Connecting-IP': freshIp() },
  });
  const ws = r.webSocket;
  if (r.status !== 101 || !ws) throw new Error(`upgrade answered ${r.status}`);

  ws.binaryType = 'arraybuffer';
  const queue: Array<Uint8Array | string> = [];
  const waiters: Array<(m: Uint8Array | string) => void> = [];
  ws.addEventListener('message', (e) => {
    const m = typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer);
    const w = waiters.shift();
    if (w) w(m);
    else queue.push(m);
  });
  const closed = new Promise<Closed>((resolve) => {
    ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason }));
  });
  ws.accept();

  return {
    ws,
    closed,
    send: (m) => ws.send(m),
    next() {
      const m = queue.shift();
      const got =
        m !== undefined
          ? Promise.resolve(m)
          : new Promise<Uint8Array | string>((resolve, reject) => {
              const t = setTimeout(() => {
                waiters.splice(waiters.indexOf(f), 1);
                reject(new Error('no message'));
              }, WAIT_MS);
              const f = (x: Uint8Array | string) => {
                clearTimeout(t);
                resolve(x);
              };
              waiters.push(f);
            });
      return got.then((x) => {
        if (typeof x === 'string') throw new Error('text message');
        return x;
      });
    },
    async quiet(ms = 50) {
      await new Promise((r) => setTimeout(r, ms));
      return queue.length === 0;
    },
  };
}

export async function newKeys(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
}

export async function fakeBoard(
  o: { host?: string; firmware?: string; keyOf?: CryptoKeyPair; id?: string; via?: DurableObjectStub<BoardRoom> } = {},
): Promise<FakeBoardSocket> {
  const keys = o.keyOf ?? (await newKeys());
  const publicKey = new Uint8Array((await crypto.subtle.exportKey('raw', keys.publicKey)) as ArrayBuffer);
  const id = o.id ?? (await boardIdOf(publicKey));
  const host = o.host ?? HOST;
  const firmware = o.firmware ?? '1.4.0';
  const s = await connect(`/v1/board/${id}`, host, o.via);

  async function auth(challenge: Uint8Array, signedHost = host): Promise<Uint8Array> {
    const signed = authSignedBytes(challenge, signedHost, firmware);
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, signed));
    const fw = new TextEncoder().encode(firmware);
    return concat(new Uint8Array([0, Op.auth]), publicKey, sig, new Uint8Array([fw.length]), fw);
  }

  return {
    ...s,
    id,
    publicKey,
    keys,
    auth,
    async signIn(expected = '0008000000') {
      const c = await s.next();
      if (c[0] !== 0 || c[1] !== Op.challenge || c.length !== 34) throw new Error('expected CHALLENGE');
      s.send(await auth(c.subarray(2)));
      const want = await s.next();
      if (toHex(want) !== expected) throw new Error(`expected WANT ${expected}, got ${toHex(want)}`);
    },
    roster(entries) {
      s.send(
        concat(new Uint8Array([0, Op.roster, 1]), ...entries.map(([slot, hash]) => concat(new Uint8Array([slot]), hash))),
      );
    },
  };
}

export async function fakeApp(id: string, token?: Uint8Array): Promise<FakeAppSocket> {
  const s = await connect(`/v1/app/${id}`);
  if (token) s.send(token);
  return s;
}

/** Unpadded base64url, as the app sends its relay token. */
export function base64url(b: Uint8Array): string {
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A phone's push registration call: `PUT` (or `DELETE`) `/v1/app/<id>/push` with its relay token. */
export function register(
  id: string,
  token: Uint8Array,
  body: object | null,
  method: 'PUT' | 'DELETE' = 'PUT',
  host = HOST,
): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${base64url(token)}`, 'CF-Connecting-IP': freshIp() };
  if (body !== null) headers['Content-Type'] = 'application/json';
  return exports.default.fetch(`https://${host}/v1/app/${id}/push`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
  });
}

/** Puts a recording APNs sender in the room; it answers `answer(item)` (default 'sent') per item. */
export async function fakeSender(
  id: string,
  answer: (item: ApnsItem) => ApnsOutcome = () => 'sent',
): Promise<{ items(): Promise<ApnsItem[]> }> {
  const sent: ApnsItem[] = [];
  await runInDurableObject(room(id), (o: BoardRoom) => {
    o.pushSender = async (items) => {
      sent.push(...items);
      return items.map(answer);
    };
  });
  return { items: async () => [...sent] };
}

/** Retries `check` until it gives true (or throws after 2 s). */
export async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
  const until = Date.now() + WAIT_MS;
  for (;;) {
    if (await check()) return;
    if (Date.now() > until) throw new Error('condition never held');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Sets the room's clock (ms). */
export function setClock(id: string, ms: number): Promise<void> {
  return runInDurableObject(room(id), (o: BoardRoom) => {
    o.clock = () => ms;
  });
}

/** Rows of a table in the room's SQLite storage; [] when the table does not exist. */
export function rows(id: string, table: string): Promise<Record<string, SqlStorageValue>[]> {
  return runInDurableObject(room(id), (_o: BoardRoom, state) => {
    const exists = state.storage.sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, table).toArray();
    return exists.length ? state.storage.sql.exec(`SELECT * FROM ${table}`).toArray() : [];
  });
}

/** The room's own tables (not the runtime's). */
export function tables(id: string): Promise<string[]> {
  return runInDurableObject(room(id), (_o: BoardRoom, state) =>
    state.storage.sql
      .exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`)
      .toArray()
      .map((r) => r.name),
  );
}

/** True when the room has stored nothing at all: no tables (the runtime's own included) and no alarm. */
export function storedNothing(id: string): Promise<boolean> {
  return runInDurableObject(room(id), async (_o: BoardRoom, state) => {
    const names = state.storage.sql.exec(`SELECT name FROM sqlite_master`).toArray();
    return names.length === 0 && (await state.storage.getAlarm()) === null;
  });
}

export function attachments(id: string, tag: 'board' | 'app'): Promise<Array<Record<string, unknown>>> {
  return runInDurableObject(room(id), (_o: BoardRoom, state) =>
    state.getWebSockets(tag).map((w) => w.deserializeAttachment() as Record<string, unknown>),
  );
}
