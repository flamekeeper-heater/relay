// The relay's wire format (PROTOCOL.md). Every message is binary: u8 channel, then the content.
// Channel 0 is the board and the relay talking (u8 op, then data); channels 1-3 carry one phone's
// app frames, which the relay never reads. Multi-byte numbers are little-endian.

import { concat } from './bytes';

export const SUBPROTOCOL = 'flamekeeper-relay.v1';

/** A board's socket, a phone's socket, a phone's push registration call, or its "card ended" call. */
export type Role = 'board' | 'app' | 'push' | 'cardEnd';

const PATH = /^\/v1\/(board|app)\/([a-z2-7]{26})(\/push(\/activity\/end)?)?$/;

/** The role and board id of a relay path, or null. */
export function parsePath(pathname: string): { role: Role; id: string } | null {
  const m = PATH.exec(pathname);
  if (!m) return null;
  if (!m[3]) return { role: m[1] as Role, id: m[2] };
  return m[1] === 'app' ? { role: m[4] ? 'cardEnd' : 'push', id: m[2] } : null;
}

/** The keepalive: a text message the relay answers without waking the board's room. */
export const PING = 'ping';
export const PONG = 'pong';

/** The longest message the relay accepts either way (the board's frames are at most 1 + 1024 bytes). */
export const MAX_MESSAGE = 2048;

export const Op = { challenge: 1, auth: 2, roster: 3, open: 4, close: 5, push: 6, live: 7, want: 8 } as const;

export const Close = {
  /** The board sent no keepalive: taken as gone. */
  silent: 1001,
  /** A text message other than the keepalive. */
  unsupported: 1003,
  /** A bad first message, or no token within 10 s. */
  policy: 1008,
  tooBig: 1009,
  replaced: 4001,
  authFailed: 4002,
  notPaired: 4003,
  offline: 4004,
  full: 4005,
  /** The board signed in again on a newer socket: connect again now. */
  restarted: 4006,
} as const;

export const CHALLENGE_BYTES = 32;
export const TOKEN_BYTES = 32;
const PUBLIC_KEY_BYTES = 65;
const SIGNATURE_BYTES = 64;
const FIRMWARE_MAX = 32;
const HASH_BYTES = 32;
const SLOTS = 8;
const ROSTER_FORMAT = 1;
const SIGNED_PREFIX = new TextEncoder().encode('fk1 relay board');

export interface Auth {
  publicKey: Uint8Array;
  signature: Uint8Array;
  firmware: string;
}

export function encodeChallenge(c: Uint8Array): Uint8Array {
  return concat(new Uint8Array([0, Op.challenge]), c);
}

/** `00 02` ‖ public key (65) ‖ signature r ‖ s (64) ‖ u8 n ‖ firmware version (n ≤ 32, UTF-8). */
export function decodeAuth(m: Uint8Array): Auth | null {
  const head = 2 + PUBLIC_KEY_BYTES + SIGNATURE_BYTES;
  if (m.length < head + 1 || m[0] !== 0 || m[1] !== Op.auth) return null;
  const n = m[head];
  if (n > FIRMWARE_MAX || m.length !== head + 1 + n) return null;
  let firmware: string;
  try {
    firmware = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(m.subarray(head + 1));
  } catch {
    return null;
  }
  return {
    publicKey: m.slice(2, 2 + PUBLIC_KEY_BYTES),
    signature: m.slice(2 + PUBLIC_KEY_BYTES, head),
    firmware,
  };
}

/** `"fk1 relay board"` ‖ challenge ‖ u8 host length ‖ host ‖ u8 n ‖ firmware version. */
export function authSignedBytes(challenge: Uint8Array, host: string, firmware: string): Uint8Array {
  const h = new TextEncoder().encode(host);
  const f = new TextEncoder().encode(firmware);
  return concat(SIGNED_PREFIX, challenge, new Uint8Array([h.length]), h, new Uint8Array([f.length]), f);
}

/** `00 03` ‖ u8 format 1 ‖ n × (u8 slot 0-7, SHA-256(T) 32 bytes), n ≤ 8, slots unique. */
export function decodeRoster(m: Uint8Array): Map<number, Uint8Array> | null {
  if (m.length < 3 || m[0] !== 0 || m[1] !== Op.roster || m[2] !== ROSTER_FORMAT) return null;
  const body = m.length - 3;
  const entry = 1 + HASH_BYTES;
  if (body % entry !== 0 || body / entry > SLOTS) return null;
  const roster = new Map<number, Uint8Array>();
  for (let o = 3; o < m.length; o += entry) {
    const slot = m[o];
    if (slot >= SLOTS || roster.has(slot)) return null;
    roster.set(slot, m.slice(o + 1, o + entry));
  }
  return roster;
}

/** The shortest blob: a 12-byte nonce and a 16-byte tag around an empty payload. */
const BLOB_MIN = 28;
const CLASS_MAX = 3;

/**
 * The blobs that end a PUSH: `n` × (u8 slot 0-7, u8 length ≥ 28, blob) from offset `o`,
 * slots unique, the lengths exactly filling the message. The blobs are the board's, sealed per phone.
 */
function decodeBlobs(m: Uint8Array, o: number, n: number): Map<number, Uint8Array> | null {
  if (n > SLOTS) return null;
  const blobs = new Map<number, Uint8Array>();
  for (let i = 0; i < n; i++) {
    if (o + 2 > m.length) return null;
    const slot = m[o];
    const length = m[o + 1];
    if (slot >= SLOTS || blobs.has(slot) || length < BLOB_MIN || o + 2 + length > m.length) return null;
    blobs.set(slot, m.slice(o + 2, o + 2 + length));
    o += 2 + length;
  }
  return o === m.length ? blobs : null;
}

/** PUSH: `00 06` ‖ u8 class 0-3 ‖ u8 n ≤ 8 ‖ the blobs. */
export function decodePush(m: Uint8Array): { cls: 0 | 1 | 2 | 3; blobs: Map<number, Uint8Array> } | null {
  if (m.length < 4 || m[0] !== 0 || m[1] !== Op.push || m[2] > CLASS_MAX) return null;
  const blobs = decodeBlobs(m, 4, m[3]);
  return blobs && { cls: m[2] as 0 | 1 | 2 | 3, blobs };
}

export function encodeOpen(channel: number, slot: number): Uint8Array {
  return new Uint8Array([0, Op.open, channel, slot]);
}

/**
 * WANT: the slots with a device token (alerts), with a live card (its update token) and that can
 * be sent a push-to-start (a start token), a bit per slot.
 */
export function encodeWant(pushSlots: number, liveSlots: number, startSlots: number): Uint8Array {
  return new Uint8Array([0, Op.want, pushSlots, liveSlots, startSlots]);
}

export const LiveEvent = { start: 0, update: 1, end: 2 } as const;
/** The events' names, as APNs and the logs say them. */
export const LIVE_EVENT_NAMES = ['start', 'update', 'end'] as const;
const NO_STARTER = 0xff;
const LIVE_HEAD = 14;
/** The longest record a LIVE may carry; the relay passes it on unread. */
const RECORD_MAX = 64;

export interface Live {
  event: 0 | 1 | 2;
  /** Flags bit 0: APNs priority 10. (Bit 1, a fault end, is the board's and the app's.) */
  important: boolean;
  /** Seconds until the card goes grey. */
  staleS: number;
  /** For an end: seconds the final card stays. */
  dismissalS: number;
  /** The board's id for this run, never 0. */
  run: number;
  /** The slots of the phones this LIVE is for, a bit each. */
  slots: number;
  /** The live record, the same for every phone, not sealed. */
  record: Uint8Array;
}

/**
 * LIVE: `00 07` ‖ u8 event 0-2 ‖ u8 flags ‖ u16 stale s ‖ u16 dismissal s ‖ u8 starter slot
 * (0xFF none; not used by the relay) ‖ u32 run id (not 0) ‖ u8 slots ‖ the record (1-64 bytes).
 */
export function decodeLive(m: Uint8Array): Live | null {
  if (m.length <= LIVE_HEAD || m.length > LIVE_HEAD + RECORD_MAX || m[0] !== 0 || m[1] !== Op.live) return null;
  const event = m[2];
  const starter = m[8];
  const run = (m[9] | (m[10] << 8) | (m[11] << 16) | (m[12] << 24)) >>> 0;
  if (event > LiveEvent.end || (starter >= SLOTS && starter !== NO_STARTER) || run === 0) return null;
  return {
    event: event as 0 | 1 | 2,
    important: (m[3] & 1) !== 0,
    staleS: m[4] | (m[5] << 8),
    dismissalS: m[6] | (m[7] << 8),
    run,
    slots: m[13],
    record: m.slice(LIVE_HEAD),
  };
}

export function encodeClose(channel: number, code: number): Uint8Array {
  return new Uint8Array([0, Op.close, channel, code & 0xff, code >> 8]);
}

export function decodeClose(m: Uint8Array): { channel: number; code: number } | null {
  if (m.length !== 5 || m[0] !== 0 || m[1] !== Op.close) return null;
  return { channel: m[2], code: m[3] | (m[4] << 8) };
}
