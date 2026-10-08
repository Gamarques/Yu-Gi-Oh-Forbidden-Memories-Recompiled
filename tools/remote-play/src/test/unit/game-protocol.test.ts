import assert from "node:assert/strict";
import { test } from "node:test";
import {
  arenaDeckMessage,
  cameraMessage,
  encodeMessage,
  GameMessage,
  MessageReader,
  OverlayMode,
  overlayMessage,
  padMessage,
  presenceMessage,
  rateMessage,
} from "../../server/game-protocol.js";

test("messages split across and within chunks", () => {
  const reader = new MessageReader();
  const stream = Buffer.concat([
    encodeMessage(GameMessage.Hello, Buffer.from([1, 0, 0, 0, 0x44, 0xac, 0, 0])),
    encodeMessage(GameMessage.Audio, Buffer.alloc(0)),
    encodeMessage(GameMessage.Video, Buffer.alloc(40, 7)),
  ]);
  const seen = [];
  for (let at = 0; at < stream.length; at += 5) seen.push(...reader.push(stream.subarray(at, at + 5)));
  assert.deepEqual(seen.map((m) => [m.type, m.payload.length]), [[1, 8], [3, 0], [2, 40]]);
  assert.equal(seen[0]!.payload.readUInt32LE(4), 44100);
  assert.ok(seen[2]!.payload.every((byte) => byte === 7));
});

test("an oversized message is refused", () => {
  const reader = new MessageReader(16);
  assert.throws(() => reader.push(encodeMessage(GameMessage.Video, Buffer.alloc(17))));
});

test("the companion's messages match remote_play.h", () => {
  assert.deepEqual([...padMessage(1, 0x4008)], [16, 0, 0, 0, 4, 0, 0, 0, 1, 0, 0x08, 0x40]);
  assert.deepEqual([...presenceMessage(1, true)], [17, 0, 0, 0, 2, 0, 0, 0, 1, 1]);
  assert.deepEqual([...rateMessage(99)], [18, 0, 0, 0, 1, 0, 0, 0, 60]);
  assert.deepEqual([...overlayMessage(OverlayMode.Always)], [20, 0, 0, 0, 1, 0, 0, 0, 2]);
  assert.deepEqual([...cameraMessage(1, 1, Uint8Array.of(0x1f, 0))], [19, 0, 0, 0, 6, 0, 0, 0, 1, 0, 1, 0, 0x1f, 0]);
  assert.deepEqual([...cameraMessage(0, 0, new Uint8Array(0))], [19, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0]);
  assert.throws(() => cameraMessage(321, 1, new Uint8Array(642)));
  assert.throws(() => cameraMessage(2, 2, new Uint8Array(3)));
  const deck = arenaDeckMessage(1, Array.from({ length: 40 }, () => 7), "João!");
  assert.equal(deck.readUInt32LE(4), 2 + 80 + 1 + 5);
  assert.deepEqual([...deck.subarray(8, 12)], [1, 40, 7, 0]);
  assert.equal(deck.subarray(8 + 82).toString("latin1"), "\u0005Joao!");
  assert.deepEqual([...arenaDeckMessage(0, null, "x")], [21, 0, 0, 0, 2, 0, 0, 0, 0, 0]);
});
