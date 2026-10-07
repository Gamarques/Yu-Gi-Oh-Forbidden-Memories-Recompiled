// PS1 digital pad bits, active high, exactly as the game reads them
// (src/pc/platform/controls.h). Shared by the server and both pages.
export const Pad = {
  Select: 0x0001,
  L3: 0x0002,
  R3: 0x0004,
  Start: 0x0008,
  Up: 0x0010,
  Right: 0x0020,
  Down: 0x0040,
  Left: 0x0080,
  L2: 0x0100,
  R2: 0x0200,
  L1: 0x0400,
  R1: 0x0800,
  Triangle: 0x1000,
  Circle: 0x2000,
  Cross: 0x4000,
  Square: 0x8000,
} as const;

export type PadButton = keyof typeof Pad;

// The game's own keyboard defaults (build-pc.sh), by KeyboardEvent.code, so
// a guest who knows the PC port finds the same keys.
export const KEYBOARD: Readonly<Record<string, number>> = {
  ArrowUp: Pad.Up,
  ArrowDown: Pad.Down,
  ArrowLeft: Pad.Left,
  ArrowRight: Pad.Right,
  KeyX: Pad.Cross,
  KeyS: Pad.Circle,
  KeyZ: Pad.Square,
  KeyA: Pad.Triangle,
  KeyQ: Pad.L1,
  KeyW: Pad.R1,
  KeyE: Pad.L2,
  KeyR: Pad.R2,
  KeyT: Pad.L3,
  KeyY: Pad.R3,
  Enter: Pad.Start,
  ShiftRight: Pad.Select,
  ShiftLeft: Pad.Select,
};

// The Gamepad API's "standard" layout, button index -> PS1 bit.
export const GAMEPAD_BUTTONS: readonly number[] = [
  Pad.Cross, // 0 A / Cross
  Pad.Circle, // 1 B / Circle
  Pad.Square, // 2 X / Square
  Pad.Triangle, // 3 Y / Triangle
  Pad.L1, // 4
  Pad.R1, // 5
  Pad.L2, // 6
  Pad.R2, // 7
  Pad.Select, // 8 Back / Share
  Pad.Start, // 9 Start / Options
  Pad.L3, // 10
  Pad.R3, // 11
  Pad.Up, // 12
  Pad.Down, // 13
  Pad.Left, // 14
  Pad.Right, // 15
];

export const STICK_THRESHOLD = 0.5;

export interface GamepadLike {
  readonly buttons: ReadonlyArray<{ readonly pressed: boolean }>;
  readonly axes: ReadonlyArray<number>;
}

export function gamepadBits(pad: GamepadLike): number {
  let bits = 0;
  pad.buttons.forEach((button, index) => {
    if (button.pressed && index < GAMEPAD_BUTTONS.length) bits |= GAMEPAD_BUTTONS[index]!;
  });
  const [x = 0, y = 0] = pad.axes;
  if (x <= -STICK_THRESHOLD) bits |= Pad.Left;
  if (x >= STICK_THRESHOLD) bits |= Pad.Right;
  if (y <= -STICK_THRESHOLD) bits |= Pad.Up;
  if (y >= STICK_THRESHOLD) bits |= Pad.Down;
  return bits;
}

export function keyboardBits(held: Iterable<string>): number {
  let bits = 0;
  for (const code of held) bits |= KEYBOARD[code] ?? 0;
  return bits;
}

export function describeBits(bits: number): string {
  const names = (Object.keys(Pad) as PadButton[]).filter((name) => bits & Pad[name]);
  return names.length ? names.join(" + ") : "-";
}

// Input on the WebRTC data channel, which is unordered and never
// retransmits: every message carries the whole pad state and a sequence
// number, so a late message is ignored and a lost one is replaced by the
// next (the guest repeats its state every INPUT_REPEAT_MS).
export const INPUT_REPEAT_MS = 100;
export const enum ChannelMessage {
  Pad = 1,
  Ping = 2,
  Pong = 3,
}

export function encodePad(sequence: number, bits: number): ArrayBuffer {
  const view = new DataView(new ArrayBuffer(5));
  view.setUint8(0, ChannelMessage.Pad);
  view.setUint16(1, sequence & 0xffff, true);
  view.setUint16(3, bits & 0xffff, true);
  return view.buffer;
}

export function encodePing(type: ChannelMessage.Ping | ChannelMessage.Pong, time: number): ArrayBuffer {
  const view = new DataView(new ArrayBuffer(9));
  view.setUint8(0, type);
  view.setFloat64(1, time, true);
  return view.buffer;
}

export type ChannelDecoded =
  | { type: ChannelMessage.Pad; sequence: number; bits: number }
  | { type: ChannelMessage.Ping | ChannelMessage.Pong; time: number }
  | null;

export function decodeChannel(data: ArrayBuffer): ChannelDecoded {
  const view = new DataView(data);
  if (view.byteLength < 1) return null;
  const type = view.getUint8(0);
  if (type === ChannelMessage.Pad && view.byteLength >= 5) {
    return { type, sequence: view.getUint16(1, true), bits: view.getUint16(3, true) };
  }
  if ((type === ChannelMessage.Ping || type === ChannelMessage.Pong) && view.byteLength >= 9) {
    return { type, time: view.getFloat64(1, true) };
  }
  return null;
}

// Whether 16-bit sequence `next` comes after `last`, across the wrap.
export function isNewer(next: number, last: number): boolean {
  const ahead = (next - last) & 0xffff;
  return ahead !== 0 && ahead < 0x8000;
}
