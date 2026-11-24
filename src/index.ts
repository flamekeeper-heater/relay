// The relay's stateless front: checks the path and TLS, counts connects per client address, checks
// the subprotocol, then hands the WebSocket upgrade to the board's Durable Object (one per board id).
// A phone's push registration calls (`/v1/app/<id>/push…`, plain HTTP) go to the same object.

import { BoardRoom } from './boardRoom';
import { PushSender } from './push/pushSender';
import { SUBPROTOCOL, parsePath } from './wire';

export interface Env {
  BOARD: DurableObjectNamespace<BoardRoom>;
  /** The one APNs sender (named "apns"). */
  PUSH: DurableObjectNamespace<PushSender>;
  BOARD_CONNECTS: RateLimit;
  APP_CONNECTS: RateLimit;
  /** PUSH messages per board id. */
  PUSH_RATE: RateLimit;
  /** The app's bundle id, the APNs topic. */
  BUNDLE_ID: string;
  /** "1" once Apple grants the Critical Alerts entitlement: class 3 then goes out critical. */
  CRITICAL_ALERTS?: string;
  /** The APNs signing key (.p8), its key id and the team id: secrets, set only on the official relay. */
  APNS_KEY_P8?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
}

/** Whether this relay can send pushes: only with all three APNs secrets (a self-hosted relay has none). */
export function pushAvailable(env: Env): boolean {
  return !!(env.APNS_KEY_P8 && env.APNS_KEY_ID && env.APNS_TEAM_ID);
}

function offersSubprotocol(request: Request): boolean {
  const offered = request.headers.get('Sec-WebSocket-Protocol') ?? '';
  return offered.split(',').some((p) => p.trim() === SUBPROTOCOL);
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The rate-limit key of a client address: an IPv4 address as is, an IPv6 address by its /64. */
export function limitKey(ip: string): string {
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.split('%')[0].toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return `${groups
    .slice(0, 4)
    .map((g) => (parseInt(g, 16) || 0).toString(16))
    .join(':')}::/64`;
}

export async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = parsePath(url.pathname);
  if (!path) return new Response('Not found', { status: 404 });
  if (url.protocol !== 'https:' && !LOCAL_HOSTS.has(url.hostname)) return new Response('TLS required', { status: 403 });
  const limiter = path.role === 'board' ? env.BOARD_CONNECTS : env.APP_CONNECTS;
  const { success } = await limiter.limit({ key: limitKey(request.headers.get('CF-Connecting-IP') ?? '') });
  if (!success) return new Response('Too many connects', { status: 429 });
  if (path.role === 'board' || path.role === 'app') {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket only', { status: 426, headers: { Upgrade: 'websocket' } });
    }
    if (!offersSubprotocol(request)) return new Response(`Subprotocol ${SUBPROTOCOL} required`, { status: 400 });
  } else if (!pushAvailable(env)) {
    return new Response('push not available', { status: 501 });
  }
  return env.BOARD.getByName(path.id).fetch(request);
}

export default { fetch: handle } satisfies ExportedHandler<Env>;
export { BoardRoom, PushSender };
