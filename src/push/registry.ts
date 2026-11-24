// A phone's push registration calls, authenticated with `Authorization: Bearer <base64url of its
// relay token T>`: `PUT /v1/app/<id>/push` replaces its registration with the JSON body, `DELETE`
// removes it, `POST /v1/app/<id>/push/activity/end` says its card ended. The board's room keeps one
// row per roster slot.

import { TOKEN_BYTES } from '../wire';
import type { ApnsEnv } from './types';

/** A phone's "heater offline" delays in minutes; 0 off. */
const OFFLINE_CHOICES: readonly unknown[] = [0, 30, 60, 180, 720, 1440];

/** The longest registration body, in bytes. */
export const REGISTRATION_MAX = 1024;

/** What a PUT registers: the whole registration. A key left out is null (or 0 for `offlineAfter`). */
export interface RegistrationBody {
  env: ApnsEnv;
  device: string | null;
  offlineAfter: number;
  startToken: string | null;
  activityToken: string | null;
  /** When the card behind `activityToken` started, UTC seconds; null without that token. */
  activityStartedAt: number | null;
  iosVersion: string | null;
}

/** An APNs token: 32 to 100 whole bytes, as lowercase hex. */
const TOKEN = /^(?:[0-9a-f]{2}){32,100}$/;
const IOS_VERSION = /^\d{1,3}(?:\.\d{1,3}){1,2}$/;
const UTC_MAX = 0xffffffff;

const isToken = (x: unknown): x is string => typeof x === 'string' && TOKEN.test(x);
const orNull = <T>(x: unknown, ok: (x: unknown) => x is T): T | null | undefined => (x === undefined || x === null ? null : ok(x) ? x : undefined);

function jsonObject(body: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(body);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function onlyKeys(o: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(o).every((k) => keys.includes(k));
}

/**
 * The registration in a PUT body, or null for anything but a JSON object of only the known keys
 * with allowed values, `env` and at least one token.
 */
export function parseRegistration(body: string): RegistrationBody | null {
  const o = jsonObject(body);
  if (!o || !onlyKeys(o, ['env', 'device', 'offlineAfter', 'startToken', 'activityToken', 'activityStartedAt', 'iosVersion'])) return null;
  const device = orNull(o.device, isToken);
  const startToken = orNull(o.startToken, isToken);
  const activityToken = orNull(o.activityToken, isToken);
  const startedAt = orNull(o.activityStartedAt, (x): x is number => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= UTC_MAX);
  const iosVersion = orNull(o.iosVersion, (x): x is string => typeof x === 'string' && IOS_VERSION.test(x));
  const offlineAfter = o.offlineAfter ?? 0;
  if (o.env !== 'sandbox' && o.env !== 'production') return null;
  if (device === undefined || startToken === undefined || activityToken === undefined || startedAt === undefined || iosVersion === undefined) return null;
  if (!OFFLINE_CHOICES.includes(offlineAfter)) return null;
  if (device === null && startToken === null && activityToken === null) return null;
  return {
    env: o.env,
    device,
    offlineAfter: offlineAfter as number,
    startToken,
    activityToken,
    activityStartedAt: activityToken === null ? null : startedAt,
    iosVersion,
  };
}

/**
 * The body of "my card ended": which card (its update token; none: the current one) and whether
 * the user swiped it away. An empty body is the current card, ended.
 */
export function parseCardEnd(body: string): { token: string | null; dismissed: boolean } | null {
  if (body.trim() === '') return { token: null, dismissed: false };
  const o = jsonObject(body);
  if (!o || !onlyKeys(o, ['activityToken', 'dismissed'])) return null;
  const token = orNull(o.activityToken, isToken);
  const dismissed = o.dismissed ?? false;
  if (token === undefined || typeof dismissed !== 'boolean') return null;
  return { token, dismissed };
}

const BEARER = /^Bearer ([A-Za-z0-9_-]{43})$/;

/** The relay token in `Bearer <43 characters of unpadded base64url>`, or null. */
export function parseBearer(h: string | null): Uint8Array | null {
  const m = h === null ? null : BEARER.exec(h);
  if (!m) return null;
  const out = Uint8Array.from(atob(m[1].replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  return out.length === TOKEN_BYTES ? out : null;
}

/** The major version of `major.minor[.patch]`, 0 when unknown. */
export function iosMajor(v: string | null): number {
  return v ? Number.parseInt(v, 10) || 0 : 0;
}
