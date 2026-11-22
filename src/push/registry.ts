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
}

const KEYS = new Set(['kind', 'env', 'device', 'offlineAfter']);
/** Whole bytes: 32 to 100 of them, as lowercase hex. */
const DEVICE = /^(?:[0-9a-f]{2}){32,100}$/;

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
