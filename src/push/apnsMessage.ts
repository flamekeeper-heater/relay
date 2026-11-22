// The APNs request for a push: the class the board gave (the relay never sees the content) picks
// the priority, the interruption level, the sound and a fixed text the phone shows when its
// extension cannot decrypt. The extension replaces the text with the decrypted one.

import type { ApnsPayload } from './types';

export const TITLE = 'Flamekeeper';

export const FIXED_TEXT: Record<0 | 1 | 2 | 3 | 'offline' | 'online', string> = {
  3: 'Heater alarm. Open Flamekeeper now.',
  2: 'A heater needs you. Open Flamekeeper.',
  1: 'Heater alert. Open Flamekeeper.',
  0: 'Heater update.',
  offline: 'A heater is offline. Open Flamekeeper.',
  online: 'A heater is back online.',
};

/** The interruption level per class: 3 alarm, 2 urgent, 1 notice, 0 quiet. */
const LEVEL = ['passive', 'active', 'time-sensitive', 'time-sensitive'] as const;

const CRITICAL_SOUND = { critical: 1, name: 'default', volume: 1 };

/**
 * The APNs request for one phone's blob of a PUSH. Class 3 is a critical alert only when `critical`
 * (Apple granted the entitlement), time-sensitive until then; class 0 makes no sound.
 */
export function apnsForBlob(cls: number, boardId: string, blob: Uint8Array, critical: boolean): { priority: 5 | 10; payload: ApnsPayload } {
  const c = Math.min(Math.max(cls, 0), 3) as 0 | 1 | 2 | 3;
  const alarm = c === 3 && critical;
  return {
    priority: c === 0 ? 5 : 10,
    payload: {
      aps: aps(FIXED_TEXT[c], alarm ? 'critical' : LEVEL[c], c === 0 ? undefined : alarm ? CRITICAL_SOUND : 'default', boardId),
      fk: { v: 1, b: boardId, d: base64(blob) },
    },
  };
}

function aps(body: string, level: string, sound: unknown, boardId: string): Record<string, unknown> {
  const a: Record<string, unknown> = {
    alert: { title: TITLE, body },
    'mutable-content': 1,
    'interruption-level': level,
  };
  if (sound !== undefined) a.sound = sound;
  a['thread-id'] = boardId;
  return a;
}

function base64(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

/**
 * A push the relay makes itself when the board stays away past a phone's delay (`offline`, `t` the
 * board's last-seen time) and when it comes back after that (`online`, `t` now). Not encrypted:
 * it carries only what the relay knows, the board id and a time.
 */
export function apnsForPresence(kind: 'offline' | 'online', boardId: string, utcS: number): { priority: 10 | 5; payload: ApnsPayload } {
  const offline = kind === 'offline';
  return {
    priority: offline ? 10 : 5,
    payload: {
      aps: aps(FIXED_TEXT[kind], offline ? LEVEL[1] : LEVEL[0], offline ? 'default' : undefined, boardId),
      fk: { v: 1, b: boardId, k: kind, t: utcS },
    },
  };
}
