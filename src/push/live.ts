// Live cards (iOS Live Activities) away from home: the board's LIVE gives one sealed live record per
// phone; the relay turns each into an APNs `liveactivity` request to that phone's card (its update
// token) or, when the phone has no card, a push-to-start (its start token). The relay keeps each
// phone's last blob, so it can say "lost contact" and renew a card at 8 hours on its own.

import type { Live } from '../wire';
import { iosMajor, type ApnsEnv } from './registry';
import type { ApnsItem, ApnsPayload } from './types';

/** A card is renewed on the first update after 7 h 45 min (iOS ends a Live Activity at 8 h). */
export const RENEW_AFTER_S = 27_900;
/** A board with live cards away this long: an update saying so (`relay.lostAt`). */
export const LOST_UPDATE_S = 600;
/** ... and this long: the cards end, kept on the Lock Screen for `LOST_DISMISSAL_S`. */
export const LOST_END_S = 3600;
export const LOST_DISMISSAL_S = 900;
/** At most one LIVE per this from a board; an end always passes. */
export const LIVE_INTERVAL_MS = 5_000;
/** How long APNs keeps an end for a phone that is off; starts and updates keep until they would be stale. */
const END_EXPIRY_S = 8 * 3600;
/** The stale time when the board gives none. */
const DEFAULT_STALE_S = 360;
const IOS_INPUT_PUSH_TOKEN = 18;
/** The card's ActivityKit attributes type, and the app's localized "Your heater started". */
const ATTRIBUTES_TYPE = 'HeaterActivityAttributes';
const STARTED_KEY = 'card.started';
const TITLE = 'Flamekeeper';
const EVENT_NAME = ['start', 'update', 'end'] as const;

/** A slot's live card tokens and what the relay remembers of its card. */
export type LiveRow = {
  slot: number;
  env: ApnsEnv;
  start_token: string | null;
  activity_token: string | null;
  /** When the card behind `activity_token` started, UTC seconds. */
  activity_started: number | null;
  ios: string | null;
  /** The run in which the phone swiped its card away (no push-to-start until the next run). */
  dismissed_run: number | null;
  /** The run in which the relay sent this phone a push-to-start (none again in that run). */
  started_run: number | null;
  /** The run in which this phone's card was lost (APNs refused its token): it may be push-started. */
  lost_run: number | null;
  /** The last blob the board sealed for this phone, and its LIVE event. */
  live_blob: ArrayBuffer | null;
  live_event: number | null;
};

/**
 * One APNs request for a slot. `token` says which token it used (a `gone` answer forgets that one);
 * `after` what to record once it is sent: the card is over (`forgetCard`), or a push-to-start went
 * out in this run (`started`).
 */
export interface LiveSend {
  slot: number;
  token: 'start' | 'activity';
  item: ApnsItem;
  after?: 'forgetCard' | 'started';
}

export interface LiveContext {
  relayId: string;
  nowS: number;
  /** The current run's id (the relay's time of its start). */
  run: number;
}

/** What the card's content state holds when it comes from the relay (`LiveContent` in the app). */
export function contentState(blob: Uint8Array | null, event: number, card: number | null, relay?: { lostAt?: number; renewed?: boolean }): ApnsPayload {
  const c: ApnsPayload = { v: 1 };
  if (blob) {
    c.sealed = base64(blob);
    c.e = event;
  }
  if (card !== null) c.card = card;
  c.via = 'internet';
  if (relay) c.relay = relay;
  return c;
}

/** The requests for one LIVE: per slot the board sealed a record for and that has a registration. */
export function liveRequests(l: Live, rows: LiveRow[], o: LiveContext): LiveSend[] {
  const out: LiveSend[] = [];
  const byslot = new Map(rows.map((r) => [r.slot, r]));
  const staleS = l.staleS || DEFAULT_STALE_S;
  const priority: 5 | 10 = l.important || l.event !== 1 ? 10 : 5;
  for (const [slot, blob] of l.blobs) {
    const r = byslot.get(slot);
    if (!r) continue;
    const card = r.activity_token;
    if (l.event === 2) {
      if (card) {
        out.push({
          slot,
          token: 'activity',
          item: endItem(r, card, contentState(blob, l.event, r.activity_started), o.nowS, l.dismissalS),
          after: 'forgetCard',
        });
      }
      continue;
    }
    const renew = card !== null && r.start_token !== null && r.activity_started !== null && o.nowS >= r.activity_started + RENEW_AFTER_S;
    if (card && !renew) {
      out.push({ slot, token: 'activity', item: updateItem(r, card, contentState(blob, l.event, r.activity_started), o.nowS, staleS, priority) });
      continue;
    }
    if (renew) {
      // The new card first, so the phone never shows none; then the old one goes at once.
      out.push({ slot, token: 'start', item: startItem(r, blob, l.event, o, staleS, { renewed: true }), after: 'started' });
      out.push({ slot, token: 'activity', item: endItem(r, card!, contentState(blob, l.event, r.activity_started), o.nowS, 0), after: 'forgetCard' });
      continue;
    }
    // No card: start one, unless this phone started the run (its app made its own card, unless that
    // card was lost since), swiped the card away in this run, or was already sent a start in this run.
    const ownCard = slot === l.starter && r.lost_run !== o.run;
    if (r.start_token && !ownCard && r.dismissed_run !== o.run && r.started_run !== o.run) {
      out.push({ slot, token: 'start', item: startItem(r, blob, l.event, o, staleS), after: 'started' });
    }
  }
  return out;
}

/**
 * The board has been away: per slot with a card, an update saying so (`end` false) or the card's
 * end (`end` true), with the last record the board sealed for that phone.
 */
export function lostContactRequests(rows: LiveRow[], lostAt: number, nowS: number, end: boolean): LiveSend[] {
  const out: LiveSend[] = [];
  for (const r of rows) {
    if (!r.activity_token) continue;
    const blob = r.live_blob ? new Uint8Array(r.live_blob) : null;
    const content = contentState(blob, r.live_event ?? 1, r.activity_started, { lostAt });
    out.push(
      end
        ? { slot: r.slot, token: 'activity', item: endItem(r, r.activity_token, content, nowS, LOST_DISMISSAL_S), after: 'forgetCard' }
        : { slot: r.slot, token: 'activity', item: updateItem(r, r.activity_token, content, nowS, 0, 10) },
    );
  }
  return out;
}

/** The end for a card whose token came after its run ended: kept until the run's own dismissal. */
export function lateEndRequest(r: LiveRow, nowS: number, untilS: number): LiveSend {
  const blob = r.live_blob ? new Uint8Array(r.live_blob) : null;
  const content = contentState(blob, r.live_event ?? 2, r.activity_started);
  return { slot: r.slot, token: 'activity', item: endItem(r, r.activity_token!, content, nowS, Math.max(0, untilS - nowS)), after: 'forgetCard' };
}

function updateItem(r: LiveRow, token: string, content: ApnsPayload, nowS: number, staleS: number, priority: 5 | 10): ApnsItem {
  return item(r, token, priority, nowS + Math.max(staleS, 60), {
    timestamp: nowS,
    event: EVENT_NAME[1],
    'content-state': content,
    'stale-date': nowS + staleS,
  });
}

function endItem(r: LiveRow, token: string, content: ApnsPayload, nowS: number, dismissalS: number): ApnsItem {
  return item(r, token, 10, nowS + END_EXPIRY_S, {
    timestamp: nowS,
    event: EVENT_NAME[2],
    'content-state': content,
    'dismissal-date': nowS + dismissalS,
  });
}

function startItem(r: LiveRow, blob: Uint8Array, event: number, o: LiveContext, staleS: number, relay?: { renewed: true }): ApnsItem {
  const aps: ApnsPayload = {
    timestamp: o.nowS,
    event: EVENT_NAME[0],
    'content-state': contentState(blob, event, o.nowS, relay),
    'stale-date': o.nowS + staleS,
    'attributes-type': ATTRIBUTES_TYPE,
    attributes: { board: o.relayId },
    alert: { title: TITLE, body: { 'loc-key': STARTED_KEY } },
  };
  // iOS 18 sends the new card's update token back to the app at once.
  if (iosMajor(r.ios) >= IOS_INPUT_PUSH_TOKEN) aps['input-push-token'] = 1;
  return item(r, r.start_token!, 10, o.nowS + Math.max(staleS, 60), aps);
}

function item(r: LiveRow, token: string, priority: 5 | 10, expiration: number, aps: ApnsPayload): ApnsItem {
  return { env: r.env, device: token, pushType: 'liveactivity', priority, expiration, payload: { aps } };
}

function base64(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}
