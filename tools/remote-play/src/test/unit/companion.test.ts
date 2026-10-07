// The companion against the fake game, with plain WebSocket clients in the
// roles of the two pages.
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { startCompanion, cleanName, type Companion } from "../../server/companion.js";
import { FakeGame, FAKE_HEIGHT, FAKE_WIDTH } from "../../server/fake-game.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
let game: FakeGame;
let companion: Companion;

before(async () => {
  game = new FakeGame();
  const gamePort = await game.listen(0);
  companion = await startCompanion({ gamePort, hostPort: 0, publicPort: 0, lan: false, iceServers: [], root, log: () => {} });
  await once(companion.game, "connected");
});

after(async () => {
  await companion.close();
  await game.close();
});

// Every JSON message a socket got, from the moment it opened: a message
// can arrive in the same packet as the handshake.
const inbox = new WeakMap<WebSocket, Record<string, unknown>[]>();

function open(url: string, origin: string): Promise<WebSocket> {
  const ws = new WebSocket(url, { origin });
  const messages: Record<string, unknown>[] = [];
  inbox.set(ws, messages);
  ws.on("message", (data, isBinary) => {
    if (!isBinary) messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
  });
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

const hostSocket = () => open(`ws://127.0.0.1:${companion.hostPort}/ws/host`, `http://127.0.0.1:${companion.hostPort}`);
const guestSocket = () => open(`ws://127.0.0.1:${companion.publicPort}/ws/guest`, `http://127.0.0.1:${companion.publicPort}`);

// The first JSON message of `type` not taken yet, waiting for it.
function next(ws: WebSocket, type: string, timeoutMs = 3000): Promise<Record<string, unknown>> {
  const messages = inbox.get(ws)!;
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      const index = messages.findIndex((message) => message.type === type);
      if (index >= 0) resolve(messages.splice(index, 1)[0]!);
      else if (Date.now() - start > timeoutMs) reject(new Error(`no ${type} message`));
      else setTimeout(poll, 5);
    };
    poll();
  });
}

function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => (check() ? resolve() : Date.now() - start > timeoutMs ? reject(new Error("timed out")) : setTimeout(poll, 10));
    poll();
  });
}

function get(port: number, pathname: string, host?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .get({ port, host: "127.0.0.1", path: pathname, headers: host ? { host } : {} }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      })
      .on("error", reject);
  });
}

test("pages are served, and nothing else", async () => {
  assert.equal(await get(companion.hostPort, "/"), 200);
  assert.equal(await get(companion.hostPort, "/js/web/host.js"), 200);
  assert.equal(await get(companion.publicPort, "/"), 200);
  assert.equal(await get(companion.publicPort, "/js/shared/pad.js"), 200);
  assert.equal(await get(companion.publicPort, "/js/server/companion.js"), 404);
  assert.equal(await get(companion.publicPort, "/js/web/../server/main.js"), 404);
  assert.equal(await get(companion.publicPort, "/package.json"), 404);
  // DNS rebinding: the host page answers only to this machine's names.
  assert.equal(await get(companion.hostPort, "/", "evil.example:80"), 403);
});

test("the host socket takes this machine's pages only", async () => {
  await assert.rejects(open(`ws://127.0.0.1:${companion.hostPort}/ws/host`, "https://evil.example"));
  await assert.rejects(open(`ws://127.0.0.1:${companion.publicPort}/ws/guest`, "https://evil.example"));
});

test("a guest needs the token and a host", async () => {
  let guest = await guestSocket();
  guest.send(JSON.stringify({ type: "join", token: companion.token, name: "Early" }));
  assert.match(String((await next(guest, "rejected")).reason), /not sharing/);
  guest.close();

  const host = await hostSocket();
  const config = await next(host, "config");
  assert.ok((config.invites as { url: string }[]).some((invite) => invite.url.endsWith(`/#${companion.token}`)));
  guest = await guestSocket();
  guest.send(JSON.stringify({ type: "join", token: "wrong", name: "Mallory" }));
  assert.match(String((await next(guest, "rejected")).reason), /not valid/);
  guest.close();
  host.close();
  await once(host, "close");
});

test("player 2 joins, plays and leaves", async () => {
  const host = await hostSocket();
  await next(host, "config");

  // The game's pictures reach the host page, as kind 2 messages.
  const picture = await new Promise<Buffer>((resolve) =>
    host.on("message", (data: Buffer, isBinary) => isBinary && data[0] === 2 && resolve(data)),
  );
  assert.equal(picture.readUInt16LE(1), FAKE_WIDTH);
  assert.equal(picture.readUInt16LE(3), FAKE_HEIGHT);
  assert.equal(picture.length, 1 + 8 + FAKE_WIDTH * FAKE_HEIGHT * 2);

  const guest = await guestSocket();
  const joinedAtHost = next(host, "guest-joined");
  guest.send(JSON.stringify({ type: "join", token: companion.token, name: "<b>Yugi</b>\u0007" }));
  await next(guest, "joined");
  assert.equal((await joinedAtHost).name, "bYugib");
  await until(() => game.present[1]);

  // A second guest is turned away while the first plays.
  const second = await guestSocket();
  second.send(JSON.stringify({ type: "join", token: companion.token, name: "Kaiba" }));
  assert.match(String((await next(second, "rejected")).reason), /already/);
  second.close();

  // Signalling passes both ways untouched.
  const offer = next(guest, "signal");
  host.send(JSON.stringify({ type: "signal", data: { description: { type: "offer", sdp: "v=0" } } }));
  assert.deepEqual((await offer).data, { description: { type: "offer", sdp: "v=0" } });

  // Input through the WebSocket (relay) and from the host (data channel)
  // lands on port 2 of the game.
  guest.send(JSON.stringify({ type: "pad", bits: 0x4000 }));
  await until(() => game.bits[1] === 0x4000);
  host.send(JSON.stringify({ type: "pad", bits: 0x0018 }));
  await until(() => game.bits[1] === 0x0018);
  assert.equal(game.bits[0], 0);

  // The relay: the host's JPEG pictures go to the guest.
  const relayOn = next(host, "relay");
  guest.send(JSON.stringify({ type: "relay", on: true }));
  assert.equal((await relayOn).on, true);
  const relayed = new Promise<Buffer>((resolve) => guest.on("message", (data: Buffer, isBinary) => isBinary && resolve(data)));
  host.send(Buffer.from([4, 0xff, 0xd8, 0xff]));
  assert.deepEqual([...(await relayed)], [4, 0xff, 0xd8, 0xff]);

  // Leaving lets go of the port.
  const left = next(host, "guest-left");
  guest.close();
  await left;
  await until(() => !game.present[1] && game.bits[1] === 0);
  host.close();
  await once(host, "close");
});

test("the host chooses which player the guest is", async () => {
  const host = await hostSocket();
  assert.equal((await next(host, "config")).guestPort, 1);
  const guest = await guestSocket();
  guest.send(JSON.stringify({ type: "join", token: companion.token, name: "Tea" }));
  assert.equal((await next(guest, "joined")).port, 1);
  await until(() => game.present[1]);
  guest.send(JSON.stringify({ type: "pad", bits: 0x4000 }));
  await until(() => game.bits[1] === 0x4000);

  // Player 1: port 2 is let go, and the guest's pad goes to port 1.
  host.send(JSON.stringify({ type: "guest-port", port: 0 }));
  assert.equal((await next(guest, "player")).port, 0);
  assert.equal((await next(host, "guest-port")).port, 0);
  await until(() => !game.present[1] && game.bits[1] === 0);
  guest.send(JSON.stringify({ type: "pad", bits: 0x0008 }));
  await until(() => game.bits[0] === 0x0008);

  // Leaving lets go of port 1 too; back to player 2 for the next guest.
  guest.close();
  await next(host, "guest-left");
  await until(() => game.bits[0] === 0);
  host.send(JSON.stringify({ type: "guest-port", port: 1 }));
  await next(host, "guest-port");
  host.close();
  await once(host, "close");
});

test("the host can remove player 2", async () => {
  const host = await hostSocket();
  const guest = await guestSocket();
  guest.send(JSON.stringify({ type: "join", token: companion.token, name: "Joey" }));
  await next(guest, "joined");
  const kicked = next(guest, "kicked");
  host.send(JSON.stringify({ type: "kick" }));
  await kicked;
  await until(() => !game.present[1]);
  host.close();
});

test("names are cleaned", () => {
  assert.equal(cleanName("  Téa Gardner  "), "Téa Gardner");
  assert.equal(cleanName("<script>"), "script");
  assert.equal(cleanName(42), "Guest");
  assert.equal(cleanName("x".repeat(100)).length, 24);
});
