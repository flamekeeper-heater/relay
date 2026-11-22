// The relay's wire format (PROTOCOL.md). Every message is binary: u8 channel, then
// the content. Channel 0 is the board and the relay talking (u8 op, then data); channels 1-3 carry
// one phone's app frames, which the relay never reads. Multi-byte numbers are little-endian.

import { isBoardId } from './boardId';

export const SUBPROTOCOL = 'flamekeeper-relay.v1';

/** A board's socket, a phone's socket, or a phone's push registration call (HTTP). */
export type Role = 'board' | 'app' | 'push';

const PATH = /^\/v1\/(board|app)\/([a-z2-7]{26})(\/push)?$/;

/** The role and board id of a relay path (`/v1/board/<id>`, `/v1/app/<id>`, `/v1/app/<id>/push`), or null. */
export function parsePath(pathname: string): { role: Role; id: string } | null {
  const m = PATH.exec(pathname);
  if (!m || !isBoardId(m[2])) return null;
  if (m[3]) return m[1] === 'app' ? { role: 'push', id: m[2] } : null;
  return { role: m[1] as Role, id: m[2] };
}

/** The longest message the relay accepts either way (the board's frames are at most 1 + 1024 bytes). */
export const MAX_MESSAGE = 2048;

export const Op = { challenge: 1, auth: 2, roster: 3, open: 4, close: 5, push: 6, live: 7, want: 8 } as const;

export const Close = {
  replaced: 4001,
  authFailed: 4002,
  notPaired: 4003,
  offline: 4004,
  full: 4005,
  policy: 4008,
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
  const m = new Uint8Array(2 + c.length);
  m.set([0, Op.challenge]);
  m.set(c, 2);
  return m;
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
  const out = new Uint8Array(SIGNED_PREFIX.length + challenge.length + 1 + h.length + 1 + f.length);
  let o = 0;
  out.set(SIGNED_PREFIX, o);
  o += SIGNED_PREFIX.length;
  out.set(challenge, o);
  o += challenge.length;
  out[o++] = h.length;
  out.set(h, o);
  o += h.length;
  out[o++] = f.length;
  out.set(f, o);
  return out;
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
 * PUSH: `00 06` ‖ u8 class 0-3 ‖ u8 n ≤ 8 ‖ n × (u8 slot 0-7, u8 length ≥ 28, blob); slots unique,
 * the lengths exactly filling the message. The blobs are the board's, encrypted per phone.
 */
export function decodePush(m: Uint8Array): { cls: number; blobs: Array<{ slot: number; blob: Uint8Array }> } | null {
  if (m.length < 4 || m[0] !== 0 || m[1] !== Op.push) return null;
  const cls = m[2];
  const n = m[3];
  if (cls > CLASS_MAX || n > SLOTS) return null;
  const blobs: Array<{ slot: number; blob: Uint8Array }> = [];
  const seen = new Set<number>();
  let o = 4;
  for (let i = 0; i < n; i++) {
    if (o + 2 > m.length) return null;
    const slot = m[o];
    const length = m[o + 1];
    if (slot >= SLOTS || seen.has(slot) || length < BLOB_MIN || o + 2 + length > m.length) return null;
    seen.add(slot);
    blobs.push({ slot, blob: m.slice(o + 2, o + 2 + length) });
    o += 2 + length;
  }
  return o === m.length ? { cls, blobs } : null;
}

export function encodeOpen(channel: number, slot: number): Uint8Array {
  return new Uint8Array([0, Op.open, channel, slot]);
}

/** WANT: the slots with a push registration and with a live card, a bit per slot. */
export function encodeWant(pushSlots: number, liveSlots: number): Uint8Array {
  return new Uint8Array([0, Op.want, pushSlots, liveSlots]);
}

export function encodeClose(channel: number, code: number): Uint8Array {
  return new Uint8Array([0, Op.close, channel, code & 0xff, code >> 8]);
}

export function decodeClose(m: Uint8Array): { channel: number; code: number } | null {
  if (m.length !== 5 || m[0] !== 0 || m[1] !== Op.close) return null;
  return { channel: m[2], code: m[3] | (m[4] << 8) };
}
