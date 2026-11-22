# Agent notes

The Flamekeeper internet relay: a Cloudflare Worker (`src/index.ts`) and one Durable Object per
board (`src/boardRoom.ts`). Read [README.md](README.md) for what it does and
[PROTOCOL.md](PROTOCOL.md) for the wire format.

## Commands

```bash
npm ci
npm test && npm run typecheck     # after every change
npm run types                     # after changing wrangler.jsonc
npx wrangler deploy --dry-run     # checks the bundle; deploys nothing
```

## Rules

- **The relay never reads what it forwards.** Frames on channels 1-3 pass through unchanged. Do not
  parse, store or log them.
- **Logs carry board ids, events, close codes and counts only.** Never frames, tokens, blobs,
  device tokens or client addresses. Invocation logs stay off in `wrangler.jsonc`.
- **The wire format is shared** with the firmware and the app. A change to a message, close code,
  limit or test vector in PROTOCOL.md is a protocol change: update PROTOCOL.md and the tests
  together, and say so in the commit message. Until the app's first release, protocols change in
  place, without version bumps or compatibility shims.
- **Never deploy** (`wrangler deploy` or `wrangler secret put`) unless you are asked to: the routes
  in `wrangler.jsonc` are the official relay's.
- **No secrets in the repository.** APNs keys are Worker secrets; local ones go in `.dev.vars`,
  which git ignores.
- **Docs stay short.** README.md for people running the relay, PROTOCOL.md for the wire format. The
  code and its tests carry the details.
