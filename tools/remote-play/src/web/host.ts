// The host page: runs in the player's own browser, on 127.0.0.1. It draws
// the game's pictures (RGB555 at the console's resolution) on a canvas,
// plays the game's sound into an audio node, and sends both to player 2 as
// one WebRTC stream; player 2's pad comes back on a data channel. When no
// direct connection can be made, it sends JPEG pictures through the
// companion instead (the relay).
import { StreamKind, type HostToServer, type ServerToHost, type SignalData } from "../shared/messages.js";
import { ChannelMessage, decodeChannel, describeBits, encodePing, isNewer } from "../shared/pad.js";

const OUT_WIDTH = 640;
const OUT_HEIGHT = 480;
const VIDEO_BITRATE = 3_000_000;
const RELAY_FPS = 15;
const RELAY_QUALITY = 0.7;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const screen = $<HTMLCanvasElement>("screen");
const out = screen.getContext("2d")!;
const native = document.createElement("canvas");
const nativeContext = native.getContext("2d")!;
let image: ImageData | null = null;

let iceServers: RTCIceServer[] = [];
let stream: MediaStream | null = null;
let audioNode: AudioWorkletNode | null = null;
let peer: RTCPeerConnection | null = null;
let channel: RTCDataChannel | null = null;
let guestName: string | null = null;
let relayTimer: number | null = null;
let lastSequence = -1;
let lastBits = 0;
let framesIn = 0;
let lastBytesSent = 0;
let lastStatsAt = 0;

const socket = new WebSocket(`ws://${location.host}/ws/host`);
socket.binaryType = "arraybuffer";
const send = (message: HostToServer) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify(message));

function chip(id: string, text: string, state: "on" | "off" | "wait" | "bad"): void {
  const element = $(id);
  element.textContent = text;
  element.dataset.state = state;
  element.hidden = false;
}

function hint(text: string | null): void {
  const element = $("hint");
  element.textContent = text ?? "";
  element.hidden = !text;
}

// --- pictures and sound from the game ---

function drawPicture(data: ArrayBuffer): void {
  const view = new DataView(data, 1);
  const width = view.getUint16(0, true);
  const height = view.getUint16(2, true);
  const pixels = new Uint16Array(data.slice(1 + 8, 1 + 8 + width * height * 2));
  if (!image || image.width !== width || image.height !== height) {
    native.width = width;
    native.height = height;
    image = nativeContext.createImageData(width, height);
  }
  const rgba = new Uint32Array(image.data.buffer);
  for (let i = 0; i < pixels.length; i++) {
    const pixel = pixels[i]!;
    const r = (pixel & 0x1f) << 3;
    const g = ((pixel >> 5) & 0x1f) << 3;
    const b = ((pixel >> 10) & 0x1f) << 3;
    rgba[i] = 0xff000000 | (b << 16) | (g << 8) | r; // little-endian RGBA
  }
  nativeContext.putImageData(image, 0, 0);
  // Whatever the game's resolution, a 4:3 picture, as on a television,
  // sharp pixels rather than a blur.
  out.imageSmoothingEnabled = false;
  out.drawImage(native, 0, 0, OUT_WIDTH, OUT_HEIGHT);
  framesIn++;
}

function playSound(data: ArrayBuffer): void {
  if (!audioNode) return;
  const pcm = data.slice(1);
  audioNode.port.postMessage(pcm, [pcm]);
}

async function startSharing(): Promise<void> {
  const button = $<HTMLButtonElement>("start");
  button.disabled = true;
  try {
    // The sound goes into the stream only, not to this computer's speakers:
    // the game already plays it here.
    const audio = new AudioContext({ sampleRate: 44100, latencyHint: "interactive" });
    await audio.audioWorklet.addModule("/pcm-worklet.js");
    audioNode = new AudioWorkletNode(audio, "pcm-player", { outputChannelCount: [2] });
    const destination = audio.createMediaStreamDestination();
    audioNode.connect(destination);
    stream = screen.captureStream(60);
    for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);
    button.textContent = "Sharing";
    chip("share-status", "Sharing: on", "on");
    hint(null);
    if (guestName) await connectGuest();
  } catch (error) {
    button.disabled = false;
    chip("share-status", "Sharing: failed", "bad");
    hint(`Could not start: ${(error as Error).message}`);
  }
}

// --- player 2 ---

function closePeer(): void {
  stopRelay();
  channel?.close();
  channel = null;
  peer?.close();
  peer = null;
  lastSequence = -1;
  lastBits = 0;
}

async function connectGuest(): Promise<void> {
  if (!stream) {
    hint(`${guestName} is waiting: press "Start sharing".`);
    return;
  }
  closePeer();
  const connection = new RTCPeerConnection({ iceServers });
  peer = connection;
  for (const track of stream.getTracks()) connection.addTrack(track, stream);
  const input = connection.createDataChannel("input", { ordered: false, maxRetransmits: 0 });
  input.binaryType = "arraybuffer";
  input.onmessage = (event: MessageEvent<ArrayBuffer>) => onChannel(event.data);
  channel = input;
  connection.onicecandidate = (event) => send({ type: "signal", data: { candidate: event.candidate?.toJSON() ?? null } });
  connection.onconnectionstatechange = () => {
    if (peer !== connection) return;
    const state = connection.connectionState;
    if (state === "connected") chip("guest-status", `Friend: ${guestName} (WebRTC)`, "on");
    else if (state === "failed") chip("guest-status", `Friend: ${guestName} (no direct connection)`, "wait");
  };
  const offer = await connection.createOffer();
  await connection.setLocalDescription(offer);
  send({ type: "signal", data: { description: connection.localDescription!.toJSON() } });
  for (const sender of connection.getSenders()) {
    if (sender.track?.kind !== "video") continue;
    const parameters = sender.getParameters();
    if (!parameters.encodings?.length) parameters.encodings = [{}];
    parameters.encodings[0]!.maxBitrate = VIDEO_BITRATE;
    parameters.degradationPreference = "maintain-framerate";
    await sender.setParameters(parameters).catch(() => undefined);
  }
}

async function onSignal(data: SignalData): Promise<void> {
  if (!peer) return;
  try {
    if (data.description) await peer.setRemoteDescription(data.description);
    else if (data.candidate) await peer.addIceCandidate(data.candidate);
  } catch (error) {
    console.warn("signal", error);
  }
}

function showPad(bits: number): void {
  $("stat-pad").textContent = describeBits(bits);
}

function onChannel(data: ArrayBuffer): void {
  const message = decodeChannel(data);
  if (!message) return;
  if (message.type === ChannelMessage.Ping) {
    if (channel?.readyState === "open") channel.send(encodePing(ChannelMessage.Pong, message.time));
    return;
  }
  if (message.type !== ChannelMessage.Pad) return;
  if (lastSequence >= 0 && !isNewer(message.sequence, lastSequence)) return; // late: a newer state came first
  lastSequence = message.sequence;
  if (message.bits !== lastBits) {
    lastBits = message.bits;
    send({ type: "pad", bits: message.bits });
    showPad(message.bits);
  }
}

// The relay: JPEG pictures through the companion, for when WebRTC cannot
// connect (both sides behind strict NATs and no TURN server). No sound.
function startRelay(): void {
  stopRelay();
  let busy = false;
  relayTimer = window.setInterval(() => {
    if (busy || socket.bufferedAmount > 1 << 20) return;
    busy = true;
    screen.toBlob(
      (blob) => {
        busy = false;
        if (!blob) return;
        void blob.arrayBuffer().then((jpeg) => {
          const message = new Uint8Array(1 + jpeg.byteLength);
          message[0] = StreamKind.RelayFrame;
          message.set(new Uint8Array(jpeg), 1);
          socket.send(message);
        });
      },
      "image/jpeg",
      RELAY_QUALITY,
    );
  }, 1000 / RELAY_FPS);
  chip("guest-status", `Friend: ${guestName} (relay)`, "wait");
}

function stopRelay(): void {
  if (relayTimer !== null) clearInterval(relayTimer);
  relayTimer = null;
}

// --- the companion ---

function renderInvites(invites: { label: string; url: string }[]): void {
  const list = $("invites");
  list.replaceChildren(
    ...invites.map(({ label, url }) => {
      const item = document.createElement("li");
      const name = document.createElement("strong");
      name.textContent = label;
      const code = document.createElement("code");
      code.textContent = url;
      const copy = document.createElement("button");
      copy.textContent = "Copy";
      copy.addEventListener("click", () => {
        void navigator.clipboard.writeText(url).then(() => {
          copy.textContent = "Copied";
          setTimeout(() => (copy.textContent = "Copy"), 1500);
        });
      });
      item.append(name, code, copy);
      return item;
    }),
  );
}

socket.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
  if (typeof event.data !== "string") {
    const kind = new Uint8Array(event.data, 0, 1)[0];
    if (kind === StreamKind.Video) drawPicture(event.data);
    else if (kind === StreamKind.Audio) playSound(event.data);
    return;
  }
  const message = JSON.parse(event.data) as ServerToHost;
  switch (message.type) {
    case "config": {
      iceServers = message.iceServers;
      renderInvites(message.invites);
      const tunnel = { off: null, starting: ["Tunnel: starting", "wait"], ready: ["Tunnel: ready", "on"], failed: ["Tunnel: failed", "bad"] } as const;
      const shown = tunnel[message.tunnel];
      if (shown) chip("tunnel-status", shown[0], shown[1]);
      $<HTMLSelectElement>("guest-port").value = String(message.guestPort);
      break;
    }
    case "guest-port":
      $<HTMLSelectElement>("guest-port").value = String(message.port);
      showPad(0);
      break;
    case "game":
      chip("game-status", message.connected ? "Game: connected" : "Game: waiting", message.connected ? "on" : "wait");
      break;
    case "guest-joined":
      guestName = message.name;
      chip("guest-status", `Friend: ${guestName} (connecting)`, "wait");
      $<HTMLButtonElement>("kick").disabled = false;
      void connectGuest();
      break;
    case "guest-left":
      guestName = null;
      closePeer();
      chip("guest-status", "Friend: nobody", "off");
      $<HTMLButtonElement>("kick").disabled = true;
      hint(null);
      showPad(0);
      break;
    case "relay":
      if (message.on) startRelay();
      else stopRelay();
      break;
    case "signal":
      void onSignal(message.data);
      break;
    case "guest-pad":
      showPad(message.bits);
      break;
  }
};
socket.onclose = () => {
  chip("game-status", "Companion stopped", "bad");
  hint("The companion is not running any more: start it again and reload this page.");
};

async function updateStats(): Promise<void> {
  const now = performance.now();
  const seconds = lastStatsAt ? (now - lastStatsAt) / 1000 : 1;
  lastStatsAt = now;
  $("stat-in").textContent = `${Math.round(framesIn / seconds)} pictures/s`;
  framesIn = 0;
  if (!peer || peer.connectionState !== "connected") {
    $("stat-out").textContent = relayTimer !== null ? `relay, ${RELAY_FPS} pictures/s` : "-";
    $("stat-rtt").textContent = "-";
    lastBytesSent = 0;
    return;
  }
  const report = await peer.getStats();
  let bytes = 0;
  let fps = 0;
  let rtt: number | null = null;
  report.forEach((entry: Record<string, unknown>) => {
    if (entry.type === "outbound-rtp" && entry.kind === "video") {
      bytes = Number(entry.bytesSent ?? 0);
      fps = Number(entry.framesPerSecond ?? 0);
    }
    if (entry.type === "candidate-pair" && entry.nominated && typeof entry.currentRoundTripTime === "number") {
      rtt = entry.currentRoundTripTime;
    }
  });
  const kbps = lastBytesSent ? Math.round(((bytes - lastBytesSent) * 8) / 1000 / seconds) : 0;
  lastBytesSent = bytes;
  $("stat-out").textContent = `${fps} pictures/s, ${kbps} kbit/s`;
  $("stat-rtt").textContent = rtt === null ? "-" : `${Math.round(rtt * 1000)} ms`;
}

$<HTMLButtonElement>("start").addEventListener("click", () => void startSharing());
$<HTMLButtonElement>("kick").addEventListener("click", () => send({ type: "kick" }));
$<HTMLSelectElement>("rate").addEventListener("change", (event) =>
  send({ type: "rate", divisor: Number((event.target as HTMLSelectElement).value) }),
);
$<HTMLSelectElement>("guest-port").addEventListener("change", (event) =>
  send({ type: "guest-port", port: (event.target as HTMLSelectElement).value === "0" ? 0 : 1 }),
);
setInterval(() => void updateStats(), 1000);
out.fillStyle = "#000";
out.fillRect(0, 0, OUT_WIDTH, OUT_HEIGHT);
