// A stand-in for the game's bridge (remote_play.h), for working on the
// companion and its pages without the game or a disc: the same messages
// on the same port, a moving test picture that shows player 2's buttons, a
// tone while player 2 holds one, and a duel whose turn passes every eight
// seconds (the strip at the top shows whose: blue player 1, red player 2).
// The remote player's camera, which the real game draws in its window, is
// only counted here.
//
//   node dist/server/fake-game.js [--port 47811]
import { EventEmitter } from "node:events";
import net from "node:net";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_GAME_PORT,
  MAX_COMPANION_PAYLOAD,
  encodeMessage,
  GameMessage,
  MessageReader,
  PROTOCOL_VERSION,
} from "./game-protocol.js";

export const FAKE_WIDTH = 320;
export const FAKE_HEIGHT = 240;
const AUDIO_RATE = 44100;
const GAME_HZ = 60;

export interface FakeGameEvents {
  pad: [port: number, bits: number];
  presence: [port: number, present: boolean];
  companion: [connected: boolean];
  camera: [width: number, height: number];
}

const rgb = (r: number, g: number, b: number): number => (r >> 3) | ((g >> 3) << 5) | ((b >> 3) << 10);

export class FakeGame extends EventEmitter<FakeGameEvents> {
  readonly bits: [number, number] = [0, 0];
  readonly present: [boolean, boolean] = [false, false];
  private server: net.Server | null = null;
  private client: net.Socket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private frame = 0;
  private divisor = 2;
  private phase = 0;
  private readonly pixels = new Uint16Array(FAKE_WIDTH * FAKE_HEIGHT);
  // The duel the fake game reports, and what the companion sent for its window.
  inDuel = true;
  turn: 0 | 1 = 0;
  autoTurns = false;
  overlayMode = 1;
  cameraFrames = 0;
  // Duel Arena: the deck each side would be loaded with (arena.h).
  readonly arenaDecks: [number[] | null, number[] | null] = [null, null];
  camera = { width: 0, height: 0 };
  private sentDuel = -1;

  setDuel(inDuel: boolean, turn: 0 | 1): void {
    this.inDuel = inDuel;
    this.turn = turn;
  }

  async listen(port = DEFAULT_GAME_PORT): Promise<number> {
    const server = net.createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    this.timer = setInterval(() => this.tick(), 1000 / GAME_HZ);
    return (server.address() as net.AddressInfo).port;
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.client?.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private accept(socket: net.Socket): void {
    if (this.client) {
      socket.destroy(); // one companion at a time, as the game
      return;
    }
    this.client = socket;
    socket.setNoDelay(true);
    this.divisor = 2;
    this.sentDuel = -1;
    const hello = Buffer.alloc(8);
    hello.writeUInt32LE(PROTOCOL_VERSION, 0);
    hello.writeUInt32LE(AUDIO_RATE, 4);
    socket.write(encodeMessage(GameMessage.Hello, hello));
    this.emit("companion", true);
    const reader = new MessageReader(MAX_COMPANION_PAYLOAD);
    socket.on("data", (chunk: Buffer) => {
      try {
        for (const { type, payload } of reader.push(chunk)) this.handle(type, payload);
      } catch {
        socket.destroy();
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      this.client = null;
      for (const port of [0, 1] as const) {
        this.bits[port] = 0;
        this.present[port] = false;
      }
      this.arenaDecks[0] = this.arenaDecks[1] = null; // as the game: the companion's decks go with it
      this.emit("companion", false);
    });
  }

  private handle(type: number, payload: Buffer): void {
    const port = payload.length >= 1 && payload[0]! < 2 ? (payload[0] as 0 | 1) : -1;
    if (type === GameMessage.Pad && port >= 0 && payload.length >= 4) {
      this.bits[port as 0 | 1] = payload.readUInt16LE(2);
      this.emit("pad", port, this.bits[port as 0 | 1]);
    } else if (type === GameMessage.Presence && port >= 0 && payload.length >= 2) {
      this.present[port as 0 | 1] = payload[1] !== 0;
      if (!payload[1]) this.bits[port as 0 | 1] = 0;
      this.emit("presence", port, this.present[port as 0 | 1]);
    } else if (type === GameMessage.Rate && payload.length >= 1 && payload[0]! >= 1 && payload[0]! <= 60) {
      this.divisor = payload[0]!;
    } else if (type === GameMessage.Camera && payload.length >= 4) {
      const width = payload.readUInt16LE(0);
      const height = payload.readUInt16LE(2);
      if (payload.length !== 4 + width * height * 2) return;
      this.camera = { width, height };
      if (width) this.cameraFrames++;
      this.emit("camera", width, height);
    } else if (type === GameMessage.ArenaDeck && port >= 0 && payload.length >= 2) {
      const count = payload[1]!;
      if (count === 0) this.arenaDecks[port as 0 | 1] = null;
      else if (count === 40 && payload.length >= 2 + 80) {
        this.arenaDecks[port as 0 | 1] = Array.from({ length: 40 }, (_, i) => payload.readUInt16LE(2 + i * 2));
      }
    } else if (type === GameMessage.Overlay && payload.length >= 1) {
      this.overlayMode = payload[0]!;
    }
  }

  private tick(): void {
    this.frame++;
    const client = this.client;
    if (this.autoTurns && this.frame % (GAME_HZ * 8) === 0) this.turn = this.turn ? 0 : 1;
    if (!client || client.writableLength > 4 << 20) return; // as the game: never wait
    const duel = (this.inDuel ? 2 : 0) + this.turn;
    if (duel !== this.sentDuel) {
      this.sentDuel = duel;
      client.write(encodeMessage(GameMessage.Duel, Uint8Array.of(this.inDuel ? 1 : 0, this.turn)));
    }
    client.write(encodeMessage(GameMessage.Audio, this.sound()));
    if (this.frame % this.divisor === 0) client.write(encodeMessage(GameMessage.Video, this.picture()));
  }

  // 1/60 s of sound: a tone while player 2 holds a button, else silence.
  private sound(): Buffer {
    const frames = Math.round(AUDIO_RATE / GAME_HZ);
    const out = Buffer.alloc(frames * 4);
    const held = this.bits[1] !== 0;
    for (let i = 0; i < frames; i++) {
      const sample = held ? Math.round(Math.sin(this.phase) * 6000) : 0;
      this.phase += (2 * Math.PI * 440) / AUDIO_RATE;
      out.writeInt16LE(sample, i * 4);
      out.writeInt16LE(sample, i * 4 + 2);
    }
    this.phase %= 2 * Math.PI;
    return out;
  }

  private picture(): Buffer {
    const { pixels, frame } = this;
    for (let y = 0; y < FAKE_HEIGHT; y++) {
      for (let x = 0; x < FAKE_WIDTH; x++) {
        pixels[y * FAKE_WIDTH + x] = rgb((x + frame) & 0xff, (y * 2) & 0xff, 96);
      }
    }
    // Whose turn: a strip along the top, blue for player 1, red for player 2.
    this.fill(0, 0, FAKE_WIDTH, 6, this.turn ? rgb(220, 40, 40) : rgb(40, 90, 230));
    // A square bouncing across, so motion and frame rate can be seen.
    const span = FAKE_WIDTH - 32;
    const left = Math.abs((frame * 2) % (span * 2) - span);
    this.fill(left, 40, 32, 32, rgb(255, 255, 255));
    // Player 2's sixteen buttons, lit while held; the strip turns green
    // while a remote player holds the port.
    this.fill(0, FAKE_HEIGHT - 44, FAKE_WIDTH, 44, this.present[1] ? rgb(20, 90, 40) : rgb(40, 40, 40));
    for (let bit = 0; bit < 16; bit++) {
      const lit = (this.bits[1] >> bit) & 1;
      this.fill(8 + bit * 19, FAKE_HEIGHT - 34, 15, 24, lit ? rgb(255, 210, 0) : rgb(90, 90, 90));
    }
    const payload = Buffer.alloc(8 + pixels.length * 2);
    payload.writeUInt16LE(FAKE_WIDTH, 0);
    payload.writeUInt16LE(FAKE_HEIGHT, 2);
    payload.writeUInt32LE(frame >>> 0, 4);
    Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength).copy(payload, 8);
    return payload;
  }

  private fill(left: number, top: number, width: number, height: number, colour: number): void {
    for (let y = top; y < top + height; y++) this.pixels.fill(colour, y * FAKE_WIDTH + left, y * FAKE_WIDTH + left + width);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const index = process.argv.indexOf("--port");
  const port = index > 0 ? Number(process.argv[index + 1]) : DEFAULT_GAME_PORT;
  const game = new FakeGame();
  game.autoTurns = true;
  game.on("companion", (on) => console.log(on ? "companion connected" : "companion left"));
  game.on("presence", (p, on) => console.log(`player ${p + 1} ${on ? "joined" : "left"}`));
  game.on("pad", (p, bits) => console.log(`player ${p + 1} pad ${bits.toString(16).padStart(4, "0")}`));
  game
    .listen(port)
    .then((actual) => console.log(`fake game: listening on 127.0.0.1:${actual} (Ctrl+C to stop)`))
    .catch((error: Error) => {
      console.error(`fake game: ${error.message}`);
      process.exit(1);
    });
}
