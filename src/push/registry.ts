// A phone's push registration call: `PUT` or `DELETE` `/v1/app/<id>/push` with
// `Authorization: Bearer <base64url of its relay token T>` and, for PUT, a JSON body of the fields
// it sets. The board's room keeps one row per roster slot (BoardRoom, table `push`).

import { TOKEN_BYTES } from '../wire';

export type ApnsEnv = 'sandbox' | 'production';

/** A phone's "heater offline" delays in minutes; 0 off. */
export const OFFLINE_CHOICES = [0, 30, 60, 180, 720, 1440] as const;

/** The longest registration body, in bytes. */
export const REGISTRATION_MAX = 1024;

export interface RegistrationPatch {
  kind?: 'apns';
  env?: ApnsEnv;
  /** The APNs device token, lowercase hex of whole bytes; null clears it (the row stays, without pushes). */
  device?: string | null;
  offlineAfter?: number;
  /** The phone's Live Activity push-to-start token (iOS 17.2+), lowercase hex; null clears it. */
  startToken?: string | null;
  /** The update token of the phone's current card for this board, lowercase hex; null clears it. */
  activityToken?: string | null;
  /** When that card started, UTC seconds (its content state's `card`). */
  activityStartedAt?: number;
  /** The phone's iOS version, `major.minor[.patch]`. */
  iosVersion?: string;
}

const KEYS = new Set(['kind', 'env', 'device', 'offlineAfter', 'startToken', 'activityToken', 'activityStartedAt', 'iosVersion']);
/** Whole bytes: 32 to 100 of them, as lowercase hex. */
const DEVICE = /^(?:[0-9a-f]{2}){32,100}$/;
const IOS_VERSION = /^\d{1,3}(?:\.\d{1,3}){1,2}$/;
const UTC_MAX = 0xffffffff;

/** The fields a PUT sets, or null for anything but a JSON object of only these keys with allowed values. */
export function parseRegistration(body: string): RegistrationPatch | null {
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const patch: RegistrationPatch = {};
  for (const [k, x] of Object.entries(o)) {
    if (!KEYS.has(k)) return null;
    switch (k) {
      case 'kind':
        if (x !== 'apns') return null;
        patch.kind = x;
        break;
      case 'env':
        if (x !== 'sandbox' && x !== 'production') return null;
        patch.env = x;
        break;
      case 'device':
        if (x !== null && (typeof x !== 'string' || !DEVICE.test(x))) return null;
        patch.device = x;
        break;
      case 'offlineAfter':
        if (!(OFFLINE_CHOICES as readonly unknown[]).includes(x)) return null;
        patch.offlineAfter = x as number;
        break;
      case 'startToken':
      case 'activityToken':
        if (x !== null && (typeof x !== 'string' || !DEVICE.test(x))) return null;
        patch[k] = x;
        break;
      case 'activityStartedAt':
        if (!Number.isInteger(x) || (x as number) < 0 || (x as number) > UTC_MAX) return null;
        patch.activityStartedAt = x as number;
        break;
      case 'iosVersion':
        if (typeof x !== 'string' || !IOS_VERSION.test(x)) return null;
        patch.iosVersion = x;
        break;
    }
  }
  return patch;
}

const BEARER = /^Bearer ([A-Za-z0-9_-]{43})$/;

/** The relay token in `Bearer <43 characters of unpadded base64url>`, or null (canonical form only). */
export function parseBearer(h: string | null): Uint8Array | null {
  const m = h === null ? null : BEARER.exec(h);
  if (!m) return null;
  const bin = atob(m[1].replace(/-/g, '+').replace(/_/g, '/') + '=');
  const out = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  if (out.length !== TOKEN_BYTES) return null;
  // The last character carries 2 spare bits, which must be zero.
  if (btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== m[1]) return null;
  return out;
}

/**
 * `DELETE …/push/activity`: why the card went, and which card (its update token) when the phone
 * names it. No body is `ended`, for the current card.
 */
export function parseActivityEnd(body: string): { reason: 'ended' | 'dismissed'; token: string | null } | null {
  if (body.trim() === '') return { reason: 'ended', token: null };
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  let reason: 'ended' | 'dismissed' = 'ended';
  let token: string | null = null;
  for (const [k, x] of Object.entries(o)) {
    if (k === 'reason' && (x === 'ended' || x === 'dismissed')) reason = x;
    else if (k === 'activityToken' && typeof x === 'string' && DEVICE.test(x)) token = x;
    else return null;
  }
  return { reason, token };
}

/** The major version of `major.minor[.patch]`, 0 when unknown. */
export function iosMajor(v: string | null | undefined): number {
  return v ? Number.parseInt(v, 10) || 0 : 0;
}
