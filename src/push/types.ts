// What the relay hands the APNs sender: one item per phone, already shaped as Apple wants it.

import type { ApnsEnv } from './registry';

/** The JSON body of one APNs request. */
export type ApnsPayload = Record<string, unknown>;

export interface ApnsItem {
  env: ApnsEnv;
  /** The device token, lowercase hex. */
  device: string;
  /** `apns-priority`: 10 at once, 5 when convenient for the phone. */
  priority: 5 | 10;
  /** `apns-expiration`, UTC seconds. */
  expiration: number;
  payload: ApnsPayload;
}

/** `gone`: APNs said the token is dead (410, BadDeviceToken, DeviceTokenNotForTopic): forget it. */
export type ApnsOutcome = 'sent' | 'gone' | 'failed';

/** Sends the items; answers one outcome per item, in order. */
export type PushSend = (items: ApnsItem[]) => Promise<ApnsOutcome[]>;
