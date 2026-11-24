// Live cards (iOS Live Activities) away from home: the board's LIVE gives one sealed live record per
// phone; the relay turns each into an APNs `liveactivity` request to that phone's card (its update
// token) or, when the phone has no card, a push-to-start (its start token). The relay keeps each
// phone's last blob, so it can say "lost contact" and renew a card at 8 hours on its own.

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
/** The stale time when the board gives none. */
const DEFAULT_STALE_S = 360;
const IOS_INPUT_PUSH_TOKEN = 18;
/** The card's ActivityKit attributes type, and the app's localized texts for a new and a renewed card. */
const ATTRIBUTES_TYPE = 'HeaterActivityAttributes';
const STARTED_KEY = 'card.started';
const RENEWED_KEY = 'card.renewed';

type RelayNote = { lostAt: number } | { renewed: true };

/** What the card's content state holds when it comes from the relay (`LiveContent` in the app). */
function contentState(blob: Uint8Array | null, event: number, card: number | null, relay?: RelayNote): ApnsPayload {
  return {
    v: 1,
    ...(blob ? { sealed: base64(blob), e: event } : {}),
    ...(card === null ? {} : { card }),
    via: 'internet',
    ...(relay ? { relay } : {}),
  };
}

/** The requests for one LIVE: per slot the board sealed a record for and that has a registration. */
export function liveRequests(l: Live, rows: Registration[], boardId: string, nowS: number): Send[] {
  const out: Send[] = [];
  const bySlot = new Map(rows.map((r) => [r.slot, r]));
  const staleS = l.staleS || DEFAULT_STALE_S;
  const priority = l.important || l.event !== LiveEvent.update ? 10 : 5;
  for (const [slot, blob] of l.blobs) {
    const r = bySlot.get(slot);
    if (!r) continue;
    const content = contentState(blob, l.event, r.activity_started);
    const start = (relay?: { renewed: true }): Send => ({
      slot,
      kind: 'start',
      event: 'start',
      item: startItem(r, contentState(blob, l.event, nowS, relay), boardId, nowS, staleS),
      after: 'started',
      run: l.run,
    });
    if (l.event === LiveEvent.end) {
      if (r.activity_token) out.push(end(r, content, nowS, l.dismissalS));
    } else if (!r.activity_token) {
      // No card: start one, unless this phone started the run (its app made its own card), or was
      // already sent a start or swiped its card away in this run.
      if (r.start_token && slot !== l.starter && r.no_start_run !== l.run) out.push(start());
    } else if (r.start_token && r.activity_started !== null && nowS >= r.activity_started + RENEW_AFTER_S) {
      // A renewal: the new card, and once APNs took it the old one goes at once.
      out.push({ ...start({ renewed: true }), next: end(r, content, nowS, 0) });
    } else {
      out.push({ slot, kind: 'activity', event: 'update', item: updateItem(r, content, nowS, staleS, priority) });
    }
  }
  return out;
}

/**
 * The board has been away since `lostAt`: per slot with a card, an update saying so, or (`ended`)
 * the card's end, with the last record the board sealed for that phone.
 */
export function lostContactRequests(rows: Registration[], lostAt: number, nowS: number, ended: boolean): Send[] {
  return rows
    .filter((r) => r.activity_token)
    .map((r) => {
      const content = contentState(lastBlob(r), r.live_event ?? LiveEvent.update, r.activity_started, { lostAt });
      return ended
        ? end(r, content, nowS, LOST_DISMISSAL_S)
        : { slot: r.slot, kind: 'activity', event: 'update', item: updateItem(r, content, nowS, 0, 10) };
    });
}

/** The end for a card whose token came after its run ended: kept until the run's own dismissal. */
export function lateEndRequest(r: Registration, nowS: number, untilS: number): Send {
  return end(r, contentState(lastBlob(r), r.live_event ?? LiveEvent.end, r.activity_started), nowS, Math.max(0, untilS - nowS));
}

function lastBlob(r: Registration): Uint8Array | null {
  return r.live_blob ? new Uint8Array(r.live_blob) : null;
}

function end(r: Registration, content: ApnsPayload, nowS: number, dismissalS: number): Send {
  const aps = { timestamp: nowS, event: LIVE_EVENT_NAMES[LiveEvent.end], 'content-state': content, 'dismissal-date': nowS + dismissalS };
  return { slot: r.slot, kind: 'activity', event: 'end', item: item(r, r.activity_token!, 10, nowS + END_EXPIRY_S, aps), after: 'forgetCard' };
}

function updateItem(r: Registration, content: ApnsPayload, nowS: number, staleS: number, priority: 5 | 10): ApnsItem {
  const aps = { timestamp: nowS, event: LIVE_EVENT_NAMES[LiveEvent.update], 'content-state': content, 'stale-date': nowS + staleS };
  return item(r, r.activity_token!, priority, nowS + Math.max(staleS, 60), aps);
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
  return item(r, r.start_token!, 10, nowS + Math.max(staleS, 60), aps);
}

function item(r: Registration, token: string, priority: 5 | 10, expiration: number, aps: ApnsPayload): ApnsItem {
  return { env: r.env, token, pushType: 'liveactivity', priority, expiration, payload: { aps } };
}
