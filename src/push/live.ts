// Live cards (iOS Live Activities): the board's LIVE gives one plain live record and the phones it is
// for; the relay turns it into an APNs `liveactivity` request per phone, to its card (its update
// token) or, when the phone has no card, a push-to-start (its start token). The relay starts every
// card, and keeps the board's last record so it can say "lost contact" and renew a card at 8 hours.

import { base64 } from '../bytes';
import { LIVE_EVENT_NAMES, type Live, LiveEvent } from '../wire';
import { TITLE } from './apnsMessage';
import { iosMajor } from './registry';
import type { ApnsItem, ApnsPayload, Registration, Send } from './types';

/** A card is renewed on the first update after 7 h 45 min (iOS ends a Live Activity at 8 h). */
export const RENEW_AFTER_S = 27_900;
/** A board with live cards away this long: an update saying so (`relay.lostAt`). */
export const LOST_UPDATE_S = 600;
/** ... and this long: the cards end, kept on the Lock Screen for `LOST_DISMISSAL_S`. */
export const LOST_END_S = 3600;
const LOST_DISMISSAL_S = 900;
/** How long APNs keeps an end for a phone that is off; starts and updates keep until they would be stale. */
const END_EXPIRY_S = 8 * 3600;
/** A start or an update goes grey this long after it was sent. */
const STALE_S = 360;
/** How long a run's final card stays on the Lock Screen: longer after a fault or an alert. */
const END_DISMISSAL_S = 300;
const FAULT_END_DISMISSAL_S = 900;

/** The final card's dismissal for a LIVE end. */
export function endDismissalS(l: Live): number {
  return l.faultEnd ? FAULT_END_DISMISSAL_S : END_DISMISSAL_S;
}
const IOS_INPUT_PUSH_TOKEN = 18;
/** The card's ActivityKit attributes type, and the app's localized texts for a new and a renewed card. */
const ATTRIBUTES_TYPE = 'HeaterActivityAttributes';
const STARTED_KEY = 'card.started';
const RENEWED_KEY = 'card.renewed';

type RelayNote = { lostAt: number } | { renewed: true };

/** The card's content state (`LiveContent` in the app): the record, the card's start, the relay's note. */
function contentState(record: Uint8Array, card: number | null, relay?: RelayNote): ApnsPayload {
  return { record: base64(record), ...(card === null ? {} : { card }), ...(relay ? { relay } : {}) };
}

/** The requests for one LIVE: per registered phone it is for. */
export function liveRequests(l: Live, rows: Registration[], boardId: string, nowS: number): Send[] {
  const out: Send[] = [];
  const priority = l.important || l.event !== LiveEvent.update ? 10 : 5;
  for (const r of rows) {
    const slot = r.slot;
    if (!(l.slots & (1 << slot))) continue;
    const content = contentState(l.record, r.activity_started);
    const start = (relay?: { renewed: true }): Send => ({
      slot,
      kind: 'start',
      event: 'start',
      item: startItem(r, contentState(l.record, nowS, relay), boardId, nowS, STALE_S),
      after: 'started',
      run: l.run,
    });
    if (l.event === LiveEvent.end) {
      if (r.activity_token) out.push(end(r, content, nowS, endDismissalS(l)));
    } else if (!r.activity_token) {
      // No card: start one, unless this phone was already sent a start or swiped its card away in this run.
      if (r.start_token && r.no_start_run !== l.run) out.push(start());
    } else if (r.start_token && r.activity_started !== null && nowS >= r.activity_started + RENEW_AFTER_S) {
      // A renewal: the new card, and once APNs took it the old one goes at once.
      out.push({ ...start({ renewed: true }), next: end(r, content, nowS, 0) });
    } else {
      out.push({ slot, kind: 'activity', event: 'update', item: updateItem(r, content, nowS, STALE_S, priority) });
    }
  }
  return out;
}

/**
 * The board has been away since `lostAt`: per slot with a card, an update saying so, or (`ended`)
 * the card's end, with the board's last record.
 */
export function lostContactRequests(rows: Registration[], record: Uint8Array, lostAt: number, nowS: number, ended: boolean): Send[] {
  return rows
    .filter((r) => r.activity_token)
    .map((r) => {
      const content = contentState(record, r.activity_started, { lostAt });
      return ended
        ? end(r, content, nowS, LOST_DISMISSAL_S)
        : { slot: r.slot, kind: 'activity', event: 'update', item: updateItem(r, content, nowS, 0, 10) };
    });
}

/** The end for a card whose token came after its run ended: kept until the run's own dismissal. */
export function lateEndRequest(r: Registration, record: Uint8Array, nowS: number, untilS: number): Send {
  return end(r, contentState(record, r.activity_started), nowS, Math.max(0, untilS - nowS));
}

function end(r: Registration, content: ApnsPayload, nowS: number, dismissalS: number): Send {
  const aps = { timestamp: nowS, event: LIVE_EVENT_NAMES[LiveEvent.end], 'content-state': content, 'dismissal-date': nowS + dismissalS };
  return { slot: r.slot, kind: 'activity', event: 'end', item: item(r, 'activity', 10, nowS + END_EXPIRY_S, aps), after: 'forgetCard' };
}

function updateItem(r: Registration, content: ApnsPayload, nowS: number, staleS: number, priority: 5 | 10): ApnsItem {
  const aps = { timestamp: nowS, event: LIVE_EVENT_NAMES[LiveEvent.update], 'content-state': content, 'stale-date': nowS + staleS };
  return item(r, 'activity', priority, nowS + Math.max(staleS, 60), aps);
}

function startItem(r: Registration, content: ApnsPayload, boardId: string, nowS: number, staleS: number): ApnsItem {
  const aps: ApnsPayload = {
    timestamp: nowS,
    event: LIVE_EVENT_NAMES[LiveEvent.start],
    'content-state': content,
    'stale-date': nowS + staleS,
    'attributes-type': ATTRIBUTES_TYPE,
    attributes: { board: boardId },
    alert: { title: TITLE, body: { 'loc-key': content.relay ? RENEWED_KEY : STARTED_KEY } },
  };
  // iOS 18 sends the new card's update token back to the app at once.
  if (iosMajor(r.ios) >= IOS_INPUT_PUSH_TOKEN) aps['input-push-token'] = 1;
  return item(r, 'start', 10, nowS + Math.max(staleS, 60), aps);
}

/** A request to the slot's start or card token, in the environment that took that token. */
function item(r: Registration, kind: 'start' | 'activity', priority: 5 | 10, expiration: number, aps: ApnsPayload): ApnsItem {
  const [token, env] = kind === 'start' ? [r.start_token!, r.start_env] : [r.activity_token!, r.activity_env];
  return { env: env ?? r.env, token, pushType: 'liveactivity', priority, expiration, payload: { aps } };
}
