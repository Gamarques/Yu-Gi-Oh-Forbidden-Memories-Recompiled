// The guest page: what the friend opens from the invite link. It joins
// with the token after the "#", answers the host's WebRTC offer, shows the
// stream, and sends the pad (keyboard, controllers, on-screen pad) for the
// player the host gave the guest (2 by default). If no
// direct connection comes up in time, or the link has "?relay", it asks for
// the relay: JPEG pictures and pad bits through the WebSocket instead.
import { StreamKind, type GuestToServer, type ServerToGuest, type SignalData } from "../shared/messages.js";
import {
  ChannelMessage,
  decodeChannel,
  describeBits,
  encodePad,
  encodePing,
  gamepadBits,
  INPUT_REPEAT_MS,
  KEYBOARD,
  keyboardBits,
} from "../shared/pad.js";

const CONNECT_TIMEOUT_MS = 12000;
const RELAY_PAD_REPEAT_MS = 1000;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>("video");
const relayView = $<HTMLImageElement>("relay-view");
const token = decodeURIComponent(location.hash.slice(1));
const forceRelay = new URLSearchParams(location.search).has("relay");

let socket: WebSocket | null = null;
let peer: RTCPeerConnection | null = null;
let channel: RTCDataChannel | null = null;
let iceServers: RTCIceServer[] = [];
let relay = false;
let connectTimer: number | null = null;
let relayUrl: string | null = null;
let sequence = 0;
let sentBits = -1;
let sentAt = 0;
const held = new Set<string>();
// On-screen pad: the bit each touching pointer holds.
const touches = new Map<number, number>();

function status(text: string): void {
  $("status").textContent = text;
}

function transport(text: string, state: "on" | "off" | "wait" | "bad"): void {
  const element = $("transport");
  element.textContent = text;
  element.dataset.state = state;
}

const send = (message: GuestToServer) => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify(message));

function showPlayer(port: number): void {
  $("player").textContent = `player ${port + 1}`;
  $("player-hint").textContent =
    port === 1
      ? "You are player 2: the game reads your pad only in its two-player duels and trades. On the title and the other screens, the host plays (or can make you player 1)."
      : "You are player 1, together with the host: your pad works on every screen.";
}

// --- joining ---

function join(event: SubmitEvent): void {
  event.preventDefault();
  if (!token) {
    status("This link has no invite code: ask the host for the whole link.");
    return;
  }
  $<HTMLButtonElement>("join").disabled = true;
  status("Joining...");
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/guest`);
  ws.binaryType = "arraybuffer";
  socket = ws;
  ws.onopen = () => send({ type: "join", token, name: $<HTMLInputElement>("name").value });
  ws.onmessage = (message: MessageEvent<ArrayBuffer | string>) => onMessage(message.data);
  ws.onclose = () => {
    if (socket !== ws) return;
    leave(null);
  };
}

function onMessage(data: ArrayBuffer | string): void {
  if (typeof data !== "string") {
    if (relay && new Uint8Array(data, 0, 1)[0] === StreamKind.RelayFrame) showRelayPicture(data);
    return;
  }
  const message = JSON.parse(data) as ServerToGuest;
  switch (message.type) {
    case "joined":
      iceServers = message.iceServers;
      showPlayer(message.port);
      $("join-form").hidden = true;
      $("play").hidden = false;
      status("Joined. Waiting for the host's picture...");
      transport("Connecting", "wait");
      if (forceRelay) startRelay();
      else connectTimer = window.setTimeout(() => startRelay(), CONNECT_TIMEOUT_MS);
      break;
    case "player":
      showPlayer(message.port);
      break;
    case "rejected":
      status(message.reason);
      $<HTMLButtonElement>("join").disabled = false;
      socket = null;
      break;
    case "signal":
      void onSignal(message.data);
      break;
    case "host-left":
      leave("The host stopped sharing.");
      break;
    case "kicked":
      leave("The host removed you from the game.");
      break;
  }
}

function leave(why: string | null): void {
  const ws = socket;
  socket = null;
  ws?.close();
  if (connectTimer !== null) clearTimeout(connectTimer);
  connectTimer = null;
  channel = null;
  peer?.close();
  peer = null;
  relay = false;
  video.srcObject = null;
  if (relayUrl) URL.revokeObjectURL(relayUrl);
  relayUrl = null;
  $("play").hidden = true;
  $("join-form").hidden = false;
  $<HTMLButtonElement>("join").disabled = false;
  status(why ?? "Disconnected. You can join again.");
}

// --- WebRTC ---

async function onSignal(data: SignalData): Promise<void> {
  try {
    if (data.description?.type === "offer") {
      if (forceRelay) return; // "?relay": the relay only, as when WebRTC cannot connect
      peer?.close();
      const connection = new RTCPeerConnection({ iceServers });
      peer = connection;
      connection.ontrack = (event) => {
        if (video.srcObject !== event.streams[0]) {
          video.srcObject = event.streams[0] ?? null;
          video.muted = false;
          void video.play().catch(() => {
            // Sound needs a click on some browsers: start muted, unmute on click.
            video.muted = true;
            void video.play();
            status("Click the picture to hear the sound.");
          });
        }
      };
      connection.ondatachannel = (event) => {
        channel = event.channel;
        channel.binaryType = "arraybuffer";
        channel.onmessage = (message: MessageEvent<ArrayBuffer>) => onChannel(message.data);
      };
      connection.onicecandidate = (event) => send({ type: "signal", data: { candidate: event.candidate?.toJSON() ?? null } });
      connection.onconnectionstatechange = () => {
        if (peer !== connection) return;
        if (connection.connectionState === "connected") {
          if (connectTimer !== null) clearTimeout(connectTimer);
          connectTimer = null;
          if (relay) stopRelay();
          transport("WebRTC (direct)", "on");
          status(`Playing as ${$("player").textContent}.`);
        } else if (connection.connectionState === "failed") {
          startRelay();
        }
      };
      await connection.setRemoteDescription(data.description);
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      send({ type: "signal", data: { description: connection.localDescription!.toJSON() } });
    } else if (data.candidate && peer) {
      await peer.addIceCandidate(data.candidate);
    }
  } catch (error) {
    console.warn("signal", error);
  }
}

function onChannel(data: ArrayBuffer): void {
  const message = decodeChannel(data);
  if (message?.type === ChannelMessage.Pong) $("rtt").textContent = `${Math.round(performance.now() - message.time)} ms`;
}

// --- the relay ---

function startRelay(): void {
  if (relay || !socket) return;
  relay = true;
  if (connectTimer !== null) clearTimeout(connectTimer);
  connectTimer = null;
  send({ type: "relay", on: true });
  video.hidden = true;
  relayView.hidden = false;
  transport("Relay (no sound)", "wait");
  status("Playing through the relay: no direct connection could be made.");
}

function stopRelay(): void {
  relay = false;
  send({ type: "relay", on: false });
  video.hidden = false;
  relayView.hidden = true;
}

function showRelayPicture(data: ArrayBuffer): void {
  const url = URL.createObjectURL(new Blob([data.slice(1)], { type: "image/jpeg" }));
  const previous = relayUrl;
  relayUrl = url;
  relayView.src = url;
  if (previous) URL.revokeObjectURL(previous);
}

// --- input ---

function currentBits(): number {
  let bits = document.hasFocus() ? keyboardBits(held) : 0;
  for (const bit of touches.values()) bits |= bit;
  for (const pad of navigator.getGamepads?.() ?? []) if (pad?.connected) bits |= gamepadBits(pad);
  return bits;
}

function sendInput(): void {
  if (!socket) return;
  const bits = currentBits();
  const now = performance.now();
  const direct = !relay && channel?.readyState === "open";
  // The data channel loses messages by design: repeat the state often. The
  // WebSocket does not: send changes, and a reminder now and then.
  const repeat = direct ? INPUT_REPEAT_MS : RELAY_PAD_REPEAT_MS;
  if (bits === sentBits && now - sentAt < repeat) return;
  if (direct) channel!.send(encodePad(sequence++ & 0xffff, bits));
  else send({ type: "pad", bits });
  if (bits !== sentBits) $("holding").textContent = describeBits(bits);
  sentBits = bits;
  sentAt = now;
}

function inputLoop(): void {
  sendInput();
  requestAnimationFrame(inputLoop);
}

window.addEventListener("keydown", (event) => {
  if (!socket || !(event.code in KEYBOARD) || event.target instanceof HTMLInputElement) return;
  event.preventDefault();
  held.add(event.code);
  sendInput();
});
window.addEventListener("keyup", (event) => {
  if (!held.delete(event.code)) return;
  event.preventDefault();
  sendInput();
});
window.addEventListener("blur", () => {
  held.clear();
  sendInput();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    held.clear();
    sendInput();
  }
});
// Input keeps flowing when the tab is in the background (animation frames
// stop there).
setInterval(sendInput, 50);
setInterval(() => {
  if (channel?.readyState === "open") channel.send(encodePing(ChannelMessage.Ping, performance.now()));
}, 1000);

function setupTouchPad(): void {
  const pad = $("touch-pad");
  const release = (event: PointerEvent) => {
    const target = event.currentTarget as HTMLElement;
    if (touches.delete(event.pointerId)) target.classList.remove("held");
    sendInput();
  };
  for (const button of pad.querySelectorAll<HTMLButtonElement>("button[data-bit]")) {
    const bit = Number(button.dataset.bit);
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      touches.set(event.pointerId, bit);
      button.classList.add("held");
      sendInput();
    });
    button.addEventListener("pointerup", release);
    button.addEventListener("pointercancel", release);
    button.addEventListener("pointerleave", release);
    button.addEventListener("contextmenu", (event) => event.preventDefault());
  }
  // Shown by itself where the main pointer is a finger.
  pad.hidden = !matchMedia("(pointer: coarse)").matches;
  $<HTMLButtonElement>("touch-toggle").addEventListener("click", () => {
    pad.hidden = !pad.hidden;
  });
}

setupTouchPad();
$<HTMLFormElement>("join-form").addEventListener("submit", join);
$<HTMLButtonElement>("leave").addEventListener("click", () => leave("You left the game."));
$<HTMLButtonElement>("fullscreen").addEventListener("click", () => void $("screen-box").requestFullscreen?.());
video.addEventListener("click", () => {
  video.muted = false;
});
if (!token) status("This link has no invite code: ask the host for the whole link.");
requestAnimationFrame(inputLoop);
