# Flamekeeper relay

The internet relay for the **Flamekeeper ECU**, a replacement controller board for diesel air
heaters ([firmware](https://github.com/flamekeeper-heater/firmware)). It lets the Flamekeeper app
reach a heater from anywhere, without opening a port on the heater's network. The official relay
runs at `relay.flamekeeper.app`; you can run your own.

## How it works

The relay is a Cloudflare Worker with one Durable Object per board. A board with the relay switched
on (it is off until the user turns it on in the app) keeps one outbound WebSocket to it and signs in
with its own key. A paired phone away from home opens another WebSocket to the same board's room,
and the relay copies frames between them.

The frames are the app protocol's, encrypted end to end between the phone and the board. The relay
cannot read them or send commands. It knows a board by its public key and admits a phone only if
the phone presents a token whose hash the board has listed; the token comes from the phone's own
Wi-Fi key, so nothing new is exchanged when pairing.

For push notifications the board decides what to send, filters it per phone and encrypts one blob
per phone. The relay adds the phone's device token and hands the request to Apple's push service
(APNs). It also tells phones, if they asked, when their heater has been offline for a while.

What the relay keeps: per board, the list of phone token hashes, when it was last seen, and the
phones' push registrations; all of it is deleted after 90 days without the board. Its logs carry
board ids, events and counts, never frames, tokens or client addresses.

[PROTOCOL.md](PROTOCOL.md) has the wire format.

## Tests

You need Node.js 22.12 or newer.

```bash
npm ci
npm test            # runs in the Workers runtime (@cloudflare/vitest-plugin)
npm run typecheck
```

`npm run dev` serves the relay at `http://localhost:8787`.

## Run your own

You need a Cloudflare account with a domain on it.

1. In `wrangler.jsonc`, set `routes` to your own host (for example `relay.example.com`) and delete
   the `test` environment, or point its route at a second host. If the `namespace_id`s of the
   rate limits clash with another Worker in your account, change them.
2. Deploy:

   ```bash
   npx wrangler login
   npx wrangler deploy
   ```

   The first deploy creates the custom domain's DNS record.
3. In the app, set Settings, "Relay server" to your host.

That gives remote control. **Push notifications are optional:** they need an Apple developer
account and the app's bundle id (`BUNDLE_ID` in `wrangler.jsonc`), so the official app's
notifications only work through the official relay. Without the three APNs secrets the relay
answers push registrations with 503 `push not available`, and the app shows that notifications
need the official relay. To set them:

```bash
npx wrangler secret put APNS_KEY_P8     # the .p8 key file's contents
npx wrangler secret put APNS_KEY_ID     # its 10-character key id
npx wrangler secret put APNS_TEAM_ID    # your team id
```

> **Status:** the APNs sender is not written yet, so even with the secrets set every push is logged
> `push not available`.

**Trying a board against a local relay:** a board connects only over TLS, so expose
`npm run dev` through a Cloudflare quick tunnel (`cloudflared tunnel --url http://localhost:8787`),
then restart the relay with `npx wrangler dev --local-upstream <tunnel host>` so it checks the host
the board signs, and set the tunnel host as the board's relay server in the app.

## License

[GNU Affero General Public License v3.0](LICENSE).
