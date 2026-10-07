// The game's side of the bridge, src/pc/platform/remote_play.h: an 8-byte
// header {u8 type, u8 0, u16 0, u32 payload length}, little-endian, then the
// payload. Keep the two in step.
export const DEFAULT_GAME_PORT = 47811;
export const PROTOCOL_VERSION = 2; // 2: the duel, the remote player's camera
export const CAMERA_MAX_WIDTH = 320;
export const CAMERA_MAX_HEIGHT = 240;
export const HEADER_BYTES = 8;

export const enum GameMessage {
  Hello = 1,
  Video = 2,
  Audio = 3,
  Duel = 4,
  Pad = 16,
  Presence = 17,
  Rate = 18,
  Camera = 19,
  Overlay = 20,
}

// When the game's window shows the remote player's camera (remote_play.h).
export const enum OverlayMode {
  Never = 0,
  MyTurn = 1, // in a duel, during player 1's (the host's) turn
  Always = 2, // in a duel
}

// The largest message the companion sends the game: a camera picture.
export const MAX_COMPANION_PAYLOAD = 4 + CAMERA_MAX_WIDTH * CAMERA_MAX_HEIGHT * 2;

// The largest payload the game can send: a 1024x512 picture.
export const MAX_PAYLOAD = 8 + 1024 * 512 * 2;

export function encodeMessage(type: GameMessage, payload: Uint8Array): Buffer {
  const message = Buffer.alloc(HEADER_BYTES + payload.length);
  message.writeUInt8(type, 0);
  message.writeUInt32LE(payload.length, 4);
  message.set(payload, HEADER_BYTES);
  return message;
}

export function padMessage(port: 0 | 1, bits: number): Buffer {
  const payload = Buffer.alloc(4);
  payload.writeUInt8(port, 0);
  payload.writeUInt16LE(bits & 0xffff, 2);
  return encodeMessage(GameMessage.Pad, payload);
}

export function presenceMessage(port: 0 | 1, present: boolean): Buffer {
  return encodeMessage(GameMessage.Presence, Uint8Array.of(port, present ? 1 : 0));
}

export function rateMessage(divisor: number): Buffer {
  return encodeMessage(GameMessage.Rate, Uint8Array.of(Math.max(1, Math.min(60, Math.round(divisor)))));
}

// A camera picture as 15-bit pixels (red in bits 0-4), or 0x0 for none.
export function cameraMessage(width: number, height: number, pixels: Uint8Array): Buffer {
  if (width > CAMERA_MAX_WIDTH || height > CAMERA_MAX_HEIGHT || pixels.length !== width * height * 2) {
    throw new Error(`camera picture ${width}x${height} (${pixels.length} bytes) does not fit`);
  }
  const payload = Buffer.alloc(4 + pixels.length);
  payload.writeUInt16LE(width, 0);
  payload.writeUInt16LE(height, 2);
  payload.set(pixels, 4);
  return encodeMessage(GameMessage.Camera, payload);
}

export function overlayMessage(mode: OverlayMode): Buffer {
  return encodeMessage(GameMessage.Overlay, Uint8Array.of(mode));
}

export interface ParsedMessage {
  type: number;
  payload: Buffer;
}

// Splits a byte stream into messages; feed it whatever the socket gives.
export class MessageReader {
  private pending: Buffer = Buffer.alloc(0);

  constructor(private readonly maxPayload = MAX_PAYLOAD) {}

  push(chunk: Buffer): ParsedMessage[] {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const messages: ParsedMessage[] = [];
    let offset = 0;
    while (this.pending.length - offset >= HEADER_BYTES) {
      const length = this.pending.readUInt32LE(offset + 4);
      if (length > this.maxPayload) throw new Error(`message of ${length} bytes is too long`);
      if (this.pending.length - offset < HEADER_BYTES + length) break;
      const start = offset + HEADER_BYTES;
      messages.push({ type: this.pending.readUInt8(offset), payload: this.pending.subarray(start, start + length) });
      offset = start + length;
    }
    this.pending = offset ? Buffer.from(this.pending.subarray(offset)) : this.pending;
    return messages;
  }
}
