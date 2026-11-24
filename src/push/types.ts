// What the board's room keeps per phone and what it hands the APNs sender.

export type ApnsEnv = 'sandbox' | 'production';
export type PushType = 'alert' | 'liveactivity';

/** The JSON body of one APNs request. */
export type ApnsPayload = Record<string, unknown>;

/** One roster slot's row: what the phone registered, and what the relay remembers of its card. */
export type Registration = {
  slot: number;
  env: ApnsEnv;
  /** The APNs device token (alerts), lowercase hex. */
  device: string | null;
  /** Minutes before a "heater offline" push; 0 off. */
  offline_after: number;
  /** 1 once that push went out in the current absence. */
  offline_sent: number;
  /** The Live Activity push-to-start token. */
  start_token: string | null;
  /** The update token of the phone's current card, and when that card started (UTC seconds). */
  activity_token: string | null;
  activity_started: number | null;
  /**
   * The APNs environment that took the start token or the card token, when it is not `env`: iOS may
   * hand a development build the Live Activity tokens of a production (TestFlight) install.
   */
  start_env: ApnsEnv | null;
  activity_env: ApnsEnv | null;
  /** The phone's iOS version, `major.minor[.patch]`. */
  ios: string | null;
  /** The run in which this phone gets no (further) push-to-start: one was sent, or it swiped its card away. */
  no_start_run: number | null;
};

/** Which of a registration's tokens a push goes to. */
export type TokenKind = 'device' | 'start' | 'activity';

export interface ApnsItem {
  env: ApnsEnv;
  /** The token the push goes to, lowercase hex. */
  token: string;
  pushType: PushType;
  /** `apns-priority`: 10 at once, 5 when convenient for the phone. */
  priority: 5 | 10;
  /** `apns-expiration`, UTC seconds. */
  expiration: number;
  /** `apns-collapse-id`: a later push with the same id replaces this one on the phone. */
  collapseId?: string;
  payload: ApnsPayload;
}

/**
 * One APNs request for a slot: the token it uses (a `gone` answer forgets that one) and what to
 * record once APNs took it: the card is over (`forgetCard`), or a push-to-start went out in `run`
 * (`started`). `next` goes out only after this one was taken (a renewal: the old card's end).
 */
export interface Send {
  slot: number;
  kind: TokenKind;
  /** For the log: `alert`, or the Live Activity event. */
  event: 'alert' | 'start' | 'update' | 'end';
  item: ApnsItem;
  after?: 'forgetCard' | 'started';
  run?: number;
  next?: Send;
}

/** `gone`: APNs said the token is dead (410, BadDeviceToken, DeviceTokenNotForTopic): forget it. */
export type ApnsOutcome = 'sent' | 'gone' | 'failed';

/** Sends the items; answers one outcome per item, in order. */
export type PushSend = (items: ApnsItem[]) => Promise<ApnsOutcome[]>;
