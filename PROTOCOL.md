# Relay protocol

What the relay speaks with boards and phones. The app protocol inside the frames is the
firmware's ([flamekeeper-heater/firmware](https://github.com/flamekeeper-heater/firmware),
PROTOCOL.md); the relay never reads it.

## Connections

| Path | Who |
|---|---|
| `wss://<host>/v1/board/<id>` | the board |
| `wss://<host>/v1/app/<id>` | a phone |
| `PUT`, `DELETE https://<host>/v1/app/<id>/push` | a phone's push registration |
| `POST https://<host>/v1/app/<id>/push/activity/end` | a phone's live card ended |

WebSocket subprotocol `flamekeeper-relay.v1`. Plain `ws://` is refused (403) except on
`localhost`, `127.0.0.1` and `[::1]`.

**Board id:** the first 16 bytes of SHA-256 of the board's uncompressed P-256 public key (65 bytes),
as 26 lowercase RFC 4648 base32 characters without padding.

**Relay token:** each phone has `T = HKDF-SHA256(key = its Wi-Fi key secret, salt = empty,
info = "fk1 relay")`, 32 bytes. The board tells the relay `SHA-256(T)` per phone; the relay never
learns T until the phone presents it.

## Messages

Every message is binary: u8 channel, then the content. Channel 0 is the board and the relay;
channels 1-3 are one phone each. Numbers are little-endian. The one text message is the keepalive:
the relay answers the text `ping` with the text `pong`, on any socket, signed in or not.

| Message | Bytes |
|---|---|
| CHALLENGE relay → board | `00 01` ‖ 32 random bytes |
| AUTH board → relay | `00 02` ‖ public key (65, uncompressed) ‖ signature r ‖ s (64, not DER) ‖ u8 n ‖ firmware version (n ≤ 32, UTF-8) |
| signed bytes (ECDSA P-256, SHA-256) | `"fk1 relay board"` ‖ challenge ‖ u8 host length ‖ host (as the board dialled it, with `:port` if any) ‖ u8 n ‖ firmware version |
| ROSTER board → relay | `00 03` ‖ u8 format 1 ‖ n × (u8 slot 0-7, SHA-256(T) 32 bytes); n ≤ 8, slots unique; replaces the stored roster |
| OPEN relay → board | `00 04` ‖ u8 channel 1-3 ‖ u8 slot |
| CLOSE both ways | `00 05` ‖ u8 channel ‖ u16 close code |
| PUSH board → relay | `00 06` ‖ u8 class 0-3 ‖ u8 n ≤ 8 ‖ n × (u8 slot 0-7, u8 length ≥ 28, blob); slots unique |
| LIVE board → relay | `00 07` ‖ u8 event (0 start, 1 update, 2 end) ‖ u8 flags (bit 0 important, bit 1 fault end) ‖ u16 stale s ‖ u16 dismissal s ‖ u8 starter slot (0xFF none) ‖ u32 run id (never 0, the same for every LIVE of one run, another for the next run) ‖ u8 slots (a bit per slot: the phones this LIVE is for) ‖ the record (1-64 bytes, not sealed; the relay does not read it). The starter slot is not used by the relay |
| WANT relay → board | `00 08` ‖ u8 slots with a device token ‖ u8 slots with a live card ‖ u8 slots with a push-to-start token; a bit per slot |
| app frame | u8 channel 1-3 ‖ the app protocol frame, unchanged |

**Board:** the relay sends CHALLENGE; the board answers AUTH within 10 s (the key must hash to the
id, the signature must cover this connection's challenge and host), then sends ROSTER. The relay
answers AUTH and every ROSTER with WANT, and sends WANT again whenever the registered slots change.
A newer board socket that signs in replaces the older one. Once signed in, the board sends `ping`
at least every 45 s; a board the relay has not heard a `ping` from for 120 s (from its sign-in, then
from its last one) is taken as gone: closed with 1001, last seen at its last `ping`.

**Phone:** its first message is its 32-byte token T, within 10 s. If SHA-256(T) is in the roster
and the board is online, the phone gets a channel and the board gets OPEN. A phone that reconnects
from the same slot takes its channel over (the board gets CLOSE, then OPEN).

**Frames:** a phone's frame goes to the board with its channel byte in front; the board's frame for
channel 1-3 goes to that phone without it. A CLOSE from the board closes that phone with the
board's code when it is 1000, 1008 or 4000-4999, else 1000; when the relay closes a phone itself,
the board gets CLOSE with the same code (1000 when the phone closed).

## Close codes

| Code | To | When |
|---|---|---|
| 1001 | board | silent: no `ping` for 120 s |
| 1003 | board, app | a text message other than `ping` |
| 1008 | board, app | policy: a malformed ROSTER or CLOSE; a first app message that is not 32 bytes, or 10 s without a token |
| 1009 | board, app | a message over the size limit |
| 4001 | board, app | replaced by a newer socket (the board's, or the same phone slot's) |
| 4002 | board | sign-in failed: bad AUTH, id, signature or host, or 10 s without AUTH |
| 4003 | app | not paired: the token is not in the roster |
| 4004 | app | heater offline; reason `offline <UTC seconds last seen>` (`offline 0`: never seen) |
| 4005 | app | full: three channels in use by other phones |
| 4006 | app | the board signed in again on a newer socket: connect again at once |

## Limits

| Limit | Value |
|---|---|
| Connects per client address (IPv6 by its /64) | 20 board and 60 app a minute, then 429 |
| Sockets per board | one board; three phones, one per roster slot |
| Message size | 2048 bytes from the board, 2047 from a phone |
| PUSH | 20 a minute per board, then dropped; class 3 is never limited |
| Stored state | deleted with the board after 90 days unseen |

## Push registrations

```
PUT    /v1/app/<id>/push                 Authorization: Bearer <base64url of T, no padding>
DELETE /v1/app/<id>/push                 the same header, no body
POST   /v1/app/<id>/push/activity/end    the same header
```

The PUT body is a JSON object of at most 1024 bytes with only these keys. It **replaces** the
slot's registration: a key left out (or `null`) is unset. `env` and at least one of the three
tokens are required; to remove everything, DELETE.

| Key | Value |
|---|---|
| `env` | `"sandbox"` or `"production"` |
| `device` | the APNs device token (alerts), lowercase hex of 32-100 bytes |
| `offlineAfter` | minutes before a "heater offline" push: 0 (off, the default), 30, 60, 180, 720 or 1440 |
| `startToken` | the Live Activity push-to-start token (iOS 17.2+), hex as `device` |
| `activityToken` | the update token of the phone's current card for this board, hex as `device` |
| `activityStartedAt` | when that card started, UTC seconds; ignored without `activityToken` |
| `iosVersion` | `major.minor[.patch]` |

The POST says the phone's card ended. Its body is empty (the current card ended) or
`{"activityToken": <the card's update token>, "dismissed": <true when the user swiped it away>}`,
both optional. The card's token is dropped if it is still the registered one; `dismissed` also
stops push-to-start to that phone for the rest of the run.

Answers: 204 stored or deleted; 400 bad body; 401 token not in the roster; 405 other method; 413
body too large; 501 `push not available` (a relay without APNs secrets).

## Push notifications

The board encrypts one blob per phone; the relay adds that phone's device token and sends it to
APNs. Every request has `apns-push-type: alert`, `apns-expiration` now + 24 h, `apns-topic` the
`BUNDLE_ID` var, title "Flamekeeper", `mutable-content: 1` and `thread-id` the board id. The custom
key `fk` is `{v: 1, b: <board id>, d: <blob, base64>}` for a PUSH; the app's extension decrypts the
blob and replaces the fixed text.

| Class | APNs priority | Interruption level | Sound | Fixed text |
|---|---|---|---|---|
| 3 alarm | 10 | time-sensitive; critical when `CRITICAL_ALERTS` is `"1"` | `default` (critical: volume 1) | Heater alarm. Open Flamekeeper now. |
| 2 urgent | 10 | time-sensitive | `default` | A heater needs you. Open Flamekeeper. |
| 1 notice | 10 | active | `default` | Heater alert. Open Flamekeeper. |
| 0 quiet | 5 | passive | none | Heater update. |
| offline | 10 | active | `default` | A heater is offline. Open Flamekeeper. |

The relay sends the last one itself, once per absence, when a registration's `offlineAfter` has
passed since the board was last seen. Its `fk` is `{v: 1, b, k: "offline", t: <UTC seconds last
seen>}`, not encrypted, and it carries `apns-collapse-id: <board id>-offline`. APNs tokens reported
dead (410, `BadDeviceToken`, `DeviceTokenNotForTopic`) are deleted.

## Live cards

The board sends one plain live record, the same for every phone, in a LIVE on a run's start, its
changes (a heartbeat every 120 s) and its end, each with the run's id and the slots of the phones
it is for. The relay forwards every LIVE it gets (the board paces them) and starts every card: per
registered phone in the slots, an APNs request with `apns-push-type: liveactivity` and topic
`BUNDLE_ID` + `.push-type.liveactivity`. It keeps the board's last record for lost contact and a
late end:

| Case | APNs event | To |
|---|---|---|
| start or update, the phone has a card | `update` | its card's token |
| start or update, no card | `start` (push-to-start) | its start token; not to a phone that swiped its card away in this run, and once per run |
| end | `end`, `dismissal-date` now + the board's dismissal s; the card's token is then dropped | its card's token |
| a card token registered after its run ended, for a card that started before the end | `end` at once, `dismissal-date` the run's | that token |
| an update 7 h 45 min after the card started | `start` with `relay.renewed`; once APNs took it, `end` (dismissal now) to the old card | start token, card token |
| board away 10 min | `update` with `relay.lostAt` (when the board was last seen) and the last record | card tokens |
| board away 60 min | `end`, dismissal 900 s, then the tokens are dropped | card tokens |

`aps`: `timestamp` (now), `event`, `content-state`, `stale-date` (now + the board's stale s) for
start and update; a push-to-start adds `attributes-type: "HeaterActivityAttributes"`, `attributes:
{board: <board id>}`, `alert: {title: "Flamekeeper", body: {loc-key: "card.started"}}` (no sound;
`card.renewed` for a renewal)
and, for iOS 18 or later, `input-push-token: 1`. Priority 10 for start, end and important updates,
else 5. The content state is `{v: 2, record: <the record, base64>, card: <the card's start, UTC s>,
relay?: {lostAt} | {renewed: true}}`.

## Test vectors

The firmware and the app test against the same values.

| | Hex |
|---|---|
| public key (the P-256 generator G) | `046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5` |
| its board id | `698bea63dc44a344663ff1429aea1084` = `ngf6uy64isruizr76fbjv2qqqq` |
| Wi-Fi key secret | `09` × 32 |
| relay token T | `16c1df6a87aaeae336a68c3cb93442b2246922a2edaee096e2439ee205578c0a` |
| SHA-256(T) | `d91429cfba5c46b38cfeb129eb4f263b616323ad4d7c20aeb3430d641258e834` |
| signed bytes (challenge `01` × 32, host `relay.flamekeeper.app`, version `1.4.0`) | `666b312072656c617920626f61726401010101010101010101010101010101010101010101010101010101010101011572656c61792e666c616d656b65657065722e61707005312e342e30` |
| ROSTER (slot 2) | `00030102d91429cfba5c46b38cfeb129eb4f263b616323ad4d7c20aeb3430d641258e834` |
| WANT (slot 2 in every mask) | `0008040404` |
| LIVE start (slot 2, starter 2, run 42, stale 360, the record `d0`…`f0`, 33 bytes) | `0007000168010000022a00000004d0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeeff0` |
| LIVE update | `0007010068010000022a00000004d0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeeff0` |
| LIVE end (fault end, dismissal 900) | `0007020368018403022a00000004d0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeeff0` |
| PUSH (class 1, slot 2) | `000601010253c0c1c2c3c4c5c6c7c8c9cacb4876b3e19822be890adb585de818669c2c976e95c2954fd98602d395ed91fa37070d498a90e599316ce1c94aa597c5658e883dca81b7903a416591331330ae3f75cf565b785d73` |
