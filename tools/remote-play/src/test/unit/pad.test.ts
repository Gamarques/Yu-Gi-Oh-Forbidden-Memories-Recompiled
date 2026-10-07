import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ChannelMessage,
  decodeChannel,
  describeBits,
  encodePad,
  encodePing,
  gamepadBits,
  isNewer,
  keyboardBits,
  Pad,
} from "../../shared/pad.js";

test("the keyboard follows the PC port's defaults", () => {
  assert.equal(keyboardBits(["KeyX", "ArrowUp"]), Pad.Cross | Pad.Up);
  assert.equal(keyboardBits(["Enter", "ShiftRight", "KeyQ"]), Pad.Start | Pad.Select | Pad.L1);
  assert.equal(keyboardBits(["KeyP", "Space"]), 0);
});

test("a standard controller maps buttons and the left stick", () => {
  const buttons = Array.from({ length: 17 }, (_, index) => ({ pressed: index === 0 || index === 9 || index === 16 }));
  assert.equal(gamepadBits({ buttons, axes: [0, 0] }), Pad.Cross | Pad.Start);
  const none = Array.from({ length: 17 }, () => ({ pressed: false }));
  assert.equal(gamepadBits({ buttons: none, axes: [-0.9, 0.7] }), Pad.Left | Pad.Down);
  assert.equal(gamepadBits({ buttons: none, axes: [0.3, -0.2] }), 0);
});

test("data channel messages round-trip", () => {
  assert.deepEqual(decodeChannel(encodePad(65535, Pad.Circle)), { type: ChannelMessage.Pad, sequence: 65535, bits: Pad.Circle });
  assert.deepEqual(decodeChannel(encodePing(ChannelMessage.Ping, 1234.5)), { type: ChannelMessage.Ping, time: 1234.5 });
  assert.equal(decodeChannel(new ArrayBuffer(0)), null);
  assert.equal(decodeChannel(Uint8Array.of(1, 2).buffer), null);
  assert.equal(decodeChannel(Uint8Array.of(99, 0, 0, 0, 0).buffer), null);
});

test("sequence numbers compare across the wrap", () => {
  assert.ok(isNewer(1, 0));
  assert.ok(isNewer(0, 65535));
  assert.ok(isNewer(5, 65530));
  assert.ok(!isNewer(65530, 5));
  assert.ok(!isNewer(7, 7));
});

test("bits are described by name", () => {
  assert.equal(describeBits(0), "-");
  assert.equal(describeBits(Pad.Cross | Pad.Up), "Up + Cross");
});
