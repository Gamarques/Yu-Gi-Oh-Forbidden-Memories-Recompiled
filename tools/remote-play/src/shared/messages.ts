// The pad a guest holds: 1 is player 2, which the game reads only in its
// two-player duels and trades; 0 is player 1, alongside the host's own keys,
// which reaches every screen of the game.
export type GamePort = 0 | 1;

// The duel as the game reports it: whether one is on screen, and the side
// whose turn it is (0 player 1, 1 player 2).
export interface DuelState {
  inDuel: boolean;
  turn: GamePort;
}

// Whether a side has its camera and microphone on.
export interface MediaState {
  camera: boolean;
  mic: boolean;
}

// When a page shows the other side's camera over the opponent's field: in
// a duel during the viewer's own turn (while they prepare their move), in
// a duel always, or never. The game's window takes the same choice.
export type CameraOverlay = "my-turn" | "always" | "never";

import type { ArenaSide } from "./arena.js";

// JSON messages on the two WebSockets. Binary messages on the host socket
// carry the game's own payloads behind a one-byte kind (StreamKind).

// The WebRTC description and candidates, passed through untouched.
export interface SignalData {
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit | null;
}

// --- the host page (private, 127.0.0.1 only) ---
export type ServerToHost =
  | {
      type: "config";
      invites: { label: string; url: string }[];
      iceServers: RTCIceServer[];
      tunnel: "off" | "starting" | "ready" | "failed";
      guestPort: GamePort;
    }
  | { type: "game"; connected: boolean; protocol?: number; audioRate?: number }
  | ({ type: "duel" } & DuelState)
  | ({ type: "peer-media" } & MediaState)
  | { type: "guest-joined"; name: string }
  | { type: "guest-left" }
  | { type: "relay"; on: boolean }
  | { type: "signal"; data: SignalData }
  | { type: "guest-pad"; bits: number }
  | { type: "guest-port"; port: GamePort }
  | ArenaStatus
  | ArenaError;

// Duel Arena (notes/duel-arena.md): both sides' choice, to both pages; a
// refused deck, to the page that sent it.
export type ArenaStatus = { type: "arena"; sides: [ArenaSide, ArenaSide]; available: boolean };
export type ArenaError = { type: "arena-error"; message: string };
// A page's deck for its own side, or null to take it back; `player` is the
// name the duel shows for the host (the guest's is their join name).
export type ArenaChoice = { type: "arena-deck"; name: string; cards: number[] | null; player?: string };

export type HostToServer =
  | { type: "signal"; data: SignalData }
  | { type: "pad"; bits: number } // from the data channel, for the guest's port
  | { type: "rate"; divisor: number }
  | { type: "guest-port"; port: GamePort } // which pad the guest holds
  | ({ type: "media" } & MediaState) // the host's camera and microphone
  | { type: "overlay"; mode: CameraOverlay } // the game window's camera
  | ArenaChoice // player 1's deck
  | { type: "kick" };

export const enum StreamKind {
  Video = 2, // u16 width, u16 height, u32 frame, width*height RGB555
  Audio = 3, // s16 stereo frames
  RelayFrame = 4, // host -> server -> guest: a JPEG picture
  CameraFrame = 5, // host -> server -> game: u16 width, u16 height, RGB555 (the guest's camera)
}

// --- the guest page (public, behind the invite link) ---
export type GuestToServer =
  | { type: "join"; token: string; name: string }
  | { type: "signal"; data: SignalData }
  | { type: "pad"; bits: number } // relay mode, or before the data channel opens
  | { type: "relay"; on: boolean }
  | ({ type: "media" } & MediaState) // the guest's camera and microphone
  | ArenaChoice; // player 2's deck

export type ServerToGuest =
  | { type: "joined"; iceServers: RTCIceServer[]; port: GamePort }
  | { type: "player"; port: GamePort }
  | ({ type: "duel" } & DuelState)
  | ({ type: "peer-media" } & MediaState)
  | { type: "rejected"; reason: string }
  | { type: "signal"; data: SignalData }
  | { type: "host-left" }
  | { type: "kicked" }
  | ArenaStatus
  | ArenaError;

export const GUEST_NAME_MAX = 24;
