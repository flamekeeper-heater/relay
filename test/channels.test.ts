import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { BURST, type BoardRoom, RATE_PER_S, freshMemory } from '../src/boardRoom';
import { Close, encodeClose } from '../src/wire';
import { concat, sha256, toHex } from './bytes';
import { type FakeAppSocket, type FakeBoardSocket, attachments, fakeApp, fakeBoard, room, rows, setClock } from './fakes';

interface Room {
  board: FakeBoardSocket;
  tokens: Uint8Array[];
}

/** A signed-in board whose roster has slots 0-7, one random token each. */
async function boardRoom(): Promise<Room> {
  const tokens = Array.from({ length: 8 }, () => crypto.getRandomValues(new Uint8Array(32)));
  const board = await fakeBoard();
  await board.signIn();
  board.roster(await Promise.all(tokens.map(async (t, slot) => [slot, await sha256(t)] as [number, Uint8Array])));
  expect(toHex(await board.next())).toBe('00080000'); // WANT, after the roster is stored
  expect((await rows(board.id, 'roster')).length).toBe(8);
  return { board, tokens };
}

/** A phone on `slot` that the relay admitted on `channel`. */
async function phone(r: Room, slot: number, channel: number): Promise<FakeAppSocket> {
  const app = await fakeApp(r.board.id, r.tokens[slot]);
  expect(toHex(await r.board.next())).toBe(toHex(new Uint8Array([0, 4, channel, slot])));
  return app;
}

function bytes(n: number, fill = 0x5a): Uint8Array {
  return new Uint8Array(n).fill(fill);
}

describe('channels', () => {
  it("forwards a phone's frame to the board with its channel byte and the board's back without it", async () => {
    const r = await boardRoom();
    await phone(r, 0, 1);
    const app = await phone(r, 3, 2);
    app.send(new Uint8Array([0x05, 0xaa, 0xbb]));
    expect(toHex(await r.board.next())).toBe('0205aabb');
    r.board.send(new Uint8Array([2, 0x01, 0x02, 0x03]));
    expect(toHex(await app.next())).toBe('010203');
  });

  it('forwards a frame the phone sends right behind its token', async () => {
    const r = await boardRoom();
    const app = await fakeApp(r.board.id, r.tokens[1]);
    app.send(new Uint8Array([0x07, 0x01]));
    expect(toHex(await r.board.next())).toBe('00040101');
    expect(toHex(await r.board.next())).toBe('010701');
    expect(await app.quiet()).toBe(true);
  });

  it('gives three phones channels 1, 2 and 3 and refuses a fourth slot with 4005', async () => {
    const r = await boardRoom();
    await phone(r, 5, 1);
    await phone(r, 6, 2);
    await phone(r, 7, 3);
    const fourth = await fakeApp(r.board.id, r.tokens[0]);
    expect(await fourth.closed).toEqual({ code: Close.full, reason: 'full' });
    expect(await r.board.quiet()).toBe(true);
  });

  it('a new socket from the same slot takes over its channel', async () => {
    const r = await boardRoom();
    const old = await phone(r, 4, 1);
    await phone(r, 5, 2);
    await phone(r, 6, 3);
    // The phone moved from Wi-Fi to cellular; its old socket is still open on the relay.
    const fresh = await fakeApp(r.board.id, r.tokens[4]);
    expect((await old.closed).code).toBe(Close.replaced);
    expect(toHex(await r.board.next())).toBe('000501a10f');
    expect(toHex(await r.board.next())).toBe('00040104');
    r.board.send(new Uint8Array([1, 0x42]));
    expect(toHex(await fresh.next())).toBe('42');
    fresh.send(new Uint8Array([0x43]));
    expect(toHex(await r.board.next())).toBe('0143');
    expect(await r.board.quiet()).toBe(true);
  });

  it("the board's CLOSE closes that phone with its code", async () => {
    const r = await boardRoom();
    for (const [sent, seen] of [
      [1008, 1008],
      [4100, 4100],
      [1234, 1000],
      [1000, 1000],
    ]) {
      const app = await phone(r, 0, 1);
      r.board.send(encodeClose(1, sent));
      expect((await app.closed).code).toBe(seen);
      expect(await r.board.quiet()).toBe(true); // the board is not told back
    }
  });

  it('a phone closing tells the board', async () => {
    const r = await boardRoom();
    await phone(r, 0, 1);
    const app = await phone(r, 1, 2);
    app.ws.close(1001);
    expect(toHex(await r.board.next())).toBe(toHex(encodeClose(2, 1000)));
    await phone(r, 2, 2); // the channel is free again
  });

  it('the board going away closes every phone with 4004 and the time', async () => {
    const r = await boardRoom();
    const apps = [await phone(r, 0, 1), await phone(r, 1, 2)];
    await setClock(r.board.id, 1_800_000_042_000);
    r.board.ws.close(1000);
    for (const app of apps) expect(await app.closed).toEqual({ code: Close.offline, reason: 'offline 1800000042' });
  });

  it("a board replaced by a newer socket closes the old board's phones with 4004", async () => {
    const r = await boardRoom();
    const app = await phone(r, 0, 1);
    const b2 = await fakeBoard({ keyOf: r.board.keys });
    await b2.signIn();
    expect((await r.board.closed).code).toBe(Close.replaced);
    expect((await app.closed).code).toBe(Close.offline);
  });

  it('drops board frames for a channel with no phone', async () => {
    const r = await boardRoom();
    const app = await phone(r, 0, 1);
    r.board.send(new Uint8Array([2, 1, 2, 3]));
    r.board.send(new Uint8Array([3, 1]));
    r.board.send(new Uint8Array([9, 1]));
    r.board.send(new Uint8Array([1, 7]));
    expect(toHex(await app.next())).toBe('07');
    expect(await app.quiet()).toBe(true);
    expect((await attachments(r.board.id, 'board'))[0].authed).toBe(true);
  });

  it('passes 2048 bytes to the board and 2047 to a phone; anything longer closes 4008', async () => {
    const r = await boardRoom();
    const app = await phone(r, 0, 1);
    app.send(bytes(2047));
    expect(toHex(await r.board.next())).toBe(toHex(concat(new Uint8Array([1]), bytes(2047))));
    r.board.send(concat(new Uint8Array([1]), bytes(2047, 0x33)));
    expect(toHex(await app.next())).toBe(toHex(bytes(2047, 0x33)));

    app.send(bytes(2048)); // with the channel byte, 2049 for the board
    expect((await app.closed).code).toBe(Close.policy);
    expect(toHex(await r.board.next())).toBe(toHex(encodeClose(1, Close.policy)));

    r.board.send(bytes(2049));
    expect((await r.board.closed).code).toBe(Close.policy);
  });

  for (const rttMs of [150, 100, 50]) {
    it(`carries a whole firmware update: 16 KB in flight, a report every 4096 bytes, ${rttMs} ms round trip`, async () => {
      const r = await boardRoom();
      const app = await phone(r, 0, 1);
      const t0 = 1_800_000_000_000;
      const sends = updateSends({ rttMs, image: 1_600_000 });
      expect(sends.length).toBe(1600);
      // Headroom: the bucket the relay keeps never runs below half its burst along the way.
      expect(lowestBucket(sends, RATE_PER_S, BURST)).toBeGreaterThanOrEqual(BURST / 2);
      const frame = bytes(1 + 1024, 0x91); // a data chunk's frame, at most the longest frame
      for (let i = 0; i < sends.length; ) {
        let j = i;
        while (j < sends.length && sends[j] === sends[i]) j++;
        await setClock(r.board.id, t0 + Math.round(sends[i]));
        for (let k = i; k < j; k++) app.send(frame);
        for (let k = i; k < j; k++) expect((await r.board.next()).length).toBe(1 + frame.length);
        i = j;
      }
      expect(await app.quiet()).toBe(true);
    });
  }

  it('a phone sending 400 messages a second for 2 s stays; 129 at once is closed 4008', async () => {
    const r = await boardRoom();
    const t = 1_800_000_000_000;
    await setClock(r.board.id, t);
    const steady = await phone(r, 0, 1);
    for (let step = 0; step < 20; step++) {
      await setClock(r.board.id, t + step * 100);
      for (let i = 0; i < 40; i++) steady.send(new Uint8Array([i]));
      for (let i = 0; i < 40; i++) expect(toHex(await r.board.next())).toBe(toHex(new Uint8Array([1, i])));
    }
    expect(await steady.quiet()).toBe(true);

    const burst = await phone(r, 1, 2);
    for (let i = 0; i < 129; i++) burst.send(new Uint8Array([i]));
    expect((await burst.closed).code).toBe(Close.policy);
    for (let i = 0; i < 128; i++) expect(toHex(await r.board.next())).toBe(toHex(new Uint8Array([2, i])));
    expect(toHex(await r.board.next())).toBe(toHex(encodeClose(2, Close.policy)));
    expect(await steady.quiet()).toBe(true);
  });

  it('forwarding and the fourth-phone refusal survive the object losing its memory', async () => {
    const r = await boardRoom();
    const apps = [await phone(r, 0, 1), await phone(r, 1, 2), await phone(r, 2, 3)];
    const forget = () =>
      runInDurableObject(room(r.board.id), (o: BoardRoom) => {
        o.mem = freshMemory();
      });
    for (const [i, app] of apps.entries()) {
      await forget();
      app.send(new Uint8Array([0x10 + i]));
      expect(toHex(await r.board.next())).toBe(toHex(new Uint8Array([i + 1, 0x10 + i])));
      await forget();
      r.board.send(new Uint8Array([i + 1, 0x20 + i]));
      expect(toHex(await app.next())).toBe(toHex(new Uint8Array([0x20 + i])));
    }
    await forget();
    expect((await (await fakeApp(r.board.id, r.tokens[3])).closed).code).toBe(Close.full);
  });

  it('forwarding and the fourth-phone refusal survive hibernation', async () => {
    const r = await boardRoom();
    const apps = [await phone(r, 0, 1), await phone(r, 1, 2), await phone(r, 2, 3)];
    await evictDurableObject(room(r.board.id));
    apps[1].send(new Uint8Array([0x11]));
    expect(toHex(await r.board.next())).toBe('0211');
    await evictDurableObject(room(r.board.id));
    r.board.send(new Uint8Array([3, 0x22]));
    expect(toHex(await apps[2].next())).toBe('22');
    await evictDurableObject(room(r.board.id));
    expect((await (await fakeApp(r.board.id, r.tokens[3])).closed).code).toBe(Close.full);
    await evictDurableObject(room(r.board.id));
    const again = await fakeApp(r.board.id, r.tokens[0]); // a takeover, never "full"
    expect((await apps[0].closed).code).toBe(Close.replaced);
    expect(toHex(await r.board.next())).toBe('000501a10f');
    expect(toHex(await r.board.next())).toBe('00040100');
    expect(await again.quiet()).toBe(true);
  });

  it('ignores board control ops 06, 07 and 08', async () => {
    const r = await boardRoom();
    const app = await phone(r, 0, 1);
    r.board.send(new Uint8Array([0, 6, 3, 1, 0, 4, 1, 2, 3, 4]));
    r.board.send(new Uint8Array([0, 7]));
    r.board.send(new Uint8Array([0, 8, 1, 0]));
    expect(await app.quiet()).toBe(true);
    expect(await r.board.quiet()).toBe(true);
    r.board.send(new Uint8Array([1, 9]));
    expect(toHex(await app.next())).toBe('09');
  });
});

/**
 * When a phone sends each data chunk of a firmware update (ms from the start): it keeps at most
 * `window` bytes unacknowledged, the board reports every `report` bytes it has received (and at the
 * end), and each way takes half the round trip. The board's own processing time is left out, which
 * only makes the phone faster.
 */
function updateSends(o: { rttMs: number; image: number; chunk?: number; window?: number; report?: number }): number[] {
  const { rttMs, image, chunk = 1000, window = 16 * 1024, report = 4096 } = o;
  const oneWay = rttMs / 2;
  const sends: number[] = [];
  const events: Array<{ t: number; kind: 'received' | 'report'; bytes: number }> = [];
  const later = (e: (typeof events)[number]) => {
    events.push(e);
    events.sort((a, b) => a.t - b.t);
  };
  let sent = 0;
  let acked = 0;
  let reported = 0;
  const pump = (t: number) => {
    while (sent < image && sent + chunk - acked <= window) {
      sent += chunk;
      sends.push(t);
      later({ t: t + oneWay, kind: 'received', bytes: sent });
    }
  };
  pump(0);
  for (let e = events.shift(); e; e = events.shift()) {
    if (e.kind === 'received') {
      const r = e.bytes >= image ? e.bytes : Math.floor(e.bytes / report) * report;
      if (r > reported) {
        reported = r;
        later({ t: e.t + oneWay, kind: 'report', bytes: r });
      }
    } else {
      acked = Math.max(acked, e.bytes);
      pump(e.t);
    }
  }
  return sends;
}

/** The fewest tokens a bucket of `rate` a second and `burst` holds over these send times (ms). */
function lowestBucket(sends: number[], rate: number, burst: number): number {
  let tokens = burst;
  let at = 0;
  let low = burst;
  for (const t of sends) {
    tokens = Math.min(burst, tokens + ((t - at) * rate) / 1000);
    at = t;
    tokens -= 1;
    low = Math.min(low, tokens);
  }
  return low;
}
