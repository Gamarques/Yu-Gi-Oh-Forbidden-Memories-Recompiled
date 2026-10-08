// The companion: two web servers and the link to the game.
//
// * The host side listens on 127.0.0.1 only. It serves the host page, which
//   runs in the player's own browser, turns the game's pictures and sound
//   into a WebRTC stream, and receives player 2's input on a data channel.
// * The guest side is the only thing a friend can reach (directly with
//   --lan, or through the tunnel): the guest page and a WebSocket used for
//   WebRTC signalling, or as a relay when no direct connection can be made.
//   Everything there needs the room token from the invite link.
//
// The game itself is reached on 127.0.0.1 (GameLink), never from outside.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  GUEST_NAME_MAX,
  type CameraOverlay,
  type DuelState,
  type GamePort,
  type MediaState,
  StreamKind,
  type GuestToServer,
  type HostToServer,
  type ServerToGuest,
  type ServerToHost,
} from "../shared/messages.js";
import type { ArenaSide } from "../shared/arena.js";
import { deckProblem, type Arena } from "./cards.js";
import { GameLink } from "./game-link.js";
import { CAMERA_MAX_HEIGHT, CAMERA_MAX_WIDTH, OverlayMode } from "./game-protocol.js";

const OVERLAY_MODES: Record<CameraOverlay, OverlayMode> = {
  never: OverlayMode.Never,
  "my-turn": OverlayMode.MyTurn,
  always: OverlayMode.Always,
};

const mediaState = (message: Partial<MediaState>): MediaState => ({
  camera: message.camera === true,
  mic: message.mic === true,
});

export interface CompanionOptions {
  gamePort: number;
  hostPort: number; // 0: any free port
  publicPort: number;
  lan: boolean; // guest side on every interface, not only 127.0.0.1
  iceServers: RTCIceServer[];
  root: string; // the package directory (public/ and dist/ under it)
  token?: string;
  log?: (line: string) => void;
  arena?: Arena; // Duel Arena's cards and premade decks; none, no arena
}

export interface Companion {
  readonly hostUrl: string;
  readonly hostPort: number;
  readonly publicPort: number;
  readonly token: string;
  readonly game: GameLink;
  invites(): { label: string; url: string }[];
  setTunnel(state: "off" | "starting" | "ready" | "failed", url?: string): void;
  close(): Promise<void>;
}

const HOST_BACKLOG = 4 << 20; // bytes queued to the host page before pictures are dropped
const GUEST_BACKLOG = 1 << 20;
const GUEST_MESSAGES_PER_SECOND = 240;
const JOIN_TIMEOUT_MS = 10000;
const KEEPALIVE_MS = 20000;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; " +
    "media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

interface Guest {
  socket: WebSocket;
  name: string;
  relay: boolean;
  windowStart: number;
  windowCount: number;
}

function sameToken(given: unknown, token: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function cleanDeckName(name: unknown): string {
  const text = typeof name === "string" ? name : "";
  return text.normalize("NFC").replace(/[^\p{L}\p{N} _.'&\-]/gu, "").trim().slice(0, 40) || "Deck";
}

export function cleanName(name: unknown): string {
  const text = typeof name === "string" ? name : "";
  // Letters, digits, spaces and a little punctuation; nothing that could
  // be markup or a control character.
  const cleaned = text.normalize("NFC").replace(/[^\p{L}\p{N} _.\-]/gu, "").trim().slice(0, GUEST_NAME_MAX);
  return cleaned || "Guest";
}

function parse<T>(data: RawData, isBinary: boolean): T | null {
  if (isBinary) return null;
  try {
    const value = JSON.parse(data.toString()) as unknown;
    return value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string" ? (value as T) : null;
  } catch {
    return null;
  }
}

function lanAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((entry): entry is os.NetworkInterfaceInfo => !!entry && entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
}

async function listen(server: http.Server, port: number, host: string): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

export async function startCompanion(options: CompanionOptions): Promise<Companion> {
  const log = options.log ?? ((line: string) => console.log(line));
  const token = options.token ?? randomBytes(18).toString("base64url");
  const game = new GameLink(options.gamePort);
  let host: WebSocket | null = null;
  let guest: Guest | null = null;
  let guestPort: GamePort = 1;
  let duel: DuelState = { inDuel: false, turn: 0 };
  let hostMedia: MediaState = { camera: false, mic: false };
  let guestMedia: MediaState = { camera: false, mic: false };
  let tunnelState: "off" | "starting" | "ready" | "failed" = "off";
  let tunnelUrl: string | undefined;
  let hostPort = 0;
  let publicPort = 0;

  // --- static files ---
  const files = (page: string) => async (request: http.IncomingMessage, response: http.ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    let file: string | null = null;
    if (url.pathname === "/api/arena" && request.method === "GET") {
      // Duel Arena: the cards a deck may hold and the premade decks.
      const body = JSON.stringify(options.arena ? { cards: options.arena.cards, decks: options.arena.decks } : { cards: [], decks: [] });
      response.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8" });
      response.end(body);
      return;
    }
    if (url.pathname === "/") file = path.join(options.root, "public", page);
    else if (/^\/(style\.css|pcm-worklet\.js)$/.test(url.pathname)) file = path.join(options.root, "public", url.pathname);
    else if (/^\/js\/(web|shared)\/[a-z0-9-]+\.js$/.test(url.pathname))
      file = path.join(options.root, "dist", url.pathname.slice("/js/".length));
    if (!file || request.method !== "GET") {
      response.writeHead(404, SECURITY_HEADERS).end("Not found");
      return;
    }
    try {
      const body = await readFile(file);
      response.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404, SECURITY_HEADERS).end("Not found");
    }
  };

  // The host page must come from this machine, by an address of this
  // machine: a Host check stops DNS rebinding, an Origin check stops any
  // other site open in the player's browser from using the socket.
  const localNames = () => [`127.0.0.1:${hostPort}`, `localhost:${hostPort}`];
  const hostServer = http.createServer((request, response) => {
    if (!localNames().includes(request.headers.host ?? "")) {
      response.writeHead(403, SECURITY_HEADERS).end("Forbidden");
      return;
    }
    void files("host.html")(request, response);
  });
  const guestServer = http.createServer((request, response) => void files("guest.html")(request, response));

  const hostSockets = new WebSocketServer({ noServer: true, maxPayload: 4 << 20 });
  const guestSockets = new WebSocketServer({ noServer: true, maxPayload: 64 << 10 });

  hostServer.on("upgrade", (request, socket, head) => {
    const origin = request.headers.origin ?? "";
    const allowed = localNames().map((name) => `http://${name}`);
    if (request.url !== "/ws/host" || !localNames().includes(request.headers.host ?? "") || !allowed.includes(origin)) {
      socket.destroy();
      return;
    }
    hostSockets.handleUpgrade(request, socket, head, (ws) => onHost(ws));
  });
  guestServer.on("upgrade", (request, socket, head) => {
    // Same origin only: the guest page's own address, whatever it is
    // (the tunnel's, or this machine's on the network).
    let originHost = "";
    try {
      originHost = new URL(request.headers.origin ?? "").host;
    } catch {
      /* no or bad origin */
    }
    if (request.url !== "/ws/guest" || !originHost || originHost !== request.headers.host) {
      socket.destroy();
      return;
    }
    guestSockets.handleUpgrade(request, socket, head, (ws) => onGuest(ws));
  });

  const toHost = (message: ServerToHost) => host?.readyState === WebSocket.OPEN && host.send(JSON.stringify(message));
  const toGuest = (message: ServerToGuest) =>
    guest?.socket.readyState === WebSocket.OPEN && guest.socket.send(JSON.stringify(message));

  const invites = (): { label: string; url: string }[] => {
    const list: { label: string; url: string }[] = [];
    if (tunnelUrl) list.push({ label: "Internet (tunnel)", url: `${tunnelUrl}/#${token}` });
    if (options.lan) for (const address of lanAddresses()) list.push({ label: `Local network (${address})`, url: `http://${address}:${publicPort}/#${token}` });
    list.push({ label: "This computer (testing)", url: `http://127.0.0.1:${publicPort}/#${token}` });
    return list;
  };
  const sendConfig = () =>
    toHost({ type: "config", invites: invites(), iceServers: options.iceServers, tunnel: tunnelState, guestPort });

  // A guest holds their port: player 2's counts as a connected pad.
  const holdPort = (port: GamePort, held: boolean) => {
    game.setPad(port, 0);
    if (port === 1) game.setPresence(1, held);
  };

  // --- Duel Arena: each side's deck, sent to the game (arena.h) ---
  const arenaSides: [ArenaSide, ArenaSide] = [
    { ready: false, deckName: "" },
    { ready: false, deckName: "" },
  ];
  const arenaStatus = () => ({ type: "arena" as const, sides: arenaSides, available: !!options.arena && game.supportsArena });
  const sendArena = () => {
    toHost(arenaStatus());
    toGuest(arenaStatus());
  };
  function setArena(side: 0 | 1, name: string, cards: number[] | null): void {
    arenaSides[side] = cards ? { ready: true, deckName: name } : { ready: false, deckName: "" };
    game.setArenaDeck(side, cards);
    sendArena();
    log(cards ? `arena: player ${side + 1} plays "${name}"` : `arena: player ${side + 1} has no deck`);
  }
  // A page's choice for its side; the reply goes to that page only.
  function chooseArena(side: 0 | 1, name: unknown, cards: unknown, reply: (message: string) => void): void {
    if (!options.arena) return reply("Duel Arena is off: the companion found no card catalog.");
    if (cards === null) return setArena(side, "", null);
    const problem = deckProblem(cards, options.arena.byId);
    if (problem) return reply(problem);
    setArena(side, cleanDeckName(name), cards as number[]);
  }

  function leaveGuest(why: string): void {
    if (!guest) return;
    const leaving = guest;
    guest = null;
    holdPort(guestPort, false);
    guestMedia = { camera: false, mic: false };
    game.setCamera(0, 0, new Uint8Array(0));
    if (arenaSides[1].ready) setArena(1, "", null);
    toHost({ type: "guest-left" });
    if (leaving.socket.readyState === WebSocket.OPEN) leaving.socket.close(1000, why);
    log(`the guest (${leaving.name}) left: ${why}`);
  }

  function onHost(ws: WebSocket): void {
    if (host) host.close(4000, "replaced by a newer host page");
    host = ws;
    log("host page connected");
    sendConfig();
    toHost({ type: "game", connected: game.connected });
    toHost({ type: "duel", ...duel });
    toHost(arenaStatus());
    if (guest) {
      toHost({ type: "guest-joined", name: guest.name }); // a reloaded host page renegotiates
      toHost({ type: "peer-media", ...guestMedia });
    }

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        const bytes = data as Buffer;
        if (bytes[0] === StreamKind.RelayFrame && guest?.relay && guest.socket.bufferedAmount < GUEST_BACKLOG) {
          guest.socket.send(bytes);
        } else if (guest && bytes[0] === StreamKind.CameraFrame && bytes.length >= 5) {
          // The guest's camera, as the host page drew it, for the game's window.
          const width = bytes.readUInt16LE(1);
          const height = bytes.readUInt16LE(3);
          if (width <= CAMERA_MAX_WIDTH && height <= CAMERA_MAX_HEIGHT && bytes.length === 5 + width * height * 2) {
            game.setCamera(width, height, bytes.subarray(5));
          }
        }
        return;
      }
      const message = parse<HostToServer>(data, isBinary);
      if (!message) return;
      switch (message.type) {
        case "signal":
          toGuest({ type: "signal", data: message.data });
          break;
        case "pad":
          if (guest && Number.isInteger(message.bits)) game.setPad(guestPort, message.bits);
          break;
        case "guest-port": {
          const port: GamePort = message.port === 0 ? 0 : 1;
          if (port === guestPort) break;
          if (guest) holdPort(guestPort, false);
          guestPort = port;
          if (guest) holdPort(guestPort, true);
          // The arena's player 2 is the guest: as player 1 they have no deck of their own.
          if (port === 0 && arenaSides[1].ready) setArena(1, "", null);
          toHost({ type: "guest-port", port });
          toGuest({ type: "player", port });
          log(`the guest now plays as player ${port + 1}`);
          break;
        }
        case "rate":
          if (Number.isInteger(message.divisor)) game.setRate(message.divisor);
          break;
        case "media":
          hostMedia = mediaState(message);
          toGuest({ type: "peer-media", ...hostMedia });
          break;
        case "overlay":
          if (message.mode in OVERLAY_MODES) game.setOverlay(OVERLAY_MODES[message.mode]);
          break;
        case "arena-deck":
          chooseArena(0, message.name, message.cards, (text) => toHost({ type: "arena-error", message: text }));
          break;
        case "kick":
          if (guest) {
            toGuest({ type: "kicked" });
            leaveGuest("removed by the host");
          }
          break;
      }
    });
    ws.on("close", () => {
      if (host !== ws) return;
      host = null;
      hostMedia = { camera: false, mic: false };
      log("host page closed");
      if (guest) {
        toGuest({ type: "host-left" });
        leaveGuest("the host page closed");
      }
    });
  }

  function onGuest(ws: WebSocket): void {
    let joined: Guest | null = null;
    const timeout = setTimeout(() => ws.close(4001, "no join"), JOIN_TIMEOUT_MS);
    const reject = (reason: string) => {
      ws.send(JSON.stringify({ type: "rejected", reason } satisfies ServerToGuest));
      ws.close(4003, reason);
    };

    ws.on("message", (data, isBinary) => {
      const message = parse<GuestToServer>(data, isBinary);
      if (!message) return;
      if (!joined) {
        if (message.type !== "join") return;
        clearTimeout(timeout);
        if (!sameToken(message.token, token)) return reject("This invite link is not valid (any more).");
        if (!host) return reject("The host is not sharing right now.");
        if (guest) return reject("Someone else is already playing with the host.");
        joined = guest = { socket: ws, name: cleanName(message.name), relay: false, windowStart: Date.now(), windowCount: 0 };
        toGuest({ type: "joined", iceServers: options.iceServers, port: guestPort });
        toGuest({ type: "duel", ...duel });
        toGuest({ type: "peer-media", ...hostMedia });
        toGuest(arenaStatus());
        holdPort(guestPort, true);
        toHost({ type: "guest-joined", name: joined.name });
        log(`the guest (${joined.name}) joined as player ${guestPort + 1}`);
        return;
      }
      if (guest !== joined) return;
      // A simple rate limit: a guest has no reason to send more than this.
      const now = Date.now();
      if (now - joined.windowStart >= 1000) {
        joined.windowStart = now;
        joined.windowCount = 0;
      }
      if (++joined.windowCount > GUEST_MESSAGES_PER_SECOND) return;
      switch (message.type) {
        case "signal":
          toHost({ type: "signal", data: message.data });
          break;
        case "pad":
          if (Number.isInteger(message.bits)) {
            game.setPad(guestPort, message.bits);
            toHost({ type: "guest-pad", bits: message.bits & 0xffff });
          }
          break;
        case "arena-deck":
          if (guestPort !== 1) {
            toGuest({ type: "arena-error", message: "The host made you player 1: the arena's decks are for player 2." });
            break;
          }
          chooseArena(1, message.name, message.cards, (text) => toGuest({ type: "arena-error", message: text }));
          break;
        case "media":
          guestMedia = mediaState(message);
          toHost({ type: "peer-media", ...guestMedia });
          if (!guestMedia.camera) game.setCamera(0, 0, new Uint8Array(0));
          break;
        case "relay":
          joined.relay = message.on === true;
          toHost({ type: "relay", on: joined.relay });
          log(`the guest ${joined.relay ? "switched to" : "left"} the relay`);
          break;
        default:
          break;
      }
    });
    ws.on("close", () => {
      clearTimeout(timeout);
      if (joined && guest === joined) leaveGuest("disconnected");
    });
    ws.on("error", () => ws.terminate());
  }

  // Tunnels drop idle connections; a ping now and then keeps them open.
  const keepalive = setInterval(() => {
    for (const ws of [...hostSockets.clients, ...guestSockets.clients]) if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, KEEPALIVE_MS);

  // --- the game ---
  const forward = (kind: StreamKind, payload: Buffer) => {
    if (!host || host.readyState !== WebSocket.OPEN || host.bufferedAmount > HOST_BACKLOG) return;
    host.send(Buffer.concat([Uint8Array.of(kind), payload]));
  };
  game.on("connected", (protocol, audioRate) => {
    log(`game connected (protocol ${protocol}, sound at ${audioRate} Hz)`);
    toHost({ type: "game", connected: true, protocol, audioRate });
    sendArena();
  });
  game.on("disconnected", () => {
    log("game disconnected; waiting for it");
    toHost({ type: "game", connected: false });
  });
  game.on("duel", (inDuel, turn) => {
    duel = { inDuel, turn };
    toHost({ type: "duel", ...duel });
    toGuest({ type: "duel", ...duel });
  });
  game.on("video", (frame) => forward(StreamKind.Video, frame.payload));
  game.on("audio", (pcm) => forward(StreamKind.Audio, pcm));

  hostPort = await listen(hostServer, options.hostPort, "127.0.0.1");
  publicPort = await listen(guestServer, options.publicPort, options.lan ? "0.0.0.0" : "127.0.0.1");
  game.start();

  return {
    hostUrl: `http://127.0.0.1:${hostPort}/`,
    hostPort,
    publicPort,
    token,
    game,
    invites,
    setTunnel(state, url) {
      tunnelState = state;
      tunnelUrl = state === "ready" ? url : undefined;
      sendConfig();
    },
    async close() {
      clearInterval(keepalive);
      game.stop();
      for (const ws of [...hostSockets.clients, ...guestSockets.clients]) ws.terminate();
      await Promise.all(
        [hostServer, guestServer].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
      );
    },
  };
}
