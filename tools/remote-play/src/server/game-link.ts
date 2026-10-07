// The companion's connection to the game (remote_play.h): it keeps trying
// until the game is up, hands on what the game sends, and replays the
// remote player's state whenever the game comes back.
import { EventEmitter } from "node:events";
import net from "node:net";
import {
  GameMessage,
  MessageReader,
  padMessage,
  presenceMessage,
  rateMessage,
} from "./game-protocol.js";

export interface VideoFrame {
  width: number;
  height: number;
  frame: number;
  // The message payload as the game sent it (header fields included), so
  // it can be passed on without copying.
  payload: Buffer;
}

export interface GameLinkEvents {
  connected: [protocol: number, audioRate: number];
  disconnected: [];
  video: [VideoFrame];
  audio: [Buffer];
}

export class GameLink extends EventEmitter<GameLinkEvents> {
  private socket: net.Socket | null = null;
  private retry: NodeJS.Timeout | null = null;
  private closed = false;
  private ready = false;
  private readonly bits: [number, number] = [0, 0];
  private readonly present: [boolean, boolean] = [false, false];
  private divisor = 2;

  constructor(
    private readonly port: number,
    private readonly host = "127.0.0.1",
    private readonly retryMs = 1000,
  ) {
    super();
  }

  get connected(): boolean {
    return this.ready;
  }

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.socket?.destroy();
    this.socket = null;
  }

  setPad(port: 0 | 1, bits: number): void {
    bits &= 0xffff;
    if (this.bits[port] === bits) return;
    this.bits[port] = bits;
    this.send(padMessage(port, bits));
  }

  setPresence(port: 0 | 1, present: boolean): void {
    this.present[port] = present;
    if (!present) this.bits[port] = 0;
    this.send(presenceMessage(port, present));
  }

  // A picture every `divisor` game frames: 1 is 60 a second, 2 is 30.
  setRate(divisor: number): void {
    this.divisor = divisor;
    this.send(rateMessage(divisor));
  }

  private send(message: Buffer): void {
    if (this.ready && this.socket) this.socket.write(message);
  }

  private connect(): void {
    if (this.closed) return;
    const reader = new MessageReader();
    const socket = net.connect({ port: this.port, host: this.host });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => {
      try {
        for (const message of reader.push(chunk)) this.handle(message.type, message.payload);
      } catch (error) {
        socket.destroy(error as Error);
      }
    });
    socket.on("error", () => {
      /* "close" follows; the game may simply not be running yet */
    });
    socket.on("close", () => {
      if (this.socket === socket) this.socket = null;
      if (this.ready) {
        this.ready = false;
        this.emit("disconnected");
      }
      if (!this.closed) this.retry = setTimeout(() => this.connect(), this.retryMs);
    });
  }

  private handle(type: number, payload: Buffer): void {
    switch (type) {
      case GameMessage.Hello: {
        if (payload.length < 8) return;
        this.ready = true;
        // The game starts every companion afresh: tell it where we are.
        this.send(rateMessage(this.divisor));
        for (const port of [0, 1] as const) {
          if (this.present[port]) this.send(presenceMessage(port, true));
          if (this.bits[port]) this.send(padMessage(port, this.bits[port]));
        }
        this.emit("connected", payload.readUInt32LE(0), payload.readUInt32LE(4));
        break;
      }
      case GameMessage.Video:
        if (payload.length < 8) return;
        this.emit("video", {
          width: payload.readUInt16LE(0),
          height: payload.readUInt16LE(2),
          frame: payload.readUInt32LE(4),
          payload,
        });
        break;
      case GameMessage.Audio:
        this.emit("audio", payload);
        break;
      default:
        break; // a later game's message
    }
  }
}
