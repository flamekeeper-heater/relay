// The APNs request for a push: the class the board gave (the relay never sees the content) picks
// the priority, the interruption level, the sound and a fixed text the phone shows when its
// extension cannot decrypt. The extension replaces the text with the decrypted one.

import { base64 } from '../bytes';
import type { ApnsPayload } from './types';

export const TITLE = 'Flamekeeper';

const FIXED_TEXT = [
  'Heater update.',
  'Heater alert. Open Flamekeeper.',
  'A heater needs you. Open Flamekeeper.',
  'Heater alarm. Open Flamekeeper now.',
] as const;
const OFFLINE_TEXT = 'A heater is offline. Open Flamekeeper.';

/** The interruption level per class: 0 quiet, 1 notice, 2 urgent, 3 alarm. */
const LEVEL = ['passive', 'active', 'time-sensitive', 'time-sensitive'] as const;

const CRITICAL_SOUND = { critical: 1, name: 'default', volume: 1 };

export interface AlertMessage {
  priority: 5 | 10;
  payload: ApnsPayload;
}

/**
 * The APNs request for one phone's blob of a PUSH. Class 3 is a critical alert only when `critical`
 * (Apple granted the entitlement), time-sensitive until then; class 0 makes no sound.
 */
export function apnsForBlob(cls: 0 | 1 | 2 | 3, boardId: string, blob: Uint8Array, critical: boolean): AlertMessage {
  const alarm = cls === 3 && critical;
  const sound = cls === 0 ? undefined : alarm ? CRITICAL_SOUND : 'default';
  return {
    priority: cls === 0 ? 5 : 10,
    payload: { aps: aps(FIXED_TEXT[cls], alarm ? 'critical' : LEVEL[cls], sound, boardId), fk: { v: 1, b: boardId, d: base64(blob) } },
  };
}

/**
 * The push the relay makes itself when the board stays away past a phone's delay (`seenS`: when the
 * board was last seen). Not encrypted: it carries only what the relay knows, the board id and a time.
 */
export function apnsForOffline(boardId: string, seenS: number): AlertMessage {
  return {
    priority: 10,
    payload: { aps: aps(OFFLINE_TEXT, 'active', 'default', boardId), fk: { v: 1, b: boardId, k: 'offline', t: seenS } },
  };
}

function aps(body: string, level: string, sound: unknown, boardId: string): ApnsPayload {
  return {
    alert: { title: TITLE, body },
    'mutable-content': 1,
    'interruption-level': level,
    ...(sound === undefined ? {} : { sound }),
    'thread-id': boardId,
  };
}
